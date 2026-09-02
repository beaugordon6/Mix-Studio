'use strict';

/*
 * Pure reconciliation for a durable, caller-supplied Comfy prompt UUID.
 *
 * Comfy accepts a client-provided prompt_id, but it does not deduplicate a
 * second POST carrying that id. A caller may therefore submit only after both
 * queue and history have authoritatively reported the id absent. This module
 * deliberately performs no I/O: callers collect the two snapshots, persist
 * their local lifecycle first, then act on this typed decision.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_LOCAL_STATES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

function result(state, code, promptId, details = {}) {
  return Object.freeze(Object.assign({
    state,
    code,
    promptId,
    safeToSubmit: state === 'submit',
    retryable: state === 'wait',
  }, details));
}

function inspection(value) {
  if (value && value.ok === true) return { state: 'ok', value: value.value };
  if (value && value.ok === false) {
    const offline = value.offline === true || value.code === 'comfy_connection_failed';
    return { state: offline ? 'offline' : 'ambiguous', code: String(value.code || '') };
  }
  return { state: 'ambiguous', code: 'inspection_missing' };
}

function queuePromptIds(entries) {
  if (!Array.isArray(entries)) return null;
  const ids = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const id = String(entry[1] || '').trim();
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

function inspectQueue(value, promptId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  const running = queuePromptIds(value.queue_running);
  const pending = queuePromptIds(value.queue_pending);
  if (!running || !pending) return { valid: false };
  const runningCount = running.filter((id) => id === promptId).length;
  const pendingCount = pending.filter((id) => id === promptId).length;
  return {
    valid: true,
    runningCount,
    pendingCount,
    present: runningCount + pendingCount > 0,
  };
}

function inspectHistory(value, promptId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  if (!Object.prototype.hasOwnProperty.call(value, promptId)) {
    return { valid: true, present: false };
  }
  const entry = value[promptId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, present: true };
  }
  const status = entry.status && typeof entry.status === 'object' ? entry.status : {};
  const statusText = String(status.status_str || status.status || '').trim().toLowerCase();
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const interrupted = messages.some((message) => {
    const text = JSON.stringify(message || '').toLowerCase();
    return text.includes('execution_interrupted') || text.includes('interrupted');
  });
  const cancelled = interrupted || ['cancelled', 'canceled', 'interrupted'].includes(statusText);
  const failed = ['error', 'failed', 'failure'].includes(statusText);
  const succeeded = status.completed === true && !failed && !cancelled
    && (!statusText || ['success', 'completed', 'complete'].includes(statusText));
  return {
    valid: true,
    present: true,
    terminal: succeeded || failed || cancelled,
    outcome: cancelled ? 'cancelled' : (failed ? 'failed' : (succeeded ? 'completed' : 'unknown')),
    entry,
  };
}

function decideComfySubmission(options = {}) {
  const promptId = String(options.promptId || '').trim();
  if (!UUID_RE.test(promptId)) {
    return result('attention', 'invalid_prompt_id', promptId, {
      retryable: false,
      remoteState: 'unknown',
    });
  }

  const localState = String(options.localState || 'prepared').trim().toLowerCase();
  const cancelTombstone = options.cancelTombstone === true;
  if (TERMINAL_LOCAL_STATES.has(localState)) {
    return result('terminal', 'local_terminal', promptId, {
      retryable: false,
      remoteState: 'not_inspected',
      localState,
    });
  }

  const queueResult = inspection(options.queue);
  const historyResult = inspection(options.history);
  const queue = queueResult.state === 'ok' ? inspectQueue(queueResult.value, promptId) : null;
  const history = historyResult.state === 'ok' ? inspectHistory(historyResult.value, promptId) : null;

  if ((queue && !queue.valid) || (history && !history.valid)) {
    return result('wait', 'inspection_ambiguous', promptId, {
      remoteState: 'unknown',
      queueInspection: queue && !queue.valid ? 'malformed' : queueResult.state,
      historyInspection: history && !history.valid ? 'malformed' : historyResult.state,
    });
  }

  // Conflicting or duplicate remote records are never evidence of absence.
  if (queue?.present && history?.present) {
    return result('attention', 'remote_state_conflict', promptId, {
      retryable: false,
      remoteState: 'conflict',
      historyEntry: history.entry,
    });
  }
  if (queue && queue.runningCount + queue.pendingCount > 1) {
    return result('attention', 'duplicate_queue_records', promptId, {
      retryable: false,
      remoteState: 'conflict',
    });
  }

  // A durable cancellation intent always wins over generation intent.
  if (cancelTombstone) {
    if (queue?.present) {
      return result('cancel', queue.runningCount ? 'cancel_remote_running' : 'cancel_remote_pending', promptId, {
        retryable: true,
        remoteState: queue.runningCount ? 'running' : 'pending',
      });
    }
    if (history?.present) {
      return result('terminal', 'cancel_tombstone_history', promptId, {
        retryable: false,
        remoteState: `history_${history.outcome}`,
        historyEntry: history.entry,
      });
    }
    if (queue?.valid && history?.valid) {
      return result('terminal', 'cancel_tombstone_confirmed_absent', promptId, {
        retryable: false,
        remoteState: 'absent',
      });
    }
    const offline = queueResult.state === 'offline' || historyResult.state === 'offline';
    return result('wait', offline ? 'cancel_inspection_offline' : 'cancel_inspection_ambiguous', promptId, {
      remoteState: 'unknown',
    });
  }

  if (queue?.present) {
    return result('adopt', queue.runningCount ? 'already_running' : 'already_pending', promptId, {
      retryable: false,
      remoteState: queue.runningCount ? 'running' : 'pending',
    });
  }

  if (history?.present) {
    if (!history.terminal) {
      return result('wait', 'history_outcome_ambiguous', promptId, {
        remoteState: 'history_unknown',
        historyEntry: history.entry,
      });
    }
    if (history.outcome === 'completed') {
      return result('finalize', 'already_completed', promptId, {
        retryable: false,
        remoteState: 'history_completed',
        historyEntry: history.entry,
      });
    }
    return result('terminal', history.outcome === 'cancelled' ? 'remote_cancelled' : 'remote_failed', promptId, {
      retryable: false,
      remoteState: `history_${history.outcome}`,
      historyEntry: history.entry,
    });
  }

  // Absence is authoritative only when both independent reads succeeded.
  if (queue?.valid && history?.valid) {
    return result('submit', 'confirmed_absent', promptId, {
      retryable: false,
      remoteState: 'absent',
    });
  }

  const offline = queueResult.state === 'offline' || historyResult.state === 'offline';
  return result('wait', offline ? 'inspection_offline' : 'inspection_ambiguous', promptId, {
    remoteState: 'unknown',
    queueInspection: queueResult.state,
    historyInspection: historyResult.state,
  });
}

module.exports = {
  decideComfySubmission,
};
