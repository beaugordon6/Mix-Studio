'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { durableCancellationDecision } = require('../lib/durable-cancellation');
const {
  createQueueReorderReceipt,
  planQueueReorder,
  recordQueueReorderSubmitOutcome,
  validateQueueReorderReceipt,
} = require('../lib/durable-queue-reorder');
const { createJobJournal } = require('../lib/job-journal');
const { FakeComfy } = require('./support/fake-comfy');

const RUNS = 50;

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    },
    int(max) {
      return Math.floor(this.next() * max);
    },
    shuffle(values) {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const selected = this.int(index + 1);
        [result[index], result[selected]] = [result[selected], result[index]];
      }
      return result;
    },
  };
}

function stableUuid(...parts) {
  const bytes = crypto.createHash('sha256').update(parts.join(':')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function atomicReceipt(file, receipt) {
  validateQueueReorderReceipt(receipt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}

function readReceipt(file) {
  return validateQueueReorderReceipt(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function durableJob(id, profileId, index) {
  return {
    kind: 'gen',
    operationId: id,
    promptId: id,
    profileId,
    params: { prompt: `fixture-${profileId}-${index}`, seed: index },
    graph: { save: { class_type: 'SaveImage', inputs: { filename_prefix: `${profileId}/${index}` } } },
    submissionState: 'submitted',
    enqueuedAt: index + 1,
  };
}

async function inspect(comfy, fault) {
  if (fault) comfy.fault(`${fault.target}.beforeResponse`, fault.type === 'http'
    ? { type: 'http', status: 503, body: { error: 'deterministic outage' } }
    : 'drop');
  const get = async (route) => {
    try {
      const response = await fetch(`${comfy.url}/${route}`);
      return response.ok
        ? { ok: true, value: await response.json() }
        : { ok: false, offline: false, status: response.status };
    } catch {
      return { ok: false, offline: true };
    }
  };
  const [queue, history] = await Promise.all([get('queue'), get('history')]);
  return { queue, history };
}

function observedPromptState(snapshot, promptId) {
  if (snapshot.queue.ok !== true || snapshot.history.ok !== true) return 'offline';
  const running = snapshot.queue.value.queue_running.some((entry) => entry[1] === promptId);
  const pending = snapshot.queue.value.queue_pending.some((entry) => entry[1] === promptId);
  if (running) return 'running';
  if (pending) return 'queued';
  if (Object.prototype.hasOwnProperty.call(snapshot.history.value, promptId)) return 'completed';
  return 'absent';
}

async function postJson(comfy, route, body) {
  const response = await fetch(`${comfy.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fake Comfy ${route} returned ${response.status}`);
  return response.json();
}

function applyCancellationTransitions(journalFile, promptId, transitions) {
  for (const state of transitions) {
    const journal = createJobJournal(journalFile);
    const job = new Map(journal.entries()).get(promptId);
    assert.ok(job, `cancelled job ${promptId} remains durable until terminal reconciliation`);
    journal.put(promptId, { ...job, submissionState: state });
  }
}

async function cancelDurably(options) {
  const { comfy, journalFile, promptId, inspectionFault, actionFault, coverage } = options;
  let nextInspectionFault = inspectionFault;
  let nextActionFault = actionFault;
  for (let transition = 0; transition < 12; transition += 1) {
    const journal = createJobJournal(journalFile);
    const job = new Map(journal.entries()).get(promptId);
    assert.ok(job, 'the cancellation tombstone must survive every simulated process restart');
    const snapshot = await inspect(comfy, nextInspectionFault);
    if (nextInspectionFault) {
      coverage[`${nextInspectionFault.target}_${nextInspectionFault.type}`] += 1;
      nextInspectionFault = null;
    }
    const observed = observedPromptState(snapshot, promptId);
    const decision = durableCancellationDecision({
      id: job.operationId,
      state: job.submissionState,
      submission: { comfyPromptId: job.promptId },
      cancellation: { requestedAt: job.cancelRequestedAt, reason: job.cancelMessage },
    }, observed);
    applyCancellationTransitions(journalFile, promptId, decision.transitions);
    if (decision.terminal) {
      createJobJournal(journalFile).remove(promptId);
      return;
    }
    for (const action of decision.actions) {
      if (action.type === 'wait_for_reconnect') continue;
      if (nextActionFault) {
        comfy.fault(`cancel.${nextActionFault === 'before' ? 'beforeApply' : 'afterApply'}`, 'drop');
        coverage[`cancel_${nextActionFault}`] += 1;
        nextActionFault = null;
      }
      try {
        await postJson(comfy, '/queue', { delete: [action.promptId] });
      } catch { /* exact-prompt reconciliation determines whether it applied */ }
    }
  }
  assert.fail(`cancellation of ${promptId} did not converge`);
}

async function runReorder(options) {
  const {
    comfy, receiptFile, ownerIds, inspectionFaults, promptFaults, restartAt, coverage,
  } = options;
  let transitions = 0;
  let restartPending = true;
  for (let guard = 0; guard < 160; guard += 1) {
    const fault = inspectionFaults.shift() || null;
    const snapshot = await inspect(comfy, fault);
    if (fault) coverage[`${fault.target}_${fault.type}`] += 1;
    const receipt = readReceipt(receiptFile);
    const action = planQueueReorder(receipt, snapshot, { now: 10_000 + guard });
    if (action.type === 'wait') continue;
    assert.notEqual(action.type, 'attention', `run entered attention: ${action.code}`);
    if (action.type === 'complete') return;
    if (action.type === 'checkpoint') {
      atomicReceipt(receiptFile, action.receipt);
      transitions += 1;
    } else if (action.type === 'cancel_pending') {
      try { await postJson(comfy, '/queue', { delete: action.promptIds }); } catch { /* reconcile */ }
      transitions += 1;
    } else if (action.type === 'submit') {
      const faultType = promptFaults.get(action.promptId);
      if (faultType) {
        comfy.fault(`prompt.${faultType === 'before' ? 'beforeAccept' : 'afterAccept'}`, 'drop');
        coverage[`prompt_${faultType}`] += 1;
        promptFaults.delete(action.promptId);
      }
      let outcome = 'acknowledged';
      try {
        const response = await postJson(comfy, '/prompt', {
          prompt_id: action.promptId,
          prompt: { save: { class_type: 'SaveImage', inputs: {} } },
          extra_data: { profileId: 'owner', durableOperationId: action.promptId },
        });
        assert.equal(response.prompt_id, action.promptId);
      } catch {
        outcome = 'ambiguous';
      }
      atomicReceipt(receiptFile, recordQueueReorderSubmitOutcome(
        readReceipt(receiptFile), action.promptId, outcome, { now: 20_000 + guard },
      ));
      transitions += 1;
    } else {
      assert.fail(`unexpected reorder action ${action.type}`);
    }

    // Closing and reopening the same fake preserves its remote queue while
    // changing ports. Reloading the receipt above represents losing all Mix
    // process memory at the same boundary.
    if (restartPending && transitions >= restartAt) {
      await comfy.close();
      await comfy.start();
      restartPending = false;
      coverage.port_restarts += 1;
    }
  }
  assert.fail(`reorder did not converge for ${ownerIds.join(', ')}`);
}

test('50 deterministic randomized fake-Comfy outage runs preserve jobs, order, cancellation, and profiles', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-randomized-outages-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const coverage = {
    queue_drop: 0,
    queue_http: 0,
    history_drop: 0,
    history_http: 0,
    cancel_before: 0,
    cancel_after: 0,
    prompt_before: 0,
    prompt_after: 0,
    port_restarts: 0,
  };

  for (let run = 0; run < RUNS; run += 1) {
    const random = seededRandom(0x4d495800 ^ ((run + 1) * 0x9e3779b1));
    const runRoot = path.join(root, String(run).padStart(2, '0'));
    const journalFile = path.join(runRoot, 'jobs.json');
    const receiptFile = path.join(runRoot, 'reorder.json');
    const comfy = await new FakeComfy().start();
    try {
      const ownerIds = Array.from({ length: 5 }, (_, index) => stableUuid('owner', run, index));
      const foreignIds = Array.from({ length: 2 }, (_, index) => stableUuid('foreign', run, index));
      const cancelledId = ownerIds[random.int(ownerIds.length)];
      const activeOwnerIds = ownerIds.filter((id) => id !== cancelledId);
      const desiredOrder = random.shuffle(activeOwnerIds);
      const initialRemoteOrder = random.shuffle([...ownerIds, ...foreignIds]);
      for (const id of initialRemoteOrder) {
        const profileId = foreignIds.includes(id) ? 'other-profile' : 'owner';
        comfy.enqueue(id, { prompt: { id }, extraData: { profileId } });
      }

      const journal = createJobJournal(journalFile);
      ownerIds.forEach((id, index) => journal.put(id, durableJob(id, 'owner', index)));
      foreignIds.forEach((id, index) => journal.put(id, durableJob(id, 'other-profile', index)));
      const foreignBefore = foreignIds.map((id) => structuredClone(new Map(
        createJobJournal(journalFile).entries(),
      ).get(id)));

      const cancellationJournal = createJobJournal(journalFile);
      const cancelledJob = new Map(cancellationJournal.entries()).get(cancelledId);
      cancellationJournal.put(cancelledId, {
        ...cancelledJob,
        cancelRequested: true,
        cancelRequestedAt: run + 1,
        cancelMessage: 'randomized matrix cancellation',
        submissionState: 'cancel_requested',
      });
      const inspectionFault = run % 4 === 0
        ? { target: run % 8 === 0 ? 'queue' : 'history', type: run % 3 === 0 ? 'http' : 'drop' }
        : null;
      const cancellationFault = ['before', 'after', null][random.int(3)];
      await cancelDurably({
        comfy,
        journalFile,
        promptId: cancelledId,
        inspectionFault,
        actionFault: cancellationFault,
        coverage,
      });

      atomicReceipt(receiptFile, createQueueReorderReceipt({
        operationId: stableUuid('reorder', run),
        profileId: 'owner',
        order: desiredOrder,
      }, { now: run + 1 }));
      const inspectionFaults = Array.from({ length: 1 + random.int(4) }, (_, index) => ({
        target: (run + index) % 2 ? 'queue' : 'history',
        type: (run + index) % 3 ? 'drop' : 'http',
      }));
      const promptFaults = new Map();
      for (const id of activeOwnerIds) {
        const selected = ['before', 'after', null][random.int(3)];
        if (selected) promptFaults.set(id, selected);
      }
      await runReorder({
        comfy,
        receiptFile,
        ownerIds: activeOwnerIds,
        inspectionFaults,
        promptFaults,
        restartAt: 1 + random.int(8),
        coverage,
      });

      const snapshot = comfy.snapshot();
      const remoteIds = snapshot.queue.queue_pending.map((entry) => entry[1]);
      assert.equal(new Set(remoteIds).size, remoteIds.length, `run ${run}: no remote duplicate IDs`);
      assert.deepEqual(remoteIds.filter((id) => activeOwnerIds.includes(id)), desiredOrder,
        `run ${run}: owner order is preserved`);
      assert.deepEqual(remoteIds.filter((id) => foreignIds.includes(id)),
        initialRemoteOrder.filter((id) => foreignIds.includes(id)),
        `run ${run}: foreign-profile queue order and membership are untouched`);
      assert.equal(remoteIds.includes(cancelledId), false, `run ${run}: cancelled job stays cancelled`);
      assert.equal(comfy.submissionCount(cancelledId), 0, `run ${run}: cancellation prevents resubmission`);
      for (const id of activeOwnerIds) {
        assert.equal(comfy.submissionCount(id), 1, `run ${run}: ${id} is accepted exactly once`);
      }
      for (const id of foreignIds) {
        assert.equal(comfy.submissionCount(id), 0, `run ${run}: foreign job ${id} is never submitted`);
      }
      assert.ok(snapshot.submissions.every(({ body }) => body.extra_data?.profileId === 'owner'),
        `run ${run}: every submission remains in the owning profile`);

      const recoveredJobs = new Map(createJobJournal(journalFile).entries());
      assert.equal(recoveredJobs.has(cancelledId), false, `run ${run}: terminal cancellation is removed intentionally`);
      for (const id of activeOwnerIds) {
        assert.equal(recoveredJobs.get(id)?.profileId, 'owner', `run ${run}: owner job survives restart`);
      }
      foreignIds.forEach((id, index) => {
        assert.deepEqual(recoveredJobs.get(id), foreignBefore[index],
          `run ${run}: foreign durable record ${id} is byte-for-byte unchanged`);
      });
    } finally {
      await comfy.close();
    }
  }

  assert.equal(RUNS, 50);
  for (const [fault, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `the deterministic matrix must exercise ${fault}`);
  }
});
