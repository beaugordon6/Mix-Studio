'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { FakeComfy } = require('./support/fake-comfy');
const { GalleryFinalizationHarness } = require('./support/gallery-finalization-harness');

const CONTENT = Buffer.from('deterministic generated image bytes');
const SECOND_CONTENT = Buffer.from('second deterministic generated image bytes');

async function fixture(t, contents = [CONTENT]) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-finalization-recovery-'));
  const comfy = await new FakeComfy().start();
  const operationId = crypto.randomUUID();
  const promptId = operationId;
  const remoteFilenames = contents.map((_, index) => `fake-comfy-output-${index}.png`);
  comfy.enqueue(promptId);
  comfy.completePrompt(promptId, {
    outputs: {
      save: {
        images: remoteFilenames.map((filename) => ({ filename, subfolder: '', type: 'output' })),
      },
    },
  });
  const makeHarness = () => new GalleryFinalizationHarness({
    root,
    comfyUrl: comfy.url,
    promptId,
    operationId,
    download: async (entry) => {
      const index = remoteFilenames.indexOf(entry.filename);
      assert.notEqual(index, -1, `unexpected remote output ${entry.filename}`);
      return Buffer.from(contents[index]);
    },
  });
  const harness = await GalleryFinalizationHarness.prepare({
    root,
    comfyUrl: comfy.url,
    promptId,
    operationId,
    profileId: 'owner',
    workflow: 'create:krea2-elements',
    contents,
    download: makeHarness().download,
  });
  t.after(async () => {
    await comfy.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, comfy, harness, makeHarness };
}

async function assertExactlyOnce(harness, root) {
  const manifest = harness.manifest();
  const db = harness.db();
  assert.equal(manifest.phase, 'complete');
  assert.equal(manifest.completed, true);
  assert.equal(db.items.length, 1);
  assert.equal(db.history.length, 1);
  assert.equal(db.items[0].id, manifest.outputs[0].itemId);
  assert.equal(db.history[0].id, manifest.outputs[0].historyId);
  assert.equal(db.history[0].itemId, db.items[0].id);
  assert.deepEqual(await fsp.readdir(path.join(root, 'images')), [manifest.outputs[0].filename]);
  assert.deepEqual(await fsp.readFile(path.join(root, 'images', manifest.outputs[0].filename)), CONTENT);
}

async function assertBatchExactlyOnce(harness, root, contents) {
  const manifest = harness.manifest();
  const db = harness.db();
  assert.equal(manifest.phase, 'complete');
  assert.equal(manifest.completed, true);
  assert.deepEqual(manifest.outputs.map((output) => output.outputIndex), [0, 1]);
  assert.deepEqual(db.items.map((item) => item.finalization.outputIndex), [0, 1]);
  assert.deepEqual(db.history.map((entry) => entry.finalization.outputIndex), [0, 1]);
  assert.equal(new Set(db.items.map((item) => item.id)).size, 2);
  assert.equal(new Set(db.history.map((entry) => entry.id)).size, 2);
  assert.deepEqual(db.history.map((entry) => entry.itemId), db.items.map((item) => item.id));

  const files = await fsp.readdir(path.join(root, 'images'));
  assert.equal(files.length, 2);
  for (let index = 0; index < manifest.outputs.length; index += 1) {
    const output = manifest.outputs[index];
    assert.deepEqual(await fsp.readFile(path.join(root, 'images', output.filename)), contents[index]);
  }
}

for (const crashAt of ['after_asset_write', 'after_item_upsert', 'after_history_upsert']) {
  test(`recovery is idempotent after a crash at ${crashAt}`, async (t) => {
    const { root, harness, makeHarness } = await fixture(t);
    await assert.rejects(harness.resume({ crashAt }), (error) => (
      error.code === 'injected_finalization_crash' && error.point === crashAt
    ));

    const recovered = makeHarness();
    await recovered.resume();
    await assertExactlyOnce(recovered, root);
  });
}

test('repeated recovery after completion performs no duplicate writes or upserts', async (t) => {
  const { root, comfy, harness, makeHarness } = await fixture(t);
  await harness.resume();
  const requestsAfterCompletion = comfy.requests.length;

  await makeHarness().resume();
  await makeHarness().resume();
  await assertExactlyOnce(makeHarness(), root);
  assert.equal(comfy.requests.length, requestsAfterCompletion, 'completed manifests do not query Comfy again');
});

test('cancellation before recovery suppresses asset, item, and history finalization', async (t) => {
  const { root, comfy, harness, makeHarness } = await fixture(t);
  harness.requestCancellation();
  const requestsBeforeResume = comfy.requests.length;
  const cancelled = await makeHarness().resume();

  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(comfy.requests.length, requestsBeforeResume, 'cancel tombstone wins before history lookup');
  assert.deepEqual(makeHarness().db(), { items: [], history: [] });
  assert.deepEqual(await fsp.readdir(path.join(root, 'images')), []);
});

test('cancellation after an asset-write crash suppresses all remaining visible catalog effects', async (t) => {
  const { root, harness, makeHarness } = await fixture(t);
  await assert.rejects(harness.resume({ crashAt: 'after_asset_write' }), {
    code: 'injected_finalization_crash',
  });
  assert.equal((await fsp.readdir(path.join(root, 'images'))).length, 1, 'the durable asset already exists');

  const resumed = makeHarness();
  resumed.requestCancellation();
  const cancelled = await makeHarness().resume();
  assert.equal(cancelled.phase, 'cancelled');
  assert.deepEqual(makeHarness().db(), { items: [], history: [] });
});

for (const crashAt of ['after_asset_write', 'after_item_upsert', 'after_history_upsert']) {
  test(`two-output replay preserves order and uniqueness after ${crashAt} between outputs`, async (t) => {
    const contents = [CONTENT, SECOND_CONTENT];
    const { root, harness, makeHarness } = await fixture(t, contents);
    await assert.rejects(harness.resume({ crashAt }), (error) => (
      error.code === 'injected_finalization_crash' && error.point === crashAt
    ));

    const recovered = makeHarness();
    await recovered.resume();
    await recovered.resume();
    await assertBatchExactlyOnce(recovered, root, contents);
  });
}
