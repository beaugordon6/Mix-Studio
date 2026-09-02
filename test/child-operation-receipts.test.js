'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertSameChildIdentity,
  beginChildSubmission,
  childIntentHash,
  createChildReceipt,
  markChildAwaitingRecovery,
  planParentCompletion,
  requestChildCancellation,
  transitionChildReceipt,
  validateChildReceipt,
} = require('../lib/child-operation-receipts');

const CHILD_ID = '11111111-2222-4333-8444-555555555555';
const ATTEMPT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function receipt(overrides = {}) {
  return createChildReceipt({
    id: CHILD_ID,
    parentId: 'parent-operation',
    relation: 'post_upscale',
    ordinal: 0,
    profileId: 'owner',
    intent: {
      source: { itemId: 'item-1', sha256: 'a'.repeat(64) },
      options: { profile: 'sharp', resolution: 2160 },
    },
    ...overrides,
  }, { now: 100 });
}

test('intent hashes are deterministic across object key order but preserve array order', () => {
  assert.equal(childIntentHash({ b: 2, a: { d: 4, c: 3 } }), childIntentHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(childIntentHash({ values: [1, 2] }), childIntentHash({ values: [2, 1] }));
  assert.throws(() => receipt({ intent: { omitted: undefined } }), { code: 'child_receipt_intent_invalid' });
  assert.throws(() => receipt({ intent: { lossy: Number.NaN } }), { code: 'child_receipt_intent_invalid' });
});

test('creation stores a canonical UUID, immutable intent hash, and stable prompt ID', () => {
  const value = receipt({ id: CHILD_ID.toUpperCase() });
  assert.equal(value.id, CHILD_ID);
  assert.equal(value.submission.promptId, CHILD_ID);
  assert.equal(value.intentHash, childIntentHash(value.intent));
  assert.equal(value.state, 'planned');
  assert.equal(value.revision, 1);
  assert.deepEqual(validateChildReceipt(JSON.parse(JSON.stringify(value))), value);
});

test('immutable identity rejects intent or ownership changes', () => {
  const value = receipt();
  const changedIntent = structuredClone(value);
  changedIntent.intent.options.resolution = 4096;
  assert.throws(() => validateChildReceipt(changedIntent), { code: 'child_receipt_intent_mismatch' });
  const other = receipt({ profileId: 'other' });
  assert.throws(() => assertSameChildIdentity(value, other), (error) => (
    error.code === 'child_receipt_identity_conflict' && error.mismatches.includes('profileId')
  ));
});

test('submission lifecycle is revisioned and ambiguous acknowledgement waits for recovery', () => {
  let value = transitionChildReceipt(receipt(), 'staging', {}, { expectedRevision: 1, now: 101 });
  value = transitionChildReceipt(value, 'staged', {}, { expectedRevision: 2, now: 102 });
  value = beginChildSubmission(value, { attemptId: ATTEMPT_ID, runtimeFingerprint: 'runtime-1' }, {
    expectedRevision: 3, now: 103,
  });
  assert.equal(value.submission.attempt, 1);
  assert.equal(value.submission.promptId, CHILD_ID);
  assert.equal(value.submission.attemptId, ATTEMPT_ID);
  value = transitionChildReceipt(value, 'submission_unknown', {}, { expectedRevision: 4, now: 104 });
  value = markChildAwaitingRecovery(value, {
    resumeState: 'submission_unknown', reason: 'provider response was lost', retryAt: 200,
  }, { expectedRevision: 5, now: 105 });
  assert.equal(value.state, 'awaiting_recovery');
  assert.equal(value.recovery.resumeState, 'submission_unknown');
  value = transitionChildReceipt(value, 'submitted', {
    submission: { ...value.submission, acknowledgedAt: 106 }, recovery: null,
  }, { expectedRevision: 6, now: 106 });
  assert.equal(value.revision, 7);
  assert.throws(
    () => transitionChildReceipt(value, 'running', {}, { expectedRevision: 6 }),
    { code: 'child_receipt_revision_conflict' },
  );
});

test('output finalization is ordered and terminal receipts cannot transition again', () => {
  let value = receipt();
  for (const state of ['staging', 'staged', 'submitting', 'submitted', 'running', 'output_ready', 'finalizing', 'finalized']) {
    value = transitionChildReceipt(value, state, state === 'finalized' ? { result: { itemIds: ['item-1'] } } : {});
  }
  assert.equal(value.state, 'finalized');
  assert.equal(value.result.itemIds[0], 'item-1');
  assert.throws(() => transitionChildReceipt(value, 'attention'), { code: 'child_receipt_transition_invalid' });
});

test('cancellation persists a tombstone and follows cancel_requested to cancelled', () => {
  let value = transitionChildReceipt(receipt(), 'staging');
  value = requestChildCancellation(value, { reason: 'Parent cancelled' }, { now: 120 });
  assert.equal(value.state, 'cancel_requested');
  assert.deepEqual(value.cancellation, { requestedAt: 120, reason: 'Parent cancelled' });
  assert.deepEqual(requestChildCancellation(value), value);
  value = transitionChildReceipt(value, 'cancelling');
  value = transitionChildReceipt(value, 'cancelled');
  assert.deepEqual(requestChildCancellation(value), value);
});

test('attention can resume only through an explicit revisioned transition', () => {
  let value = transitionChildReceipt(receipt(), 'attention', { error: { code: 'asset_mismatch' } });
  assert.equal(value.error.code, 'asset_mismatch');
  value = transitionChildReceipt(value, 'staging', { error: null }, { expectedRevision: 2 });
  assert.equal(value.state, 'staging');
  assert.equal(value.error, null);
});

test('parent completion waits, propagates attention/failure, and finalizes exactly once', () => {
  const first = receipt();
  const second = receipt({ id: '66666666-7777-4888-8999-aaaaaaaaaaaa', ordinal: 1, relation: 'edit_step' });
  assert.deepEqual(planParentCompletion('parent-operation', [first, second]), {
    action: 'wait', reason: 'required_children_pending', childIds: [first.id, second.id],
  });
  const attention = transitionChildReceipt(first, 'attention');
  assert.equal(planParentCompletion('parent-operation', [attention, second]).action, 'attention');
  const failed = transitionChildReceipt(second, 'failed');
  assert.equal(planParentCompletion('parent-operation', [first, failed]).action, 'fail');

  const finalized = (value) => {
    for (const state of ['staging', 'staged', 'submitting', 'submitted', 'output_ready', 'finalizing', 'finalized']) {
      value = transitionChildReceipt(value, state, state === 'finalized' ? { result: { completed: true } } : {});
    }
    return value;
  };
  assert.deepEqual(planParentCompletion('parent-operation', [finalized(first), finalized(second)]), {
    action: 'finalize', reason: 'all_required_children_finalized', childIds: [],
  });
});

test('parent cancellation waits for active children then settles cancelled', () => {
  const active = receipt();
  const optionalActive = receipt({
    id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    ordinal: 1,
    relation: 'optional_preview',
    required: false,
  });
  const cancelled = transitionChildReceipt(requestChildCancellation(active), 'cancelled');
  assert.deepEqual(planParentCompletion({ id: 'parent-operation', cancelRequested: true }, [active, optionalActive]), {
    action: 'cancel_children', reason: 'parent_cancel_requested', childIds: [active.id, optionalActive.id],
  });
  assert.deepEqual(planParentCompletion({ id: 'parent-operation', cancelRequested: true }, [cancelled]), {
    action: 'cancel', reason: 'children_terminal_after_parent_cancellation', childIds: [],
  });
});

test('parent planning rejects mixed parents and duplicate ordinals', () => {
  assert.throws(
    () => planParentCompletion('another-parent', [receipt()]),
    { code: 'child_receipt_parent_mismatch' },
  );
  assert.throws(
    () => planParentCompletion('parent-operation', [receipt(), receipt({ id: '99999999-aaaa-4bbb-8ccc-dddddddddddd' })]),
    { code: 'child_receipt_duplicate' },
  );
});

test('finalization requires a result receipt and transition patches cannot alter identity', () => {
  let value = receipt();
  for (const state of ['staging', 'staged', 'submitting', 'submitted', 'output_ready', 'finalizing']) {
    value = transitionChildReceipt(value, state);
  }
  assert.throws(() => transitionChildReceipt(value, 'finalized'), { code: 'child_receipt_result_required' });
  assert.throws(
    () => transitionChildReceipt(value, 'finalized', { parentId: 'replacement', result: { completed: true } }),
    { code: 'child_receipt_patch_invalid' },
  );
});
