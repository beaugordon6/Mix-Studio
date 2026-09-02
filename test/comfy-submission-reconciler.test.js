'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideComfySubmission } = require('../lib/comfy-submission-reconciler');

const promptId = '4ecfc3f0-ea78-4e8e-b1e4-7fbf13e24a74';
const ok = (value) => ({ ok: true, value });
const emptyQueue = () => ok({ queue_running: [], queue_pending: [] });
const emptyHistory = () => ok({});
const queueEntry = (id) => [1, id, {}, {}, []];

function decide(overrides = {}) {
  return decideComfySubmission(Object.assign({
    promptId,
    localState: 'prepared',
    queue: emptyQueue(),
    history: emptyHistory(),
  }, overrides));
}

test('submission is allowed only after queue and history both confirm absence', () => {
  assert.deepEqual(decide(), {
    state: 'submit', code: 'confirmed_absent', promptId,
    safeToSubmit: true, retryable: false, remoteState: 'absent',
  });
  assert.equal(decide({ queue: undefined }).safeToSubmit, false);
  assert.equal(decide({ history: undefined }).safeToSubmit, false);
});

test('a running or pending queue record is adopted and never submitted again', () => {
  const running = decide({ queue: ok({ queue_running: [queueEntry(promptId)], queue_pending: [] }) });
  assert.equal(running.state, 'adopt');
  assert.equal(running.code, 'already_running');
  assert.equal(running.safeToSubmit, false);
  assert.equal(running.remoteState, 'running');

  const pending = decide({ queue: ok({ queue_running: [], queue_pending: [queueEntry(promptId)] }) });
  assert.equal(pending.state, 'adopt');
  assert.equal(pending.code, 'already_pending');
  assert.equal(pending.safeToSubmit, false);
});

test('completed history is finalized while failed and interrupted history are terminal', () => {
  const completedEntry = { status: { completed: true, status_str: 'success' }, outputs: { save: {} } };
  const completed = decide({ history: ok({ [promptId]: completedEntry }) });
  assert.equal(completed.state, 'finalize');
  assert.equal(completed.code, 'already_completed');
  assert.equal(completed.historyEntry, completedEntry);

  const failed = decide({ history: ok({ [promptId]: { status: { completed: false, status_str: 'error' } } }) });
  assert.equal(failed.state, 'terminal');
  assert.equal(failed.code, 'remote_failed');

  const interrupted = decide({ history: ok({
    [promptId]: { status: { completed: false, status_str: 'error', messages: [['execution_interrupted', {}]] } },
  }) });
  assert.equal(interrupted.state, 'terminal');
  assert.equal(interrupted.code, 'remote_cancelled');
});

test('an unclassified history record waits instead of risking a duplicate POST', () => {
  const decision = decide({ history: ok({ [promptId]: { status: { completed: false, status_str: 'mystery' } } }) });
  assert.equal(decision.state, 'wait');
  assert.equal(decision.code, 'history_outcome_ambiguous');
  assert.equal(decision.safeToSubmit, false);
  assert.equal(decision.retryable, true);
});

test('offline and malformed inspections remain typed, retryable, and non-submittable', () => {
  const offline = decide({ queue: { ok: false, offline: true, code: 'comfy_connection_failed' } });
  assert.equal(offline.state, 'wait');
  assert.equal(offline.code, 'inspection_offline');
  assert.equal(offline.safeToSubmit, false);

  const ambiguous = decide({ history: { ok: false, code: 'timeout' } });
  assert.equal(ambiguous.code, 'inspection_ambiguous');
  assert.equal(ambiguous.safeToSubmit, false);

  const malformed = decide({ queue: ok({ queue_running: 'not-an-array', queue_pending: [] }) });
  assert.equal(malformed.code, 'inspection_ambiguous');
  assert.equal(malformed.queueInspection, 'malformed');
});

test('a cancel tombstone prevents submission in every remote state', () => {
  const absent = decide({ cancelTombstone: true });
  assert.equal(absent.state, 'terminal');
  assert.equal(absent.code, 'cancel_tombstone_confirmed_absent');
  assert.equal(absent.safeToSubmit, false);

  const pending = decide({
    cancelTombstone: true,
    queue: ok({ queue_running: [], queue_pending: [queueEntry(promptId)] }),
  });
  assert.equal(pending.state, 'cancel');
  assert.equal(pending.code, 'cancel_remote_pending');
  assert.equal(pending.safeToSubmit, false);

  const offline = decide({
    cancelTombstone: true,
    history: { ok: false, offline: true, code: 'comfy_connection_failed' },
  });
  assert.equal(offline.state, 'wait');
  assert.equal(offline.code, 'cancel_inspection_offline');
  assert.equal(offline.safeToSubmit, false);

  const historical = decide({
    cancelTombstone: true,
    history: ok({ [promptId]: { status: { completed: true, status_str: 'success' } } }),
  });
  assert.equal(historical.state, 'terminal');
  assert.equal(historical.code, 'cancel_tombstone_history');
});

test('local terminal state short-circuits without trusting remote snapshots', () => {
  const decision = decide({ localState: 'completed', queue: undefined, history: undefined });
  assert.equal(decision.state, 'terminal');
  assert.equal(decision.code, 'local_terminal');
  assert.equal(decision.remoteState, 'not_inspected');
  assert.equal(decision.safeToSubmit, false);
});

test('remote conflicts and duplicate queue records require attention', () => {
  const conflict = decide({
    queue: ok({ queue_running: [queueEntry(promptId)], queue_pending: [] }),
    history: ok({ [promptId]: { status: { completed: true, status_str: 'success' } } }),
  });
  assert.equal(conflict.state, 'attention');
  assert.equal(conflict.code, 'remote_state_conflict');

  const duplicate = decide({
    queue: ok({ queue_running: [], queue_pending: [queueEntry(promptId), queueEntry(promptId)] }),
  });
  assert.equal(duplicate.state, 'attention');
  assert.equal(duplicate.code, 'duplicate_queue_records');
});

test('prompt ids must be stable caller-supplied UUIDs', () => {
  const missing = decide({ promptId: '' });
  assert.equal(missing.state, 'attention');
  assert.equal(missing.code, 'invalid_prompt_id');
  assert.equal(missing.safeToSubmit, false);

  const arbitrary = decide({ promptId: 'job-123' });
  assert.equal(arbitrary.code, 'invalid_prompt_id');
});
