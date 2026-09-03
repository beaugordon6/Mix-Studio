'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { createOperationJournal } = require('../lib/operation-journal');
const { createOperationCoordinator } = require('../lib/operation-coordinator');

const IDS = {
  editParent: '10000000-0000-4000-8000-000000000000',
  edit0: '10000000-0000-4000-8000-000000000001',
  edit1: '10000000-0000-4000-8000-000000000002',
  smartParent: '20000000-0000-4000-8000-000000000000',
  smartRef: '20000000-0000-4000-8000-000000000001',
  smartImage: '20000000-0000-4000-8000-000000000002',
  smartVideo: '20000000-0000-4000-8000-000000000003',
  attempt: '30000000-0000-4000-8000-000000000001',
};

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-operation-coordinator-'));
  const file = path.join(root, 'operations.json');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, file };
}

function coordinator(file) {
  const journal = createOperationJournal(file);
  return { journal, coordinator: createOperationCoordinator(journal) };
}

function child(overrides = {}) {
  return {
    id: IDS.edit0,
    parentOperationId: IDS.editParent,
    profileId: 'owner',
    family: 'edit_sequence',
    relation: 'edit_step',
    ordinal: 0,
    workflow: 'edit.krea2@1',
    graph: { output: { class_type: 'SaveImage', inputs: {} } },
    request: { prompt: 'First edit', seed: 42 },
    assets: [],
    ...overrides,
  };
}

function finalize(journal, id) {
  journal.beginSubmission(id, { attemptId: IDS.attempt });
  journal.markSubmitted(id, { attemptId: IDS.attempt });
  journal.transition(id, 'running');
  journal.transition(id, 'output_ready');
  journal.transition(id, 'finalizing');
  journal.transition(id, 'finalized', { finalization: { itemIds: [`item-${id}`] } });
}

test('edit sequence recovery dispatches only the next dependency-ready step after restart', async (t) => {
  const { file } = await fixture(t);
  let current = coordinator(file);
  current.coordinator.prepareChild(child());
  current.coordinator.prepareChild(child({
    id: IDS.edit1,
    ordinal: 1,
    dependsOn: [IDS.edit0],
    request: { prompt: 'Second edit', seed: 43, sourceFrom: IDS.edit0 },
  }));

  assert.deepEqual(current.coordinator.recoveryPlan(IDS.editParent, 'owner'), [
    { operationId: IDS.edit0, action: 'dispatch', reason: 'resume_prepared', dependencyIds: [] },
    { operationId: IDS.edit1, action: 'wait', reason: 'dependency_pending', dependencyIds: [IDS.edit0] },
  ]);

  finalize(current.journal, IDS.edit0);
  current = coordinator(file); // process restart
  assert.deepEqual(current.coordinator.recoveryPlan(IDS.editParent, 'owner'), [
    { operationId: IDS.edit1, action: 'dispatch', reason: 'resume_prepared', dependencyIds: [] },
  ]);
  assert.equal(current.coordinator.children(IDS.editParent, 'owner')[1].request.prompt, 'Second edit');
  assert.equal(current.coordinator.children(IDS.editParent, 'owner')[1].request.coordination.intentHash.length, 64);
});

test('Smart DAG preserves dependency edges and stable child IDs across restart', async (t) => {
  const { file } = await fixture(t);
  let current = coordinator(file);
  current.coordinator.prepareChild(child({
    id: IDS.smartRef,
    parentOperationId: IDS.smartParent,
    family: 'smart',
    relation: 'reference',
    workflow: 'smart.reference@1',
  }));
  current.coordinator.prepareChild(child({
    id: IDS.smartImage,
    parentOperationId: IDS.smartParent,
    family: 'smart',
    relation: 'image',
    ordinal: 1,
    dependsOn: [IDS.smartRef],
    workflow: 'smart.image@1',
  }));
  current.coordinator.prepareChild(child({
    id: IDS.smartVideo,
    parentOperationId: IDS.smartParent,
    family: 'smart',
    relation: 'video',
    ordinal: 2,
    dependsOn: [IDS.smartRef, IDS.smartImage],
    workflow: 'smart.video@1',
  }));

  finalize(current.journal, IDS.smartRef);
  current.journal.beginSubmission(IDS.smartImage, { attemptId: IDS.attempt });
  current = coordinator(file); // crash after the durable pre-submit checkpoint

  assert.deepEqual(current.coordinator.recoveryPlan(IDS.smartParent, 'owner'), [
    { operationId: IDS.smartImage, action: 'reconcile', reason: 'resume_submitting', dependencyIds: [] },
    { operationId: IDS.smartVideo, action: 'wait', reason: 'dependency_pending', dependencyIds: [IDS.smartImage] },
  ]);
  assert.equal(current.journal.get(IDS.smartImage).submission.comfyPromptId, IDS.smartImage);
  assert.equal(current.journal.get(IDS.smartImage).submission.attempt, 1);
});

test('interrupted finalization resumes finalization rather than dispatching a duplicate', async (t) => {
  const { file } = await fixture(t);
  let current = coordinator(file);
  current.coordinator.prepareChild(child());
  current.journal.beginSubmission(IDS.edit0, { attemptId: IDS.attempt });
  current.journal.markSubmitted(IDS.edit0, { attemptId: IDS.attempt });
  current.journal.transition(IDS.edit0, 'output_ready');
  current.journal.transition(IDS.edit0, 'finalizing');
  current.coordinator.markInterrupted(IDS.edit0, 'Crash during gallery commit');

  current = coordinator(file);
  assert.deepEqual(current.coordinator.recoveryPlan(IDS.editParent, 'owner'), [{
    operationId: IDS.edit0,
    action: 'finalize',
    reason: 'resume_attention',
    dependencyIds: [],
  }]);
  assert.equal(current.journal.get(IDS.edit0).recovery.resumeState, 'finalizing');
});

test('durable cancellation wins after restart and never becomes a dispatch action', async (t) => {
  const { file } = await fixture(t);
  let current = coordinator(file);
  current.coordinator.prepareChild(child());
  current.journal.requestCancellation(IDS.edit0, { reason: 'Parent was cancelled' });
  current = coordinator(file);

  assert.deepEqual(current.coordinator.recoveryPlan(IDS.editParent, 'owner'), [{
    operationId: IDS.edit0,
    action: 'cancel',
    reason: 'resume_cancel_requested',
    dependencyIds: [],
  }]);
  assert.equal(current.journal.get(IDS.edit0).cancellation.reason, 'Parent was cancelled');
});

test('planning is idempotent for identical intent and rejects drift under the same child ID', async (t) => {
  const { file } = await fixture(t);
  const current = coordinator(file);
  const first = current.coordinator.prepareChild(child());
  const replay = current.coordinator.prepareChild(child());
  assert.equal(replay.id, first.id);
  assert.equal(current.journal.entries().length, 1);

  assert.throws(
    () => current.coordinator.prepareChild(child({ request: { prompt: 'Changed after crash', seed: 42 } })),
    { code: 'operation_coordination_conflict' },
  );

  const operation = current.journal.get(IDS.edit0);
  current.journal.transition(IDS.edit0, 'attention', {
    request: { ...operation.request, prompt: 'Bypass attempt' },
  });
  assert.throws(
    () => current.coordinator.validate(current.journal.get(IDS.edit0)),
    { code: 'operation_coordination_intent_mismatch' },
  );
});

test('normalized durable assets remain part of the immutable coordinated intent', async (t) => {
  const { file } = await fixture(t);
  const current = coordinator(file);
  const operation = current.coordinator.prepareChild(child({
    assets: [{ logicalName: 'source.png', sha256: 'a'.repeat(64), bytes: 123 }],
  }));
  assert.equal(operation.assets[0].profileId, 'owner');
  assert.equal(current.coordinator.validate(operation).intentHash.length, 64);
  assert.throws(() => current.coordinator.prepareChild(child({
    id: IDS.edit1,
    ordinal: 1,
    request: { coordination: {} },
  })), { code: 'operation_coordination_request_reserved' });
});

test('dependencies cannot cross profile, parent, family, or forward in ordinal order', async (t) => {
  const { file } = await fixture(t);
  const current = coordinator(file);
  current.coordinator.prepareChild(child());

  assert.throws(() => current.coordinator.prepareChild(child({
    id: IDS.edit1,
    profileId: 'other-profile',
    ordinal: 1,
    dependsOn: [IDS.edit0],
  })), { code: 'operation_coordination_dependency_scope' });
  assert.throws(() => current.coordinator.prepareChild(child({
    id: IDS.edit1,
    parentOperationId: IDS.smartParent,
    ordinal: 1,
    dependsOn: [IDS.edit0],
  })), { code: 'operation_coordination_dependency_scope' });
  assert.throws(() => current.coordinator.prepareChild(child({
    id: IDS.edit1,
    family: 'smart',
    ordinal: 1,
    dependsOn: [IDS.edit0],
  })), { code: 'operation_coordination_dependency_scope' });
  assert.throws(() => current.coordinator.prepareChild(child({
    id: IDS.edit1,
    ordinal: 0,
    dependsOn: [IDS.edit0],
  })), { code: 'operation_coordination_ordinal_conflict' });
});

test('failed required dependency produces attention instead of silently skipping ahead', async (t) => {
  const { file } = await fixture(t);
  const current = coordinator(file);
  current.coordinator.prepareChild(child());
  current.coordinator.prepareChild(child({ id: IDS.edit1, ordinal: 1, dependsOn: [IDS.edit0] }));
  current.journal.transition(IDS.edit0, 'failed', { recovery: { code: 'test_failure' } });

  assert.deepEqual(current.coordinator.recoveryPlan(IDS.editParent, 'owner'), [{
    operationId: IDS.edit1,
    action: 'attention',
    reason: 'dependency_terminal_without_result',
    dependencyIds: [IDS.edit0],
  }]);
});
