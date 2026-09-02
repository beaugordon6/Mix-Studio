'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JOURNAL_VERSION = 2;
const TERMINAL_STATES = new Set(['finalized', 'failed', 'cancelled']);
const STATES = new Set([
  'prepared',
  'staging',
  'staged',
  'submitting',
  'submitted',
  'running',
  'output_ready',
  'finalizing',
  'cancel_requested',
  'cancelling',
  'attention',
  'finalized',
  'failed',
  'cancelled',
]);

const TRANSITIONS = Object.freeze({
  prepared: new Set(['staging', 'staged', 'submitting', 'cancel_requested', 'attention', 'failed']),
  staging: new Set(['staged', 'cancel_requested', 'attention', 'failed']),
  staged: new Set(['staging', 'submitting', 'cancel_requested', 'attention', 'failed']),
  submitting: new Set(['submitted', 'running', 'output_ready', 'cancel_requested', 'attention', 'failed']),
  submitted: new Set(['running', 'output_ready', 'cancel_requested', 'cancelling', 'attention', 'failed']),
  running: new Set(['output_ready', 'cancel_requested', 'cancelling', 'attention', 'failed']),
  output_ready: new Set(['finalizing', 'cancel_requested', 'attention', 'failed']),
  finalizing: new Set(['output_ready', 'finalized', 'cancel_requested', 'attention', 'failed']),
  cancel_requested: new Set(['cancelling', 'cancelled', 'attention']),
  cancelling: new Set(['cancel_requested', 'cancelled', 'attention']),
  attention: new Set([
    'staging', 'staged', 'submitting', 'submitted', 'running', 'output_ready', 'finalizing',
    'cancel_requested', 'cancelling', 'failed', 'cancelled',
  ]),
  finalized: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

function journalError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, options);
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value, label = 'value') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw journalError('operation_not_serializable', `${label} must be JSON serializable.`, { cause });
  }
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cleanString(value));
}

function normalizeAssets(assets, profileId) {
  const normalized = [];
  const seen = new Set();
  for (const source of Array.isArray(assets) ? assets : []) {
    const logicalName = cleanString(source?.logicalName || source?.name);
    if (!logicalName) {
      throw journalError('operation_asset_invalid', 'Every durable asset needs a logicalName.');
    }
    const assetProfileId = cleanString(source?.profileId || profileId);
    if (assetProfileId !== profileId) {
      throw journalError(
        'operation_asset_profile_mismatch',
        `Asset ${logicalName} does not belong to the operation profile.`,
        { logicalName, profileId, assetProfileId },
      );
    }
    const sha256 = cleanString(source?.sha256).toLowerCase();
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
      throw journalError('operation_asset_invalid', `Asset ${logicalName} has an invalid SHA-256 digest.`);
    }
    const bytes = source?.bytes == null ? null : Number(source.bytes);
    if (bytes != null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
      throw journalError('operation_asset_invalid', `Asset ${logicalName} has an invalid byte length.`);
    }
    const identity = cleanString(source?.assetId) || logicalName;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({
      assetId: cleanString(source?.assetId) || null,
      logicalName,
      profileId,
      kind: cleanString(source?.kind) || 'image',
      sha256: sha256 || null,
      bytes,
      source: cleanString(source?.source) || 'mix',
    });
  }
  return normalized;
}

function normalizePreparedOperation(source, context) {
  const profileId = cleanString(source?.profileId);
  const kind = cleanString(source?.kind);
  const workflow = cleanString(source?.workflow || kind);
  if (!profileId) throw journalError('operation_profile_required', 'A profileId is required.');
  if (!kind) throw journalError('operation_kind_required', 'An operation kind is required.');
  if (!workflow) throw journalError('operation_workflow_required', 'A workflow is required.');
  if (!source?.graph || typeof source.graph !== 'object' || Array.isArray(source.graph)) {
    throw journalError('operation_graph_required', 'A generation graph is required.');
  }
  const id = context.id;
  const now = context.now;
  return {
    id,
    revision: 1,
    ordinal: context.ordinal,
    state: 'prepared',
    profileId,
    kind,
    workflow,
    graph: cloneJson(source.graph, 'graph'),
    request: cloneJson(source.request ?? source.params ?? {}, 'request'),
    assets: normalizeAssets(source.assets, profileId),
    submission: {
      attempt: 0,
      attemptId: null,
      comfyPromptId: id,
      runtimeEpoch: null,
      startedAt: null,
      acknowledgedAt: null,
    },
    cancellation: null,
    finalization: null,
    createdAt: now,
    updatedAt: now,
  };
}

function inferLegacyWorkflow(job) {
  if (job?.kind === 'loraHunt') return 'strength-hunt';
  if (job?.params?.mode === 'edit') return `edit:${cleanString(job.params.editEngine) || 'unknown'}`;
  return cleanString(job?.params?.mode) || cleanString(job?.kind) || 'generation';
}

function legacyAssets(job, profileId) {
  const names = [
    ...(Array.isArray(job?.elementInputNames) ? job.elementInputNames : []),
    ...(Array.isArray(job?.refImageNames) ? job.refImageNames : []),
  ];
  return normalizeAssets(names.map((logicalName) => ({ logicalName, profileId, source: 'legacy' })), profileId);
}

function migrateLegacyJournal(parsed, options = {}) {
  const now = Number(options.now) || Date.now();
  const idFactory = options.idFactory || crypto.randomUUID;
  const operations = [];
  let ordinal = 1;
  for (const entry of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
    const job = entry?.job;
    const profileId = cleanString(job?.profileId);
    if (!job || !profileId || !job.graph || typeof job.graph !== 'object') {
      throw journalError('operation_journal_migration_failed', 'The legacy journal contains an invalid job record.');
    }
    const legacyPromptId = cleanString(entry.id);
    const id = validUuid(legacyPromptId) ? legacyPromptId : idFactory();
    if (!validUuid(id)) {
      throw journalError('operation_id_invalid', 'The operation ID factory must return a canonical UUID.');
    }
    const createdAt = Number(job.enqueuedAt) || now;
    operations.push({
      id,
      revision: 1,
      ordinal: ordinal++,
      state: job.cancelRequested ? 'cancel_requested' : 'submitted',
      profileId,
      kind: cleanString(job.kind) || 'gen',
      workflow: inferLegacyWorkflow(job),
      graph: cloneJson(job.graph, 'legacy graph'),
      request: cloneJson(job.params || {}, 'legacy request'),
      assets: legacyAssets(job, profileId),
      submission: {
        attempt: 1,
        attemptId: null,
        comfyPromptId: legacyPromptId || id,
        runtimeEpoch: null,
        startedAt: createdAt,
        acknowledgedAt: createdAt,
      },
      cancellation: job.cancelRequested ? {
        requestedAt: Number(job.cancelRequestedAt) || now,
        reason: cleanString(job.cancelMessage) || 'Cancellation requested before migration',
      } : null,
      finalization: null,
      recovery: job.recoveryError ? cloneJson(job.recoveryError, 'legacy recovery error') : null,
      legacyPromptId: legacyPromptId || null,
      createdAt,
      updatedAt: now,
    });
  }
  return { version: JOURNAL_VERSION, nextOrdinal: ordinal, operations };
}

function parseJournal(file, fsImpl, options) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { snapshot: { version: JOURNAL_VERSION, nextOrdinal: 1, operations: [] }, migrated: false };
    throw journalError('operation_journal_read_failed', `Could not read operation journal: ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw journalError('operation_journal_corrupt', 'The operation journal is not valid JSON.', { cause });
  }
  if (parsed?.version === 1 && Array.isArray(parsed.jobs)) {
    return { snapshot: migrateLegacyJournal(parsed, options), migrated: true };
  }
  if (parsed?.version !== JOURNAL_VERSION || !Array.isArray(parsed.operations)) {
    throw journalError('operation_journal_unsupported', `Unsupported operation journal version: ${String(parsed?.version ?? 'missing')}.`);
  }
  const ids = new Set();
  const ordinals = new Set();
  for (const operation of parsed.operations) {
    if (!validUuid(operation?.id) || ids.has(operation.id)) {
      throw journalError('operation_journal_corrupt', 'The operation journal contains an invalid or duplicate operation ID.');
    }
    if (!Number.isSafeInteger(operation.ordinal) || operation.ordinal < 1 || ordinals.has(operation.ordinal)) {
      throw journalError('operation_journal_corrupt', 'The operation journal contains an invalid or duplicate FIFO ordinal.');
    }
    if (!STATES.has(operation.state) || !Number.isSafeInteger(operation.revision) || operation.revision < 1) {
      throw journalError('operation_journal_corrupt', 'The operation journal contains an invalid state or revision.');
    }
    ids.add(operation.id);
    ordinals.add(operation.ordinal);
  }
  const minimumNext = parsed.operations.reduce((max, operation) => Math.max(max, operation.ordinal + 1), 1);
  return {
    snapshot: {
      version: JOURNAL_VERSION,
      nextOrdinal: Math.max(minimumNext, Number.isSafeInteger(parsed.nextOrdinal) ? parsed.nextOrdinal : 1),
      operations: cloneJson(parsed.operations),
    },
    migrated: false,
  };
}

function persistSnapshot(file, snapshot, fsImpl, randomBytes) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const temporary = `${file}.${process.pid}.${suffix}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
      const descriptor = fsImpl.openSync(temporary, 'r');
      try { fsImpl.fsyncSync(descriptor); } finally { fsImpl.closeSync(descriptor); }
    }
    fsImpl.renameSync(temporary, file);
    if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
      try {
        const directory = fsImpl.openSync(path.dirname(file), 'r');
        try { fsImpl.fsyncSync(directory); } finally { fsImpl.closeSync(directory); }
      } catch { /* Some platforms do not permit fsync on directories. */ }
    }
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch { /* best effort */ }
    throw journalError('operation_journal_write_failed', `Could not persist operation journal: ${error.message}`, { cause: error });
  }
}

function createOperationJournal(file, options = {}) {
  if (!cleanString(file)) throw journalError('operation_journal_path_required', 'An operation journal path is required.');
  const fsImpl = options.fs || fs;
  const clock = options.clock || (() => Date.now());
  const idFactory = options.idFactory || crypto.randomUUID;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const loaded = parseJournal(file, fsImpl, { idFactory, now: clock() });
  let snapshot = loaded.snapshot;
  if (loaded.migrated) persistSnapshot(file, snapshot, fsImpl, randomBytes);

  function commit(next) {
    persistSnapshot(file, next, fsImpl, randomBytes);
    snapshot = next;
  }

  function operationIndex(id) {
    return snapshot.operations.findIndex((operation) => operation.id === id);
  }

  function get(id) {
    const operation = snapshot.operations[operationIndex(cleanString(id))];
    return operation ? cloneJson(operation) : null;
  }

  function prepare(source) {
    let id = cleanString(source?.id);
    if (id && !validUuid(id)) throw journalError('operation_id_invalid', 'Operation IDs must be canonical UUIDs.');
    for (let attempt = 0; !id || operationIndex(id) !== -1; attempt += 1) {
      if (source?.id || attempt >= 8) throw journalError('operation_id_conflict', `Operation ${id || ''} already exists.`);
      id = idFactory();
      if (!validUuid(id)) throw journalError('operation_id_invalid', 'The operation ID factory must return a canonical UUID.');
    }
    const operation = normalizePreparedOperation(source, {
      id,
      ordinal: snapshot.nextOrdinal,
      now: clock(),
    });
    const next = {
      version: JOURNAL_VERSION,
      nextOrdinal: snapshot.nextOrdinal + 1,
      operations: snapshot.operations.concat([operation]),
    };
    commit(next);
    return cloneJson(operation);
  }

  function transition(id, nextState, patch = {}, transitionOptions = {}) {
    id = cleanString(id);
    nextState = cleanString(nextState);
    const index = operationIndex(id);
    if (index === -1) throw journalError('operation_not_found', `Operation ${id} was not found.`, { operationId: id });
    if (!STATES.has(nextState)) throw journalError('operation_state_invalid', `Unknown operation state: ${nextState}.`);
    const current = snapshot.operations[index];
    if (transitionOptions.expectedRevision != null && Number(transitionOptions.expectedRevision) !== current.revision) {
      throw journalError('operation_revision_conflict', `Operation ${id} changed before this transition.`, {
        operationId: id,
        expectedRevision: Number(transitionOptions.expectedRevision),
        actualRevision: current.revision,
      });
    }
    if (nextState === current.state) return cloneJson(current);
    if (!TRANSITIONS[current.state]?.has(nextState)) {
      throw journalError('operation_transition_invalid', `Cannot transition operation ${id} from ${current.state} to ${nextState}.`, {
        operationId: id, from: current.state, to: nextState,
      });
    }
    const cleanPatch = cloneJson(patch || {}, 'transition patch');
    for (const protectedKey of ['id', 'revision', 'ordinal', 'state', 'profileId', 'kind', 'workflow', 'createdAt']) {
      delete cleanPatch[protectedKey];
    }
    const updated = Object.assign({}, current, cleanPatch, {
      id: current.id,
      revision: current.revision + 1,
      ordinal: current.ordinal,
      state: nextState,
      profileId: current.profileId,
      kind: current.kind,
      workflow: current.workflow,
      createdAt: current.createdAt,
      updatedAt: clock(),
    });
    if (current.cancellation && cleanPatch.cancellation == null) updated.cancellation = current.cancellation;
    const next = cloneJson(snapshot);
    next.operations[index] = updated;
    commit(next);
    return cloneJson(updated);
  }

  function beginSubmission(id, submissionOptions = {}) {
    const current = get(id);
    if (!current) throw journalError('operation_not_found', `Operation ${id} was not found.`, { operationId: id });
    const attemptId = cleanString(submissionOptions.attemptId) || idFactory();
    if (!validUuid(attemptId)) throw journalError('operation_attempt_invalid', 'Submission attempt IDs must be canonical UUIDs.');
    const now = clock();
    return transition(id, 'submitting', {
      submission: Object.assign({}, current.submission, {
        attempt: Math.max(0, Number(current.submission?.attempt) || 0) + 1,
        attemptId,
        comfyPromptId: current.id,
        runtimeEpoch: cleanString(submissionOptions.runtimeEpoch) || null,
        startedAt: now,
        acknowledgedAt: null,
      }),
    }, { expectedRevision: submissionOptions.expectedRevision ?? current.revision });
  }

  function markSubmitted(id, submissionOptions = {}) {
    const current = get(id);
    if (!current) throw journalError('operation_not_found', `Operation ${id} was not found.`, { operationId: id });
    const attemptId = cleanString(submissionOptions.attemptId);
    if (attemptId && attemptId !== current.submission?.attemptId) {
      throw journalError('operation_attempt_conflict', `Submission attempt ${attemptId} is no longer current.`, {
        operationId: id,
        attemptId,
        currentAttemptId: current.submission?.attemptId || null,
      });
    }
    return transition(id, 'submitted', {
      submission: Object.assign({}, current.submission, {
        comfyPromptId: cleanString(submissionOptions.comfyPromptId) || current.id,
        acknowledgedAt: clock(),
      }),
    }, { expectedRevision: submissionOptions.expectedRevision ?? current.revision });
  }

  function requestCancellation(id, cancellationOptions = {}) {
    const current = get(id);
    if (!current) throw journalError('operation_not_found', `Operation ${id} was not found.`, { operationId: id });
    if (current.cancellation) return current;
    if (TERMINAL_STATES.has(current.state)) {
      throw journalError('operation_terminal', `Operation ${id} is already ${current.state}.`, {
        operationId: id, state: current.state,
      });
    }
    return transition(id, 'cancel_requested', {
      cancellation: {
        requestedAt: clock(),
        reason: cleanString(cancellationOptions.reason) || 'Cancelled by user',
      },
    }, { expectedRevision: cancellationOptions.expectedRevision ?? current.revision });
  }

  return {
    version: JOURNAL_VERSION,
    file,
    get,
    prepare,
    transition,
    beginSubmission,
    markSubmitted,
    requestCancellation,
    entries() {
      return snapshot.operations
        .slice()
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((operation) => [operation.id, cloneJson(operation)]);
    },
    active() {
      return snapshot.operations
        .filter((operation) => !TERMINAL_STATES.has(operation.state))
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((operation) => cloneJson(operation));
    },
    snapshot() {
      return cloneJson(snapshot);
    },
  };
}

module.exports = {
  JOURNAL_VERSION,
  STATES,
  TERMINAL_STATES,
  createOperationJournal,
  migrateLegacyJournal,
  normalizeAssets,
  validUuid,
};
