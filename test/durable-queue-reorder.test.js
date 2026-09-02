'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createQueueReorderReceipt,
  planQueueReorder,
  recordQueueReorderSubmitOutcome,
  validateQueueReorderReceipt,
} = require('../lib/durable-queue-reorder');

const OPERATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FIRST = '11111111-2222-4333-8444-555555555555';
const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function receipt() {
  return createQueueReorderReceipt({
    operationId: OPERATION_ID,
    profileId: 'owner',
    order: [SECOND, FIRST],
  }, { now: 100 });
}

function snapshot({ pending = [], running = [], history = {}, offline = false } = {}) {
  if (offline) return {
    queue: { ok: false, offline: true, code: 'comfy_connection_failed' },
    history: { ok: false, offline: true, code: 'comfy_connection_failed' },
  };
  const entry = (id) => [0, id, {}, {}];
  return {
    queue: { ok: true, value: { queue_running: running.map(entry), queue_pending: pending.map(entry) } },
    history: { ok: true, value: history },
  };
}

function apply(plan) {
  assert.equal(plan.type, 'checkpoint');
  return plan.receipt;
}

test('desired stable-ID order is complete in the initial receipt before any cancel action', () => {
  const initial = receipt();
  assert.deepEqual(initial.order, [SECOND, FIRST]);
  assert.deepEqual(initial.jobs.map((job) => job.promptId), initial.order);
  const firstPlan = planQueueReorder(initial, snapshot({ pending: [FIRST, SECOND] }), { now: 101 });
  assert.equal(firstPlan.type, 'checkpoint');
  assert.deepEqual(firstPlan.receipt.jobs.map((job) => job.cancelState), ['requested', 'requested']);
  const remotePlan = planQueueReorder(firstPlan.receipt, snapshot({ pending: [FIRST, SECOND] }));
  assert.deepEqual(remotePlan, {
    type: 'cancel_pending',
    promptIds: [SECOND, FIRST],
    operationId: OPERATION_ID,
    requiresPersistedRevision: 2,
  });
});

test('crash after remote cancellation recovers from observed absence without cancelling twice', () => {
  let value = apply(planQueueReorder(receipt(), snapshot({ pending: [FIRST, SECOND] })));
  const recovered = planQueueReorder(value, snapshot());
  assert.equal(recovered.type, 'checkpoint');
  assert.deepEqual(recovered.receipt.jobs.map((job) => job.cancelState), ['confirmed', 'confirmed']);
  value = recovered.receipt;
  const next = planQueueReorder(value, snapshot());
  assert.equal(next.type, 'checkpoint');
  assert.equal(next.reason, 'submission_started');
  assert.equal(next.receipt.jobs[0].promptId, SECOND);
});

test('crash after accepted submit is adopted from queue and never receives a fresh prompt ID', () => {
  let value = receipt();
  value = apply(planQueueReorder(value, snapshot()));
  value = apply(planQueueReorder(value, snapshot()));
  assert.equal(value.jobs[0].submitState, 'submitting');
  const adopted = planQueueReorder(value, snapshot({ pending: [SECOND] }));
  assert.equal(adopted.type, 'checkpoint');
  assert.equal(adopted.reason, 'submission_adopted');
  assert.equal(adopted.receipt.jobs[0].submitState, 'adopted');
  assert.deepEqual(adopted.receipt.order, [SECOND, FIRST]);
});

test('ambiguous submit retries only after queue and history both confirm absence, using the same ID', () => {
  let value = receipt();
  value = apply(planQueueReorder(value, snapshot()));
  value = apply(planQueueReorder(value, snapshot()));
  value = recordQueueReorderSubmitOutcome(value, SECOND, 'ambiguous', { now: 103 });
  assert.equal(planQueueReorder(value, snapshot({ offline: true })).type, 'wait');
  const retry = planQueueReorder(value, snapshot());
  assert.equal(retry.type, 'submit');
  assert.equal(retry.promptId, SECOND);
  assert.equal(retry.retry, true);
  assert.equal(retry.promptId, value.order[0]);
});

test('acknowledged jobs advance in desired order and finish only after remote order verification', () => {
  let value = receipt();
  value = apply(planQueueReorder(value, snapshot()));
  value = apply(planQueueReorder(value, snapshot()));
  let action = planQueueReorder(value, snapshot());
  assert.equal(action.type, 'submit');
  assert.equal(action.promptId, SECOND);
  value = recordQueueReorderSubmitOutcome(value, SECOND, 'acknowledged');
  value = apply(planQueueReorder(value, snapshot({ pending: [SECOND] })));
  action = planQueueReorder(value, snapshot({ pending: [SECOND] }));
  assert.equal(action.reason, 'submission_started');
  value = action.receipt;
  action = planQueueReorder(value, snapshot({ pending: [SECOND] }));
  assert.equal(action.type, 'submit');
  assert.equal(action.promptId, FIRST);
  value = recordQueueReorderSubmitOutcome(value, FIRST, 'acknowledged');
  value = apply(planQueueReorder(value, snapshot({ pending: [SECOND, FIRST] })));
  const completeCheckpoint = planQueueReorder(value, snapshot({ pending: [SECOND, FIRST] }));
  assert.equal(completeCheckpoint.reason, 'reorder_complete');
  value = completeCheckpoint.receipt;
  assert.equal(planQueueReorder(value, snapshot({ pending: [SECOND, FIRST] })).type, 'complete');
});

test('wrong remote order fails closed rather than claiming completion', () => {
  let value = receipt();
  value.jobs = value.jobs.map((job) => ({ ...job, cancelState: 'confirmed', submitState: 'adopted' }));
  value.phase = 'requeueing';
  validateQueueReorderReceipt(value);
  const result = planQueueReorder(value, snapshot({ pending: [FIRST, SECOND] }));
  assert.equal(result.type, 'attention');
  assert.equal(result.code, 'queue_reorder_remote_order_mismatch');
});

test('history discovered during cancellation is terminal and is never resubmitted', () => {
  let value = receipt();
  const history = { [SECOND]: { status: { completed: true, status_str: 'success' } } };
  value = apply(planQueueReorder(value, snapshot({ pending: [FIRST], history })));
  assert.equal(value.jobs[0].submitState, 'history');
  assert.equal(value.jobs[0].cancelState, 'confirmed');
  value = apply(planQueueReorder(value, snapshot({ history })));
  const start = planQueueReorder(value, snapshot({ history }));
  assert.equal(start.reason, 'submission_started');
  assert.equal(start.receipt.jobs[1].promptId, FIRST);
});

test('running, duplicate, and conflicting remote states require attention', () => {
  assert.equal(planQueueReorder(receipt(), snapshot({ running: [FIRST] })).code, 'queue_reorder_prompt_running');
  assert.equal(planQueueReorder(receipt(), snapshot({ pending: [FIRST, FIRST] })).code, 'queue_reorder_duplicate_remote_prompt');
  assert.equal(planQueueReorder(receipt(), snapshot({
    pending: [FIRST], history: { [FIRST]: { status: { completed: true } } },
  })).code, 'queue_reorder_remote_state_conflict');
});

test('offline and malformed observations never authorize remote mutation', () => {
  assert.deepEqual(planQueueReorder(receipt(), snapshot({ offline: true })), {
    type: 'wait', code: 'queue_reorder_inspection_offline', retryable: true,
  });
  assert.equal(planQueueReorder(receipt(), {
    queue: { ok: true, value: { queue_pending: 'bad', queue_running: [] } },
    history: { ok: true, value: {} },
  }).type, 'wait');
});

test('ownership, stable IDs, duplicates, and immutable job mapping are validated', () => {
  assert.throws(() => createQueueReorderReceipt({ operationId: OPERATION_ID, order: [FIRST] }), {
    code: 'queue_reorder_profile_required',
  });
  assert.throws(() => createQueueReorderReceipt({
    operationId: OPERATION_ID, profileId: 'owner', order: [FIRST, FIRST],
  }), { code: 'queue_reorder_order_duplicate' });
  const changed = receipt();
  changed.jobs[0].profileId = 'other';
  assert.throws(() => validateQueueReorderReceipt(changed), { code: 'queue_reorder_receipt_invalid' });
});
