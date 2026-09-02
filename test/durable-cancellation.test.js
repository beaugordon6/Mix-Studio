'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROMPT_STATES,
  durableCancellationDecision,
  hasCancellationTombstone,
  promptIdFor,
} = require('../lib/durable-cancellation');

const ID = '11111111-1111-4111-8111-111111111111';
const PROMPT_ID = '22222222-2222-4222-8222-222222222222';

function operation(overrides = {}) {
  return {
    id: ID,
    state: 'cancel_requested',
    submission: { comfyPromptId: PROMPT_ID },
    cancellation: { requestedAt: 100, reason: 'No longer needed' },
    ...overrides,
  };
}

test('queued cancellation requests a targeted delete and stays durable until reconciled', () => {
  const decision = durableCancellationDecision(operation(), 'queued');
  assert.deepEqual(decision.transitions, ['cancelling']);
  assert.deepEqual(decision.actions, [{ type: 'delete_queued_prompt', promptId: PROMPT_ID }]);
  assert.equal(decision.retry, true);
  assert.equal(decision.terminal, false);
  assert.equal(decision.suppressFinalization, true);
});

test('running cancellation requests a targeted interrupt rather than a global interrupt', () => {
  const decision = durableCancellationDecision(operation(), { state: 'running' });
  assert.deepEqual(decision.actions, [{ type: 'interrupt_running_prompt', promptId: PROMPT_ID }]);
  assert.deepEqual(decision.transitions, ['cancelling']);
  assert.equal(decision.reason, 'cancelling_running_prompt');
});

test('completed after cancellation becomes cancelled and can never be finalized', () => {
  const decision = durableCancellationDecision(operation(), 'completed');
  assert.deepEqual(decision.transitions, ['cancelled']);
  assert.deepEqual(decision.actions, []);
  assert.equal(decision.terminal, true);
  assert.equal(decision.retry, false);
  assert.equal(decision.suppressFinalization, true);
  assert.equal(decision.reason, 'completed_after_cancellation_discarded');
});

test('an absent cancelled prompt becomes terminal without an external call', () => {
  const decision = durableCancellationDecision(operation({ state: 'cancelling' }), 'absent');
  assert.deepEqual(decision.transitions, ['cancelled']);
  assert.deepEqual(decision.actions, []);
  assert.equal(decision.reason, 'cancelled_prompt_absent');
});

test('offline cancellation retains its tombstone and asks for reconnect retry', () => {
  const input = operation();
  const before = structuredClone(input);
  const decision = durableCancellationDecision(input, 'offline');
  assert.deepEqual(decision.transitions, []);
  assert.deepEqual(decision.actions, [{ type: 'wait_for_reconnect' }]);
  assert.equal(decision.retry, true);
  assert.equal(decision.terminal, false);
  assert.equal(decision.suppressFinalization, true);
  assert.deepEqual(input, before, 'the pure coordinator never mutates durable state');
});

test('the tombstone wins even when a crash left the lifecycle in its pre-cancel state', () => {
  const stale = operation({ state: 'submitted' });
  assert.deepEqual(durableCancellationDecision(stale, 'queued').transitions, ['cancel_requested', 'cancelling']);
  assert.deepEqual(durableCancellationDecision(stale, 'completed').transitions, ['cancel_requested', 'cancelled']);
  assert.equal(durableCancellationDecision(stale, 'completed').suppressFinalization, true);
  assert.deepEqual(durableCancellationDecision(stale, 'offline').transitions, ['cancel_requested']);
});

test('already-cancelled decisions are idempotent despite stale provider observations', () => {
  for (const observed of PROMPT_STATES) {
    const decision = durableCancellationDecision(operation({ state: 'cancelled' }), observed);
    assert.equal(decision.handled, true);
    assert.equal(decision.terminal, true);
    assert.equal(decision.suppressFinalization, true);
    assert.deepEqual(decision.transitions, []);
    assert.deepEqual(decision.actions, []);
  }
});

test('normal reconciliation is untouched when no cancellation tombstone exists', () => {
  const input = operation({ state: 'submitted', cancellation: null });
  assert.equal(hasCancellationTombstone(input), false);
  const decision = durableCancellationDecision(input, 'completed');
  assert.equal(decision.handled, false);
  assert.equal(decision.suppressFinalization, false);
  assert.deepEqual(decision.transitions, []);
  assert.deepEqual(decision.actions, []);
});

test('stable prompt correlation prefers the submitted prompt and falls back to operation ID', () => {
  assert.equal(promptIdFor(operation()), PROMPT_ID);
  assert.equal(promptIdFor(operation({ submission: null })), ID);
  const queued = durableCancellationDecision(operation({ submission: null }), 'queued');
  assert.equal(queued.actions[0].promptId, ID);
});

test('unknown observations and terminal conflicts fail closed', () => {
  assert.throws(() => durableCancellationDecision(operation(), 'maybe'), {
    code: 'prompt_state_invalid',
  });
  assert.throws(() => durableCancellationDecision(operation({ state: 'finalized' }), 'completed'), {
    code: 'cancellation_terminal_conflict',
  });
  assert.throws(() => durableCancellationDecision(operation({ id: '', submission: null }), 'offline'), {
    code: 'operation_id_required',
  });
});
