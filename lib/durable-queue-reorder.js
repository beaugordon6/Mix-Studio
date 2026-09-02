'use strict';

const RECEIPT_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCEL_STATES = new Set(['pending', 'requested', 'confirmed']);
const SUBMIT_STATES = new Set([
  'blocked', 'submitting', 'submission_unknown', 'submitted', 'adopted', 'history',
]);
const PHASES = new Set(['prepared', 'cancelling', 'requeueing', 'complete', 'attention']);

function reorderError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uuid(value, label) {
  const result = clean(value).toLowerCase();
  if (!UUID_RE.test(result)) throw reorderError('queue_reorder_id_invalid', `${label} must be a canonical UUID.`);
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function derivePhase(jobs) {
  // Completion is an explicit checkpoint only after a fresh remote snapshot
  // verifies the resulting pending order. Local acknowledgements are not enough.
  if (jobs.every((job) => ['submitted', 'adopted', 'history'].includes(job.submitState))) return 'requeueing';
  if (jobs.every((job) => job.cancelState === 'confirmed')) return 'requeueing';
  if (jobs.some((job) => job.cancelState === 'requested')) return 'cancelling';
  return 'prepared';
}

function createQueueReorderReceipt(source, options = {}) {
  const operationId = uuid(source?.operationId, 'Reorder operation ID');
  const profileId = clean(source?.profileId);
  if (!profileId) throw reorderError('queue_reorder_profile_required', 'A profile owner is required.');
  if (!Array.isArray(source?.order) || source.order.length < 1) {
    throw reorderError('queue_reorder_order_required', 'At least one stable prompt ID is required.');
  }
  const order = source.order.map((id) => uuid(id, 'Stable prompt ID'));
  if (new Set(order).size !== order.length) {
    throw reorderError('queue_reorder_order_duplicate', 'A stable prompt ID can appear only once.');
  }
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) throw reorderError('queue_reorder_time_invalid', 'A finite receipt timestamp is required.');
  return validateQueueReorderReceipt({
    version: RECEIPT_VERSION,
    operationId,
    profileId,
    order,
    phase: 'prepared',
    revision: 1,
    jobs: order.map((promptId, desiredIndex) => ({
      promptId,
      profileId,
      desiredIndex,
      revision: 1,
      cancelState: 'pending',
      submitState: 'blocked',
      submissionAttempt: 0,
      lastOutcome: null,
    })),
    attention: null,
    createdAt: now,
    updatedAt: now,
  });
}

function validateQueueReorderReceipt(receipt) {
  if (!receipt || receipt.version !== RECEIPT_VERSION) {
    throw reorderError('queue_reorder_receipt_version_invalid', 'Unsupported queue reorder receipt version.');
  }
  uuid(receipt.operationId, 'Reorder operation ID');
  const owner = clean(receipt.profileId);
  if (!owner || !Array.isArray(receipt.order) || !receipt.order.length || !Array.isArray(receipt.jobs)) {
    throw reorderError('queue_reorder_receipt_invalid', 'The queue reorder receipt is incomplete.');
  }
  if (!PHASES.has(receipt.phase) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw reorderError('queue_reorder_receipt_invalid', 'The queue reorder receipt has an invalid phase or revision.');
  }
  const order = receipt.order.map((id) => uuid(id, 'Stable prompt ID'));
  if (new Set(order).size !== order.length || receipt.jobs.length !== order.length) {
    throw reorderError('queue_reorder_receipt_invalid', 'The queue reorder receipt has duplicate or missing jobs.');
  }
  for (let index = 0; index < receipt.jobs.length; index += 1) {
    const job = receipt.jobs[index];
    if (uuid(job?.promptId, 'Stable prompt ID') !== order[index]
      || job.profileId !== owner || job.desiredIndex !== index
      || !Number.isSafeInteger(job.revision) || job.revision < 1
      || !CANCEL_STATES.has(job.cancelState) || !SUBMIT_STATES.has(job.submitState)
      || !Number.isSafeInteger(job.submissionAttempt) || job.submissionAttempt < 0) {
      throw reorderError('queue_reorder_receipt_invalid', 'The queue reorder receipt contains an invalid job checkpoint.');
    }
  }
  return receipt;
}

function checkpoint(receipt, changes, reason, options = {}) {
  const next = clone(validateQueueReorderReceipt(receipt));
  const byId = new Map(changes.map((change) => [change.promptId, change]));
  next.jobs = next.jobs.map((job) => {
    const change = byId.get(job.promptId);
    if (!change) return job;
    const updated = Object.assign({}, job, change.patch, {
      promptId: job.promptId,
      profileId: job.profileId,
      desiredIndex: job.desiredIndex,
      revision: job.revision + 1,
    });
    return updated;
  });
  next.phase = options.phase || derivePhase(next.jobs);
  next.revision += 1;
  next.updatedAt = Number(options.now ?? receipt.updatedAt);
  if (!Number.isFinite(next.updatedAt)) throw reorderError('queue_reorder_time_invalid', 'A finite checkpoint timestamp is required.');
  if (next.phase !== 'attention') next.attention = null;
  validateQueueReorderReceipt(next);
  return Object.freeze({ type: 'checkpoint', reason, receipt: next });
}

function attention(receipt, code, details = {}, options = {}) {
  const next = clone(validateQueueReorderReceipt(receipt));
  next.phase = 'attention';
  next.attention = Object.assign({ code }, clone(details));
  next.revision += 1;
  next.updatedAt = Number(options.now ?? receipt.updatedAt);
  return Object.freeze({ type: 'attention', code, receipt: validateQueueReorderReceipt(next), retryable: false });
}

function queueIds(entries) {
  if (!Array.isArray(entries)) return null;
  const result = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2 || !clean(entry[1])) return null;
    result.push(clean(entry[1]).toLowerCase());
  }
  return result;
}

function observations(snapshot, receipt) {
  const queueInspection = snapshot?.queue;
  const historyInspection = snapshot?.history;
  if (queueInspection?.ok !== true || historyInspection?.ok !== true) {
    return { wait: true, code: queueInspection?.offline || historyInspection?.offline
      ? 'queue_reorder_inspection_offline' : 'queue_reorder_inspection_ambiguous' };
  }
  const queue = queueInspection.value;
  const history = historyInspection.value;
  const running = queueIds(queue?.queue_running);
  const pending = queueIds(queue?.queue_pending);
  if (!running || !pending || !history || typeof history !== 'object' || Array.isArray(history)) {
    return { wait: true, code: 'queue_reorder_inspection_ambiguous' };
  }
  const allQueueIds = running.concat(pending);
  if (new Set(allQueueIds).size !== allQueueIds.length) {
    return { attention: true, code: 'queue_reorder_duplicate_remote_prompt' };
  }
  const state = new Map();
  for (const job of receipt.jobs) {
    const inRunning = running.includes(job.promptId);
    const inPending = pending.includes(job.promptId);
    const inHistory = Object.prototype.hasOwnProperty.call(history, job.promptId);
    if ((inRunning || inPending) && inHistory) {
      return { attention: true, code: 'queue_reorder_remote_state_conflict', promptId: job.promptId };
    }
    const historyEntry = history[job.promptId];
    if (inHistory && (!historyEntry || typeof historyEntry !== 'object' || Array.isArray(historyEntry))) {
      return { wait: true, code: 'queue_reorder_inspection_ambiguous' };
    }
    state.set(job.promptId, inRunning ? 'running' : (inPending ? 'pending' : (inHistory ? 'history' : 'absent')));
  }
  return { running, pending, history, state };
}

function planQueueReorder(receipt, snapshot, options = {}) {
  validateQueueReorderReceipt(receipt);
  if (receipt.phase === 'attention') {
    return Object.freeze({ type: 'attention', code: receipt.attention?.code || 'queue_reorder_attention', receipt: clone(receipt), retryable: false });
  }
  if (receipt.phase === 'complete') return Object.freeze({ type: 'complete', receipt: clone(receipt) });
  const observed = observations(snapshot, receipt);
  if (observed.wait) return Object.freeze({ type: 'wait', code: observed.code, retryable: true });
  if (observed.attention) return attention(receipt, observed.code, { promptId: observed.promptId || null }, options);

  const historical = receipt.jobs.filter((job) => observed.state.get(job.promptId) === 'history'
    && job.submitState !== 'history');
  if (historical.length) {
    return checkpoint(receipt, historical.map((job) => ({
      promptId: job.promptId,
      patch: { cancelState: 'confirmed', submitState: 'history', lastOutcome: 'history' },
    })), 'history_observed', options);
  }

  const running = receipt.jobs.find((job) => observed.state.get(job.promptId) === 'running');
  if (running) return attention(receipt, 'queue_reorder_prompt_running', { promptId: running.promptId }, options);

  const cancellationCheckpoints = [];
  for (const job of receipt.jobs) {
    const remote = observed.state.get(job.promptId);
    if (job.cancelState === 'pending' && remote === 'pending') {
      cancellationCheckpoints.push({ promptId: job.promptId, patch: { cancelState: 'requested' } });
    } else if (['pending', 'requested'].includes(job.cancelState) && remote === 'absent') {
      cancellationCheckpoints.push({ promptId: job.promptId, patch: { cancelState: 'confirmed' } });
    } else if (job.cancelState === 'confirmed' && remote === 'pending'
      && !['submitting', 'submission_unknown', 'submitted', 'adopted'].includes(job.submitState)) {
      return attention(receipt, 'queue_reorder_unexpected_remote_prompt', { promptId: job.promptId }, options);
    }
  }
  if (cancellationCheckpoints.length) {
    return checkpoint(receipt, cancellationCheckpoints, 'cancellation_checkpoint', options);
  }
  const cancelIds = receipt.jobs.filter((job) => job.cancelState === 'requested'
    && observed.state.get(job.promptId) === 'pending').map((job) => job.promptId);
  if (cancelIds.length) {
    return Object.freeze({
      type: 'cancel_pending',
      promptIds: cancelIds,
      operationId: receipt.operationId,
      requiresPersistedRevision: receipt.revision,
    });
  }
  if (receipt.jobs.some((job) => job.cancelState !== 'confirmed')) {
    return Object.freeze({ type: 'wait', code: 'queue_reorder_waiting_for_cancellation', retryable: true });
  }

  for (const job of receipt.jobs) {
    const remote = observed.state.get(job.promptId);
    if (job.submitState === 'history') continue;
    if (remote === 'pending') {
      if (['submitting', 'submission_unknown', 'submitted'].includes(job.submitState)) {
        return checkpoint(receipt, [{ promptId: job.promptId, patch: {
          submitState: 'adopted', lastOutcome: 'remote_pending',
        } }], 'submission_adopted', options);
      }
      if (job.submitState !== 'adopted') {
        return attention(receipt, 'queue_reorder_unexpected_remote_prompt', { promptId: job.promptId }, options);
      }
      continue;
    }
    if (job.submitState === 'blocked') {
      const earlierIncomplete = receipt.jobs.slice(0, job.desiredIndex)
        .some((earlier) => !['submitted', 'adopted', 'history'].includes(earlier.submitState));
      if (earlierIncomplete) return Object.freeze({ type: 'wait', code: 'queue_reorder_waiting_for_prior_job', retryable: true });
      return checkpoint(receipt, [{ promptId: job.promptId, patch: {
        submitState: 'submitting',
        submissionAttempt: job.submissionAttempt + 1,
        lastOutcome: null,
      } }], 'submission_started', options);
    }
    if (['submitted', 'adopted'].includes(job.submitState)) {
      return checkpoint(receipt, [{ promptId: job.promptId, patch: {
        submitState: 'submission_unknown', lastOutcome: 'confirmed_absent_after_acceptance',
      } }], 'submission_missing', options);
    }
    if (['submitting', 'submission_unknown'].includes(job.submitState)) {
      return Object.freeze({
        type: 'submit',
        promptId: job.promptId,
        desiredIndex: job.desiredIndex,
        retry: job.submitState === 'submission_unknown',
        operationId: receipt.operationId,
        requiresPersistedRevision: receipt.revision,
      });
    }
  }

  const desiredPending = receipt.jobs.filter((job) => job.submitState !== 'history').map((job) => job.promptId);
  const actualPending = observed.pending.filter((id) => desiredPending.includes(id));
  if (actualPending.length === desiredPending.length
    && actualPending.some((id, index) => id !== desiredPending[index])) {
    return attention(receipt, 'queue_reorder_remote_order_mismatch', {
      expected: desiredPending, actual: actualPending,
    }, options);
  }
  return checkpoint(receipt, [], 'reorder_complete', { ...options, phase: 'complete' });
}

function recordQueueReorderSubmitOutcome(receipt, promptId, outcome, options = {}) {
  validateQueueReorderReceipt(receipt);
  promptId = uuid(promptId, 'Stable prompt ID');
  const job = receipt.jobs.find((entry) => entry.promptId === promptId);
  if (!job) throw reorderError('queue_reorder_job_missing', 'The prompt is not part of this reorder transaction.');
  if (!['submitting', 'submission_unknown'].includes(job.submitState)) {
    throw reorderError('queue_reorder_submit_state_invalid', 'This prompt is not awaiting a submission outcome.');
  }
  const normalized = clean(outcome).toLowerCase();
  if (!['acknowledged', 'ambiguous', 'rejected'].includes(normalized)) {
    throw reorderError('queue_reorder_submit_outcome_invalid', 'Unknown reorder submission outcome.');
  }
  if (normalized === 'rejected') {
    return attention(receipt, 'queue_reorder_submission_rejected', { promptId }, options).receipt;
  }
  return checkpoint(receipt, [{ promptId, patch: {
    submitState: normalized === 'acknowledged' ? 'submitted' : 'submission_unknown',
    lastOutcome: normalized,
  } }], `submission_${normalized}`, options).receipt;
}

module.exports = {
  RECEIPT_VERSION,
  createQueueReorderReceipt,
  planQueueReorder,
  recordQueueReorderSubmitOutcome,
  validateQueueReorderReceipt,
};
