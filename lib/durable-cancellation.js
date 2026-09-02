'use strict';

const PROMPT_STATES = Object.freeze([
  'queued',
  'running',
  'completed',
  'absent',
  'offline',
]);
const PROMPT_STATE_SET = new Set(PROMPT_STATES);
const CANCELLATION_STATES = new Set(['cancel_requested', 'cancelling', 'cancelled']);
const TERMINAL_OPERATION_STATES = new Set(['finalized', 'failed', 'cancelled']);

function cancellationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function promptIdFor(operation) {
  return cleanString(operation?.submission?.comfyPromptId) || cleanString(operation?.id);
}

function hasCancellationTombstone(operation) {
  return !!operation?.cancellation
    && Number.isFinite(Number(operation.cancellation.requestedAt))
    && Number(operation.cancellation.requestedAt) > 0;
}

function transitionPath(operationState, terminal) {
  if (operationState === 'cancelled') return [];
  const path = [];
  if (!CANCELLATION_STATES.has(operationState)) path.push('cancel_requested');
  if (terminal) {
    if (operationState !== 'cancelled') path.push('cancelled');
  } else if (operationState !== 'cancelling') {
    path.push('cancelling');
  }
  return path;
}

/**
 * Decide how a durable cancellation should react to the latest exact-prompt
 * reconciliation result. This function has no side effects: callers persist
 * `transitions` in order, then execute `actions`, then reconcile again.
 *
 * A cancellation tombstone is authoritative. In particular, a prompt that
 * completed after cancellation is acknowledged as cancelled and must never
 * enter gallery finalization.
 */
function durableCancellationDecision(operation, observedState) {
  const operationId = cleanString(operation?.id);
  const state = cleanString(operation?.state);
  const observed = cleanString(observedState?.state || observedState);
  if (!operationId) {
    throw cancellationError('operation_id_required', 'A stable operation ID is required for cancellation reconciliation.');
  }
  if (!PROMPT_STATE_SET.has(observed)) {
    throw cancellationError('prompt_state_invalid', `Unknown prompt reconciliation state: ${observed || 'missing'}.`, {
      operationId,
      observedState: observed || null,
    });
  }

  const promptId = promptIdFor(operation);
  if (!hasCancellationTombstone(operation)) {
    return {
      handled: false,
      operationId,
      promptId,
      observedState: observed,
      transitions: [],
      actions: [],
      retry: false,
      terminal: TERMINAL_OPERATION_STATES.has(state),
      suppressFinalization: false,
      reason: 'no_cancellation_tombstone',
    };
  }

  // A retained tombstone on an already-cancelled record remains authoritative
  // and idempotent regardless of stale or contradictory provider observations.
  if (state === 'cancelled') {
    return {
      handled: true,
      operationId,
      promptId,
      observedState: observed,
      transitions: [],
      actions: [],
      retry: false,
      terminal: true,
      suppressFinalization: true,
      reason: 'already_cancelled',
    };
  }

  if (state === 'finalized' || state === 'failed') {
    throw cancellationError(
      'cancellation_terminal_conflict',
      `Operation ${operationId} has a cancellation tombstone but is already ${state}.`,
      { operationId, state },
    );
  }

  if (observed === 'offline') {
    return {
      handled: true,
      operationId,
      promptId,
      observedState: observed,
      transitions: state === 'cancel_requested' || state === 'cancelling' ? [] : ['cancel_requested'],
      actions: [{ type: 'wait_for_reconnect' }],
      retry: true,
      terminal: false,
      suppressFinalization: true,
      reason: 'cancellation_waiting_for_provider',
    };
  }

  if (observed === 'absent' || observed === 'completed') {
    return {
      handled: true,
      operationId,
      promptId,
      observedState: observed,
      transitions: transitionPath(state, true),
      actions: [],
      retry: false,
      terminal: true,
      suppressFinalization: true,
      reason: observed === 'completed'
        ? 'completed_after_cancellation_discarded'
        : 'cancelled_prompt_absent',
    };
  }

  const action = observed === 'queued' ? 'delete_queued_prompt' : 'interrupt_running_prompt';
  if (!promptId) {
    throw cancellationError(
      'cancellation_prompt_id_missing',
      `Operation ${operationId} cannot cancel its ${observed} prompt without a stable prompt ID.`,
      { operationId, observedState: observed },
    );
  }
  return {
    handled: true,
    operationId,
    promptId,
    observedState: observed,
    transitions: transitionPath(state, false),
    actions: [{ type: action, promptId }],
    retry: true,
    terminal: false,
    suppressFinalization: true,
    reason: observed === 'queued' ? 'cancelling_queued_prompt' : 'cancelling_running_prompt',
  };
}

module.exports = {
  PROMPT_STATES,
  durableCancellationDecision,
  hasCancellationTombstone,
  promptIdFor,
};
