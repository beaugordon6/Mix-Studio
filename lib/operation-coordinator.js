'use strict';

const {
  TERMINAL_STATES,
  normalizeAssets,
  validUuid,
} = require('./operation-journal');
const { childIntentHash } = require('./child-operation-receipts');

const COORDINATION_VERSION = 1;
const OPERATION_FAMILIES = new Set(['edit_sequence', 'smart']);
const DISPATCHABLE_STATES = new Set(['prepared', 'staging', 'staged']);
const RECONCILE_STATES = new Set(['submitting', 'submitted', 'running']);
const FINALIZE_STATES = new Set(['output_ready', 'finalizing']);
const CANCEL_STATES = new Set(['cancel_requested', 'cancelling']);

function coordinatorError(code, message, details = {}) {
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
    throw coordinatorError('operation_coordination_json_invalid', `${label} must be JSON serializable.`, { cause });
  }
}

function canonicalUuid(value, label) {
  const id = cleanString(value).toLowerCase();
  if (!validUuid(id)) {
    throw coordinatorError('operation_coordination_id_invalid', `${label} must be a canonical UUID.`, { label });
  }
  return id;
}

function normalizeFamily(value) {
  const family = cleanString(value).toLowerCase();
  if (!OPERATION_FAMILIES.has(family)) {
    throw coordinatorError('operation_coordination_family_invalid', `Unsupported coordinated operation family: ${family || 'missing'}.`);
  }
  return family;
}

function normalizeOrdinal(value) {
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw coordinatorError('operation_coordination_ordinal_invalid', 'Child ordinals must be non-negative integers.');
  }
  return ordinal;
}

function normalizeRelation(value) {
  const relation = cleanString(value).toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{0,63}$/.test(relation)) {
    throw coordinatorError('operation_coordination_relation_invalid', 'A path-safe child relation is required.');
  }
  return relation;
}

function normalizeDependencies(value) {
  const dependencies = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const id = canonicalUuid(entry, 'Dependency operation ID');
    if (seen.has(id)) {
      throw coordinatorError('operation_coordination_dependency_duplicate', `Dependency ${id} is listed more than once.`, { dependencyId: id });
    }
    seen.add(id);
    dependencies.push(id);
  }
  return dependencies;
}

function coordinationFor(operation) {
  const coordination = operation?.request?.coordination;
  if (!coordination || coordination.version !== COORDINATION_VERSION) return null;
  return coordination;
}

function coordinatedIntent(source, coordination) {
  const profileId = cleanString(source.profileId);
  return {
    profileId,
    kind: cleanString(source.kind) || 'child',
    workflow: cleanString(source.workflow),
    graph: source.graph || {},
    request: source.request || {},
    assets: normalizeAssets(source.assets || [], profileId),
    coordination,
  };
}

function sameCoordination(left, right) {
  return !!left && !!right && childIntentHash(left) === childIntentHash(right);
}

function validateCoordinatedOperation(operation) {
  const coordination = coordinationFor(operation);
  if (!coordination) {
    throw coordinatorError('operation_coordination_missing', `Operation ${operation?.id || 'unknown'} has no coordination record.`);
  }
  canonicalUuid(operation.id, 'Child operation ID');
  canonicalUuid(coordination.parentOperationId, 'Parent operation ID');
  normalizeFamily(coordination.family);
  normalizeRelation(coordination.relation);
  normalizeOrdinal(coordination.ordinal);
  normalizeDependencies(coordination.dependsOn);
  if (!cleanString(operation.profileId)) {
    throw coordinatorError('operation_coordination_profile_required', 'A coordinated operation needs a profile ID.');
  }
  const { coordination: ignoredCoordination, ...request } = operation.request || {};
  const liveIntent = coordinatedIntent(operation, {
    family: coordination.family,
    parentOperationId: coordination.parentOperationId,
    relation: coordination.relation,
    ordinal: coordination.ordinal,
    dependsOn: coordination.dependsOn,
    required: coordination.required,
  });
  liveIntent.request = request;
  if (coordination.intentHash !== childIntentHash(coordination.intent)
    || coordination.intentHash !== childIntentHash(liveIntent)) {
    throw coordinatorError('operation_coordination_intent_mismatch', `Operation ${operation.id} no longer matches its immutable coordinated intent.`);
  }
  return coordination;
}

function actionForState(operation) {
  let state = operation.state;
  if (state === 'attention') {
    const resumeState = cleanString(operation.recovery?.resumeState);
    if (!resumeState) return 'attention';
    state = resumeState;
  }
  if (DISPATCHABLE_STATES.has(state)) return 'dispatch';
  if (RECONCILE_STATES.has(state)) return 'reconcile';
  if (FINALIZE_STATES.has(state)) return 'finalize';
  if (CANCEL_STATES.has(state)) return 'cancel';
  return 'attention';
}

function createOperationCoordinator(journal) {
  if (!journal || typeof journal.prepare !== 'function' || typeof journal.entries !== 'function') {
    throw coordinatorError('operation_coordination_journal_required', 'An operation journal is required.');
  }

  function coordinatedEntries() {
    return journal.entries()
      .map(([, operation]) => operation)
      .filter((operation) => coordinationFor(operation));
  }

  function findChildren(parentOperationId, profileId) {
    const parentId = canonicalUuid(parentOperationId, 'Parent operation ID');
    const owner = cleanString(profileId);
    if (!owner) throw coordinatorError('operation_coordination_profile_required', 'A profile ID is required.');
    return coordinatedEntries()
      .filter((operation) => {
        const coordination = validateCoordinatedOperation(operation);
        return coordination.parentOperationId === parentId && operation.profileId === owner;
      })
      .sort((left, right) => {
        const leftCoordination = coordinationFor(left);
        const rightCoordination = coordinationFor(right);
        return leftCoordination.ordinal - rightCoordination.ordinal || left.ordinal - right.ordinal;
      });
  }

  function prepareChild(source) {
    const id = canonicalUuid(source?.id, 'Child operation ID');
    const parentOperationId = canonicalUuid(source?.parentOperationId, 'Parent operation ID');
    const profileId = cleanString(source?.profileId);
    if (!profileId) throw coordinatorError('operation_coordination_profile_required', 'A profile ID is required.');
    const family = normalizeFamily(source?.family);
    const relation = normalizeRelation(source?.relation);
    const ordinal = normalizeOrdinal(source?.ordinal);
    const dependsOn = normalizeDependencies(source?.dependsOn);
    if (source?.request && Object.prototype.hasOwnProperty.call(source.request, 'coordination')) {
      throw coordinatorError('operation_coordination_request_reserved', 'The request.coordination field is reserved for durable orchestration metadata.');
    }
    const intent = coordinatedIntent(source, {
      family,
      parentOperationId,
      relation,
      ordinal,
      dependsOn,
      required: source?.required !== false,
    });
    const coordination = {
      version: COORDINATION_VERSION,
      family,
      parentOperationId,
      relation,
      ordinal,
      dependsOn,
      required: source?.required !== false,
      intent,
      intentHash: childIntentHash(intent),
    };

    const existing = journal.get(id);
    if (existing) {
      const existingCoordination = validateCoordinatedOperation(existing);
      if (existing.profileId !== profileId || !sameCoordination(existingCoordination, coordination)) {
        throw coordinatorError('operation_coordination_conflict', `Child operation ${id} was already planned with different inputs.`, { operationId: id });
      }
      return existing;
    }

    const siblings = findChildren(parentOperationId, profileId);
    if (siblings.some((operation) => coordinationFor(operation).ordinal === ordinal)) {
      throw coordinatorError('operation_coordination_ordinal_conflict', `Parent ${parentOperationId} already has child ordinal ${ordinal}.`, {
        parentOperationId, ordinal,
      });
    }
    const operationsById = new Map(coordinatedEntries().map((operation) => [operation.id, operation]));
    for (const dependencyId of dependsOn) {
      const dependency = operationsById.get(dependencyId);
      const dependencyCoordination = dependency && validateCoordinatedOperation(dependency);
      if (!dependency || dependency.profileId !== profileId
        || dependencyCoordination.parentOperationId !== parentOperationId
        || dependencyCoordination.family !== family) {
        throw coordinatorError('operation_coordination_dependency_scope', `Dependency ${dependencyId} is outside this parent, profile, or operation family.`, {
          dependencyId, parentOperationId, profileId,
        });
      }
      if (dependencyCoordination.ordinal >= ordinal) {
        throw coordinatorError('operation_coordination_dependency_order', `Dependency ${dependencyId} must precede child ordinal ${ordinal}.`, {
          dependencyId, ordinal,
        });
      }
    }

    return journal.prepare({
      id,
      profileId,
      kind: cleanString(source.kind) || 'child',
      workflow: cleanString(source.workflow),
      graph: cloneJson(source.graph || {}, 'graph'),
      request: Object.assign({}, cloneJson(source.request || {}, 'request'), { coordination }),
      assets: cloneJson(source.assets || [], 'assets'),
    });
  }

  function recoveryPlan(parentOperationId, profileId) {
    const children = findChildren(parentOperationId, profileId);
    const byId = new Map(children.map((operation) => [operation.id, operation]));
    return children
      .filter((operation) => !TERMINAL_STATES.has(operation.state))
      .map((operation) => {
        const coordination = validateCoordinatedOperation(operation);
        const dependencies = coordination.dependsOn.map((id) => byId.get(id));
        const missing = coordination.dependsOn.filter((id) => !byId.has(id));
        if (missing.length) {
          return { operationId: operation.id, action: 'attention', reason: 'dependency_missing', dependencyIds: missing };
        }
        const failed = dependencies.filter((dependency) => ['failed', 'cancelled'].includes(dependency.state));
        if (failed.length) {
          return { operationId: operation.id, action: 'attention', reason: 'dependency_terminal_without_result', dependencyIds: failed.map((entry) => entry.id) };
        }
        const pending = dependencies.filter((dependency) => dependency.state !== 'finalized');
        if (pending.length) {
          return { operationId: operation.id, action: 'wait', reason: 'dependency_pending', dependencyIds: pending.map((entry) => entry.id) };
        }
        return { operationId: operation.id, action: actionForState(operation), reason: `resume_${operation.state}`, dependencyIds: [] };
      });
  }

  function markInterrupted(id, reason = 'Mix Studio restarted during this child operation.') {
    const operation = journal.get(canonicalUuid(id, 'Child operation ID'));
    if (!operation) throw coordinatorError('operation_not_found', `Operation ${id} was not found.`, { operationId: id });
    validateCoordinatedOperation(operation);
    if (TERMINAL_STATES.has(operation.state) || operation.state === 'attention') return operation;
    return journal.transition(operation.id, 'attention', {
      recovery: {
        code: 'coordinated_operation_interrupted',
        reason: cleanString(reason) || 'Mix Studio restarted during this child operation.',
        resumeState: operation.state,
      },
    }, { expectedRevision: operation.revision });
  }

  return {
    prepareChild,
    children: findChildren,
    recoveryPlan,
    markInterrupted,
    validate: validateCoordinatedOperation,
  };
}

module.exports = {
  COORDINATION_VERSION,
  OPERATION_FAMILIES,
  createOperationCoordinator,
  validateCoordinatedOperation,
};
