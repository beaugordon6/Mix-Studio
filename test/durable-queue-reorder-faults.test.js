'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createQueueReorderReceipt,
  planQueueReorder,
  recordQueueReorderSubmitOutcome,
  validateQueueReorderReceipt,
} = require('../lib/durable-queue-reorder');
const { FakeComfy } = require('./support/fake-comfy');

const OPERATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FIRST = '11111111-2222-4333-8444-555555555555';
const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function saveReceipt(file, receipt) {
  validateQueueReorderReceipt(receipt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  try {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch { /* Some filesystems do not support directory fsync. */ }
}

function loadReceipt(file) {
  return validateQueueReorderReceipt(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function inspect(comfy) {
  const [queue, history] = await Promise.all([
    fetch(`${comfy.url}/queue`),
    fetch(`${comfy.url}/history`),
  ]);
  return {
    queue: { ok: queue.ok, value: queue.ok ? await queue.json() : null },
    history: { ok: history.ok, value: history.ok ? await history.json() : null },
  };
}

async function postCancel(comfy, action) {
  const response = await fetch(`${comfy.url}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: action.promptIds }),
  });
  if (!response.ok) throw new Error(`Cancel failed with ${response.status}`);
  await response.json();
}

async function postSubmit(comfy, action) {
  const response = await fetch(`${comfy.url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt_id: action.promptId,
      prompt: { save: { class_type: 'SaveImage', inputs: {} } },
    }),
  });
  if (!response.ok) throw new Error(`Submit failed with ${response.status}`);
  const body = await response.json();
  assert.equal(body.prompt_id, action.promptId);
}

function persistCheckpoint(file, action) {
  assert.equal(action.type, 'checkpoint');
  saveReceipt(file, action.receipt);
  return loadReceipt(file);
}

test('real HTTP reorder recovers dropped cancel and prompt responses with original IDs exactly once', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-reorder-http-'));
  const receiptFile = path.join(root, 'queue-reorder.json');
  const comfy = await new FakeComfy().start();
  t.after(async () => {
    await comfy.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  comfy.enqueue(FIRST);
  comfy.enqueue(SECOND);
  const desiredOrder = [SECOND, FIRST];
  saveReceipt(receiptFile, createQueueReorderReceipt({
    operationId: OPERATION_ID,
    profileId: 'owner',
    order: desiredOrder,
  }, { now: 100 }));

  let receipt = loadReceipt(receiptFile);
  assert.deepEqual(receipt.order, desiredOrder);
  assert.equal(comfy.requests.length, 0, 'the complete desired order is durable before remote I/O');

  receipt = persistCheckpoint(receiptFile, planQueueReorder(receipt, await inspect(comfy), { now: 101 }));
  let action = planQueueReorder(receipt, await inspect(comfy), { now: 102 });
  assert.equal(action.type, 'cancel_pending');
  assert.equal(action.requiresPersistedRevision, receipt.revision);

  comfy.fault('cancel.afterApply', 'drop');
  await assert.rejects(postCancel(comfy, action));
  assert.deepEqual(comfy.snapshot().queue.queue_pending, []);

  // Simulate a process crash: discard every object in memory and reload the
  // pre-request checkpoint. Remote absence is what confirms cancellation.
  receipt = loadReceipt(receiptFile);
  receipt = persistCheckpoint(receiptFile, planQueueReorder(receipt, await inspect(comfy), { now: 103 }));
  assert.deepEqual(receipt.jobs.map((job) => job.cancelState), ['confirmed', 'confirmed']);

  receipt = persistCheckpoint(receiptFile, planQueueReorder(receipt, await inspect(comfy), { now: 104 }));
  action = planQueueReorder(receipt, await inspect(comfy), { now: 105 });
  assert.equal(action.type, 'submit');
  assert.equal(action.promptId, SECOND);
  assert.equal(action.requiresPersistedRevision, receipt.revision);

  comfy.fault('prompt.afterAccept', 'drop');
  await assert.rejects(postSubmit(comfy, action));
  receipt = recordQueueReorderSubmitOutcome(loadReceipt(receiptFile), SECOND, 'ambiguous', { now: 106 });
  saveReceipt(receiptFile, receipt);

  // A second process sees the original ID in the real remote queue and adopts
  // it. It must not retry the request whose response was lost.
  receipt = loadReceipt(receiptFile);
  action = planQueueReorder(receipt, await inspect(comfy), { now: 107 });
  assert.equal(action.reason, 'submission_adopted');
  receipt = persistCheckpoint(receiptFile, action);
  assert.equal(comfy.submissionCount(SECOND), 1);

  receipt = persistCheckpoint(receiptFile, planQueueReorder(receipt, await inspect(comfy), { now: 108 }));
  action = planQueueReorder(receipt, await inspect(comfy), { now: 109 });
  assert.equal(action.type, 'submit');
  assert.equal(action.promptId, FIRST);
  await postSubmit(comfy, action);
  receipt = recordQueueReorderSubmitOutcome(loadReceipt(receiptFile), FIRST, 'acknowledged', { now: 110 });
  saveReceipt(receiptFile, receipt);

  receipt = persistCheckpoint(receiptFile, planQueueReorder(loadReceipt(receiptFile), await inspect(comfy), { now: 111 }));
  action = planQueueReorder(receipt, await inspect(comfy), { now: 112 });
  assert.equal(action.reason, 'reorder_complete');
  receipt = persistCheckpoint(receiptFile, action);

  const recoveredComplete = planQueueReorder(loadReceipt(receiptFile), await inspect(comfy), { now: 113 });
  assert.equal(recoveredComplete.type, 'complete');
  assert.deepEqual(comfy.snapshot().queue.queue_pending.map((entry) => entry[1]), desiredOrder);
  assert.equal(comfy.submissionCount(SECOND), 1);
  assert.equal(comfy.submissionCount(FIRST), 1);
  assert.ok(desiredOrder.every((id) => receipt.order.includes(id)), 'no fresh prompt IDs were introduced');
});
