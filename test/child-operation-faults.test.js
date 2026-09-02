'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { FakeComfy } = require('./support/fake-comfy');
const { ChildOperationHarness } = require('./support/child-operation-harness');
const { GalleryFinalizationHarness } = require('./support/gallery-finalization-harness');

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-child-operation-'));
  const comfy = await new FakeComfy().start();
  const harness = new ChildOperationHarness({ root, comfyUrl: comfy.url });
  t.after(async () => {
    await comfy.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, comfy, harness };
}

function receipt(role, overrides = {}) {
  return {
    childOperationId: crypto.randomUUID(),
    parentOperationId: crypto.randomUUID(),
    profileId: 'owner',
    workflow: `test.${role}@1`,
    role,
    index: 0,
    ...overrides,
  };
}

test('child receipts atomically preserve FIFO identity, profile, role, and dependency metadata before Comfy I/O', async (t) => {
  const { comfy, harness } = await fixture(t);
  const cases = [
    receipt('post-upscale', { sourceItemId: 'item-1', options: { resolution: 2160 } }),
    receipt('edit-step', { index: 1, sourceItemId: 'step-0-item' }),
    receipt('smart-step', { smartRunId: 'run-1', smartStepId: 'scene-2', dependsOn: ['reference-1'] }),
    receipt('strength-hunt', { options: { variantCount: 5 } }),
  ];
  for (const entry of cases) harness.prepare(entry);

  assert.equal(comfy.requests.length, 0, 'all receipts exist before the first external observation or submit');
  const operations = harness.journal().active();
  assert.deepEqual(operations.map((operation) => operation.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(operations.map((operation) => operation.id), cases.map((entry) => entry.childOperationId));
  assert.deepEqual(operations.map((operation) => operation.profileId), cases.map(() => 'owner'));
  assert.deepEqual(operations.map((operation) => operation.request.role), cases.map((entry) => entry.role));
  assert.deepEqual(operations[2].request.dependsOn, ['reference-1']);
});

test('post-upscale adopts an accepted child after a dropped response without duplicate submission', async (t) => {
  const { comfy, harness } = await fixture(t);
  const operation = receipt('post-upscale', {
    sourceItemId: 'source-gallery-item',
    options: { engine: 'seedvr2', resolution: 2160 },
  });
  harness.prepare(operation);
  comfy.fault('prompt.afterAccept', 'drop');

  const ambiguous = await harness.reconcile(operation.childOperationId);
  assert.equal(ambiguous.action, 'ambiguous');
  assert.equal(harness.get(operation.childOperationId).state, 'attention');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);

  const recovered = await harness.reconcile(operation.childOperationId);
  assert.equal(recovered.action, 'adopted');
  assert.equal(recovered.operation.request.sourceItemId, 'source-gallery-item');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);
});

test('edit sequence adopts the exact step after a crash between acknowledgement and local transition', async (t) => {
  const { comfy, harness } = await fixture(t);
  const operation = receipt('edit-step', {
    index: 2,
    sourceItemId: 'sequence-step-1-result',
    options: { sequenceId: 'sequence-a', prompt: 'third edit' },
  });
  harness.prepare(operation);

  await assert.rejects(
    harness.reconcile(operation.childOperationId, { crashAt: 'after_submit_ack' }),
    { code: 'injected_child_operation_crash', point: 'after_submit_ack' },
  );
  assert.equal(harness.get(operation.childOperationId).state, 'submitting');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);

  const recovered = await harness.reconcile(operation.childOperationId);
  assert.equal(recovered.action, 'adopted');
  assert.equal(recovered.operation.request.index, 2);
  assert.equal(recovered.operation.request.options.sequenceId, 'sequence-a');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);
});

test('Smart step retries only after authoritative absence and keeps its dependency edge', async (t) => {
  const { comfy, harness } = await fixture(t);
  const operation = receipt('smart-step', {
    smartRunId: 'smart-run-a',
    smartStepId: 'video-2',
    dependsOn: ['character-reference', 'location-reference'],
  });
  harness.prepare(operation);
  comfy.fault('prompt.beforeAccept', 'drop');

  const ambiguous = await harness.reconcile(operation.childOperationId);
  assert.equal(ambiguous.action, 'ambiguous');
  assert.equal(comfy.submissionCount(operation.childOperationId), 0);

  const retried = await harness.reconcile(operation.childOperationId);
  assert.equal(retried.action, 'submitted');
  assert.deepEqual(retried.operation.request.dependsOn, ['character-reference', 'location-reference']);
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);

  comfy.completePrompt(operation.childOperationId, { outputs: { save: { images: [] } } });
  const completed = await harness.reconcile(operation.childOperationId);
  assert.equal(completed.action, 'finalize');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);
});

test('a child cancellation tombstone suppresses completion discovered after restart', async (t) => {
  const { comfy, harness } = await fixture(t);
  const operation = receipt('post-upscale');
  harness.prepare(operation);
  await harness.reconcile(operation.childOperationId);
  harness.journal().requestCancellation(operation.childOperationId, { reason: 'parent cancelled' });
  comfy.completePrompt(operation.childOperationId, { outputs: { save: { images: [] } } });

  const recovered = await harness.reconcile(operation.childOperationId);
  assert.equal(recovered.action, 'suppressed');
  assert.equal(recovered.operation.state, 'cancelled');
  assert.equal(comfy.submissionCount(operation.childOperationId), 1);
});

test('Strength Hunt variant outputs remain ordered and unique after a crash between outputs', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-strength-hunt-replay-'));
  const comfy = await new FakeComfy().start();
  const operationId = crypto.randomUUID();
  const contents = [Buffer.from('variant-0'), Buffer.from('variant-1'), Buffer.from('variant-2')];
  const filenames = ['strength_hunt_000.png', 'strength_hunt_001.png', 'strength_hunt_002.png'];
  comfy.enqueue(operationId);
  comfy.completePrompt(operationId, {
    outputs: { save: { images: filenames.map((filename) => ({ filename, subfolder: '', type: 'output' })) } },
  });
  const download = async (entry) => Buffer.from(contents[filenames.indexOf(entry.filename)]);
  const options = {
    root,
    comfyUrl: comfy.url,
    promptId: operationId,
    operationId,
    profileId: 'owner',
    workflow: 'create.strength-hunt@1',
    contents,
    download,
  };
  const harness = await GalleryFinalizationHarness.prepare(options);
  t.after(async () => {
    await comfy.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(harness.resume({ crashAt: 'after_history_upsert' }), {
    code: 'injected_finalization_crash',
  });
  const recovered = new GalleryFinalizationHarness(options);
  await recovered.resume();
  await recovered.resume();

  const manifest = recovered.manifest();
  const db = recovered.db();
  assert.deepEqual(manifest.outputs.map((output) => output.outputIndex), [0, 1, 2]);
  assert.deepEqual(db.items.map((item) => item.finalization.outputIndex), [0, 1, 2]);
  assert.deepEqual(db.history.map((entry) => entry.finalization.outputIndex), [0, 1, 2]);
  assert.equal(new Set(db.items.map((item) => item.id)).size, 3);
  assert.equal(new Set(db.history.map((entry) => entry.id)).size, 3);
});
