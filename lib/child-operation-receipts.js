'use strict';

const crypto = require('node:crypto');

const CHILD_RECEIPT_VERSION = 1;
const CHILD_STATES = Object.freeze([
  'planned',
  'staging',
  'staged',
  'submitting',
  'submission_unknown',
  'submitted',
  'running',
  'output_ready',
  'finalizing',
  'awaiting_recovery',
  'cancel_requested',
  'cancelling',
  'finalized',
  'cancelled',
  'attention',
  'failed',
]);
const CHILD_STATE_SET = new Set(CHILD_STATES);
const TERMINAL_CHILD_STATES = new Set(['finalized', 'cancelled', 'failed']);
const TRANSITIONS = Object.freeze({
  planned: ['staging', 'cancel_requested', 'attention', 'failed'],
  staging: ['staged', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  staged: ['submitting', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  submitting: ['submitted', 'submission_unknown', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  submission_unknown: ['submitting', 'submitted', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  submitted: ['running', 'output_ready', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  running: ['output_ready', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  output_ready: ['finalizing', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  finalizing: ['finalized', 'awaiting_recovery', 'cancel_requested', 'attention', 'failed'],
  awaiting_recovery: [
    'staging', 'staged', 'submitting', 'submission_unknown', 'submitted', 'running',
    'output_ready', 'finalizing', 'cancel_requested', 'attention', 'failed',
  ],
  cancel_requested: ['cancelling', 'cancelled', 'awaiting_recovery', 'attention'],
  cancelling: ['cancelled', 'awaiting_recovery', 'attention'],
  attention: [
    'staging', 'staged', 'submitting', 'submission_unknown', 'submitted', 'running',
    'output_ready', 'finalizing', 'cancel_requested', 'failed',
  ],
  finalized: [],
  cancelled: [],
  failed: [],
});
const PATCH_KEYS = new Set(['submission', 'result', 'cancellation', 'recovery', 'error']);

function receiptError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value, label = 'value') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw receiptError('child_receipt_json_invalid', `${label} must be JSON serializable.`, { cause });
  }
}

function canonicalUuid(value, label = 'child operation ID') {
  const id = cleanString(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw receiptError('child_receipt_uuid_invalid', `${label} must be a canonical UUID.`, { label });
  }
  return id;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw receiptError('child_receipt_intent_invalid', 'Intent numbers must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw receiptError('child_receipt_intent_invalid', 'Intent data cannot contain cycles.');
    seen.add(value);
    const encoded = `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw receiptError('child_receipt_intent_invalid', 'Intent data cannot contain cycles.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw receiptError('child_receipt_intent_invalid', 'Intent data must contain only JSON objects and arrays.');
    }
    seen.add(value);
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (value[key] === undefined || ['function', 'symbol', 'bigint'].includes(typeof value[key])) {
        throw receiptError('child_receipt_intent_invalid', `Intent field ${key} is not JSON serializable.`);
      }
    }
    const encoded = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return encoded;
  }
  throw receiptError('child_receipt_intent_invalid', 'Intent data must be JSON serializable.');
}

function childIntentHash(intent) {
  return crypto.createHash('sha256')
    .update(`mix-child-receipt-v${CHILD_RECEIPT_VERSION}\0${canonicalJson(intent)}`)
    .digest('hex');
}

function normalizeOrdinal(value) {
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw receiptError('child_receipt_ordinal_invalid', 'Child operation ordinals must be non-negative integers.');
  }
  return ordinal;
}

function normalizeRelation(value) {
  const relation = cleanString(value).toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{0,63}$/.test(relation)) {
    throw receiptError('child_receipt_relation_invalid', 'A path-safe child operation relation is required.');
  }
  return relation;
}

function validateSubmission(receipt) {
  const submission = receipt.submission;
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    throw receiptError('child_receipt_submission_invalid', 'Child operation submission metadata is required.');
  }
  if (submission.promptId !== receipt.id) {
    throw receiptError('child_receipt_prompt_id_invalid', 'The provider prompt ID must equal the stored child UUID.');
  }
  const attempt = Number(submission.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw receiptError('child_receipt_submission_invalid', 'Submission attempt must be a non-negative integer.');
  }
  if (submission.attemptId != null && submission.attemptId !== '') canonicalUuid(submission.attemptId, 'submission attempt ID');
  for (const key of ['startedAt', 'acknowledgedAt']) {
    if (submission[key] != null && !Number.isFinite(Number(submission[key]))) {
      throw receiptError('child_receipt_submission_invalid', `Submission ${key} must be a finite timestamp or null.`);
    }
  }
}

function validateChildReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw receiptError('child_receipt_invalid', 'A child operation receipt is required.');
  }
  if (receipt.version !== CHILD_RECEIPT_VERSION) {
    throw receiptError('child_receipt_version_invalid', 'Unsupported child operation receipt version.');
  }
  canonicalUuid(receipt.id);
  if (!cleanString(receipt.parentId)) throw receiptError('child_receipt_parent_required', 'A parent operation operation ID is required.');
  normalizeRelation(receipt.relation);
  normalizeOrdinal(receipt.ordinal);
  if (!cleanString(receipt.profileId)) throw receiptError('child_receipt_profile_required', 'A profile ID is required.');
  if (!receipt.intent || typeof receipt.intent !== 'object' || Array.isArray(receipt.intent)) {
    throw receiptError('child_receipt_intent_invalid', 'A child operation intent object is required.');
  }
  const expectedHash = childIntentHash(receipt.intent);
  if (receipt.intentHash !== expectedHash) {
    throw receiptError('child_receipt_intent_mismatch', 'The child operation intent no longer matches its immutable hash.');
  }
  if (!CHILD_STATE_SET.has(receipt.state)) throw receiptError('child_receipt_state_invalid', `Unknown child operation state: ${receipt.state}.`);
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw receiptError('child_receipt_revision_invalid', 'Child operation revision must be a positive integer.');
  }
  if (!Number.isFinite(Number(receipt.createdAt)) || !Number.isFinite(Number(receipt.updatedAt))) {
    throw receiptError('child_receipt_time_invalid', 'Child operation timestamps must be finite.');
  }
  if (receipt.state === 'finalized'
    && (!receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result))) {
    throw receiptError('child_receipt_result_required', 'A finalized child operation needs a durable result receipt.');
  }
  if (['cancel_requested', 'cancelling', 'cancelled'].includes(receipt.state)
    && (!receipt.cancellation || !Number.isFinite(Number(receipt.cancellation.requestedAt)))) {
    throw receiptError('child_receipt_cancellation_required', 'Cancellation states need a durable cancellation tombstone.');
  }
  validateSubmission(receipt);
  return receipt;
}

function createChildReceipt(source, options = {}) {
  const now = Number(options.now ?? source?.createdAt ?? Date.now());
  if (!Number.isFinite(now)) throw receiptError('child_receipt_time_invalid', 'A finite creation timestamp is required.');
  const intentHash = childIntentHash(source?.intent);
  const intent = cloneJson(source?.intent, 'intent');
  const receipt = {
    version: CHILD_RECEIPT_VERSION,
    id: canonicalUuid(source?.id),
    parentId: cleanString(source?.parentId),
    relation: normalizeRelation(source?.relation),
    ordinal: normalizeOrdinal(source?.ordinal),
    required: source?.required !== false,
    profileId: cleanString(source?.profileId),
    intent,
    intentHash,
    state: 'planned',
    revision: 1,
    submission: {
      promptId: canonicalUuid(source?.id),
      attempt: 0,
      attemptId: null,
      runtimeFingerprint: null,
      startedAt: null,
      acknowledgedAt: null,
    },
    result: null,
    cancellation: null,
    recovery: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return validateChildReceipt(receipt);
}

function immutableIdentity(receipt) {
  return {
    version: receipt.version,
    id: receipt.id,
    parentId: receipt.parentId,
    relation: receipt.relation,
    ordinal: receipt.ordinal,
    required: receipt.required,
    profileId: receipt.profileId,
    intentHash: receipt.intentHash,
    createdAt: receipt.createdAt,
  };
}

function assertSameChildIdentity(expected, actual) {
  validateChildReceipt(expected);
  validateChildReceipt(actual);
  const left = immutableIdentity(expected);
  const right = immutableIdentity(actual);
  const mismatches = Object.keys(left).filter((key) => left[key] !== right[key]);
  if (mismatches.length) {
    throw receiptError('child_receipt_identity_conflict', 'Child operation receipt identity changed.', { mismatches });
  }
  return true;
}

function transitionChildReceipt(receipt, nextState, patch = {}, options = {}) {
  validateChildReceipt(receipt);
  if (!CHILD_STATE_SET.has(nextState)) throw receiptError('child_receipt_state_invalid', `Unknown child operation state: ${nextState}.`);
  if (options.expectedRevision != null && Number(options.expectedRevision) !== receipt.revision) {
    throw receiptError('child_receipt_revision_conflict', 'The child operation changed before this transition.', {
      expectedRevision: Number(options.expectedRevision), actualRevision: receipt.revision,
    });
  }
  if (nextState === receipt.state) return cloneJson(receipt);
  if (!TRANSITIONS[receipt.state].includes(nextState)) {
    throw receiptError('child_receipt_transition_invalid', `Cannot transition a child operation from ${receipt.state} to ${nextState}.`, {
      from: receipt.state, to: nextState,
    });
  }
  const supplied = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const unknown = Object.keys(supplied).filter((key) => !PATCH_KEYS.has(key));
  if (unknown.length) throw receiptError('child_receipt_patch_invalid', `Transition patch cannot change ${unknown.join(', ')}.`);
  const next = cloneJson(receipt);
  for (const key of PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(supplied, key)) next[key] = cloneJson(supplied[key], key);
  }
  next.state = nextState;
  next.revision += 1;
  next.updatedAt = Number(options.now ?? Date.now());
  validateChildReceipt(next);
  assertSameChildIdentity(receipt, next);
  return next;
}

function beginChildSubmission(receipt, source = {}, options = {}) {
  const attemptId = canonicalUuid(source.attemptId || crypto.randomUUID(), 'submission attempt ID');
  return transitionChildReceipt(receipt, 'submitting', {
    submission: Object.assign({}, receipt.submission, {
      attempt: receipt.submission.attempt + 1,
      attemptId,
      runtimeFingerprint: cleanString(source.runtimeFingerprint) || null,
      startedAt: Number(options.now ?? Date.now()),
      acknowledgedAt: null,
    }),
    recovery: null,
    error: null,
  }, options);
}

function requestChildCancellation(receipt, source = {}, options = {}) {
  if (receipt.cancellation) return cloneJson(validateChildReceipt(receipt));
  if (TERMINAL_CHILD_STATES.has(receipt.state)) {
    throw receiptError('child_receipt_terminal', `Child operation is already ${receipt.state}.`);
  }
  const now = Number(options.now ?? Date.now());
  return transitionChildReceipt(receipt, 'cancel_requested', {
    cancellation: { requestedAt: now, reason: cleanString(source.reason) || 'Cancelled by parent' },
    error: null,
  }, { ...options, now });
}

function markChildAwaitingRecovery(receipt, source = {}, options = {}) {
  const resumeState = cleanString(source.resumeState) || receipt.state;
  if (!CHILD_STATE_SET.has(resumeState) || TERMINAL_CHILD_STATES.has(resumeState)) {
    throw receiptError('child_receipt_recovery_invalid', 'Recovery needs a valid nonterminal resume state.');
  }
  return transitionChildReceipt(receipt, 'awaiting_recovery', {
    recovery: {
      resumeState,
      reason: cleanString(source.reason) || 'Waiting for recovery',
      retryAt: source.retryAt == null ? null : Number(source.retryAt),
    },
    error: source.error == null ? null : cloneJson(source.error, 'error'),
  }, options);
}

function planParentCompletion(parent, receipts) {
  const parentId = cleanString(typeof parent === 'string' ? parent : parent?.id);
  if (!parentId) throw receiptError('child_receipt_parent_required', 'A parent operation ID is required.');
  if (!Array.isArray(receipts)) throw receiptError('child_receipt_children_invalid', 'Child receipts must be an array.');
  const children = receipts.map((receipt) => validateChildReceipt(receipt));
  const ids = new Set();
  const ordinals = new Set();
  for (const child of children) {
    if (child.parentId !== parentId) throw receiptError('child_receipt_parent_mismatch', 'A child receipt belongs to another parent.', { childId: child.id });
    if (ids.has(child.id) || ordinals.has(child.ordinal)) {
      throw receiptError('child_receipt_duplicate', 'A parent cannot contain duplicate child IDs or ordinals.');
    }
    ids.add(child.id);
    ordinals.add(child.ordinal);
  }
  const required = children.filter((child) => child.required);
  const cancelRequested = typeof parent === 'object' && parent?.cancelRequested === true;
  const select = (states) => required.filter((child) => states.has(child.state)).map((child) => child.id);
  const activeIds = select(new Set(CHILD_STATES.filter((state) => !TERMINAL_CHILD_STATES.has(state))));
  if (cancelRequested) {
    const allActiveIds = children
      .filter((child) => !TERMINAL_CHILD_STATES.has(child.state))
      .map((child) => child.id);
    if (allActiveIds.length) {
      return { action: 'cancel_children', reason: 'parent_cancel_requested', childIds: allActiveIds };
    }
    return { action: 'cancel', reason: 'children_terminal_after_parent_cancellation', childIds: [] };
  }
  const attentionIds = select(new Set(['attention']));
  if (attentionIds.length) return { action: 'attention', reason: 'required_child_attention', childIds: attentionIds };
  const failedIds = select(new Set(['failed']));
  if (failedIds.length) return { action: 'fail', reason: 'required_child_failed', childIds: failedIds };
  const cancelledIds = select(new Set(['cancelled']));
  if (cancelledIds.length) return { action: 'attention', reason: 'required_child_cancelled', childIds: cancelledIds };
  if (required.every((child) => child.state === 'finalized')) {
    return { action: 'finalize', reason: required.length ? 'all_required_children_finalized' : 'no_required_children', childIds: [] };
  }
  return { action: 'wait', reason: 'required_children_pending', childIds: activeIds };
}

module.exports = {
  CHILD_RECEIPT_VERSION,
  CHILD_STATES,
  TERMINAL_CHILD_STATES,
  assertSameChildIdentity,
  beginChildSubmission,
  canonicalJson,
  childIntentHash,
  createChildReceipt,
  markChildAwaitingRecovery,
  planParentCompletion,
  requestChildCancellation,
  transitionChildReceipt,
  validateChildReceipt,
};
