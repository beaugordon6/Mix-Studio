'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAtomicJsonDatabaseStore,
  createFileManifestStore,
  createGalleryFinalizationAdapter,
} = require('../lib/gallery-finalization-adapter');
const {
  createGalleryFinalizationManifest,
  hashAsset,
  requestFinalizationCancellation,
} = require('../lib/gallery-finalization');

const OPERATION_ID = '20202020-3030-4040-8050-606060606060';
const CONTENT = Buffer.from('durable generated image');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-gallery-finalize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaDirectory = path.join(root, 'images');
  const manifestDirectory = path.join(root, 'finalization');
  const databaseFile = path.join(root, 'db.json');
  const manifestStore = createFileManifestStore(manifestDirectory);
  const databaseStore = createAtomicJsonDatabaseStore(databaseFile, {
    initialValue: { profiles: [{ id: 'owner' }], items: [], history: [] },
  });
  const adapter = createGalleryFinalizationAdapter({
    mediaDirectory,
    manifestStore,
    databaseStore,
    fault: options.fault,
  });
  const manifest = createGalleryFinalizationManifest({
    operationId: OPERATION_ID,
    profileId: 'owner',
    workflow: 'create:krea2-elements',
    createdAt: 1234,
    outputs: [{
      outputIndex: 0,
      kind: 'image',
      role: 'output',
      extension: '.png',
      sha256: hashAsset(CONTENT),
      bytes: CONTENT.length,
    }],
  });
  const request = {
    manifest,
    outputs: [{
      outputIndex: 0,
      content: CONTENT,
      item: { mode: 't2i', prompt: 'Hermes on grey', createdAt: 1234 },
      history: { kind: 'gen', label: 'Create: Hermes', ts: 1234 },
    }],
  };
  return { root, mediaDirectory, manifestStore, databaseStore, adapter, manifest, request };
}

test('commits a deterministic asset, item, history, and completed checkpoint', async (t) => {
  const value = fixture(t);
  const result = await value.adapter.finalize(value.request);
  assert.equal(result.status, 'complete');
  assert.equal(result.manifest.phase, 'complete');
  const output = result.manifest.outputs[0];
  assert.deepEqual(await fs.promises.readFile(path.join(value.mediaDirectory, output.filename)), CONTENT);
  const database = await value.databaseStore.load();
  assert.equal(database.profiles[0].id, 'owner');
  assert.equal(database.items.length, 1);
  assert.equal(database.history.length, 1);
  assert.equal(database.items[0].id, output.itemId);
  assert.equal(database.history[0].id, output.historyId);
  assert.equal(database.history[0].itemId, output.itemId);
  assert.equal((await value.manifestStore.load(OPERATION_ID)).completed, true);
});

test('replay after an asset commit crash reuses bytes and inserts records once', async (t) => {
  let crash = true;
  const value = fixture(t, {
    fault(point) {
      if (point === 'after_asset_commit' && crash) {
        crash = false;
        throw new Error('simulated process loss');
      }
    },
  });
  await assert.rejects(value.adapter.finalize(value.request), /simulated process loss/);
  const checkpoint = await value.manifestStore.load(OPERATION_ID);
  assert.equal(checkpoint.outputs[0].assetState, 'pending');
  assert.equal(fs.existsSync(path.join(value.mediaDirectory, checkpoint.outputs[0].filename)), true);

  const resumed = await value.adapter.finalize(value.request);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.manifest.outputs[0].assetState, 'reused');
  const database = await value.databaseStore.load();
  assert.equal(database.items.length, 1);
  assert.equal(database.history.length, 1);
});

test('replay after a database commit crash discovers records and never duplicates them', async (t) => {
  let crash = true;
  const value = fixture(t, {
    fault(point) {
      if (point === 'after_database_commit' && crash) {
        crash = false;
        throw new Error('simulated process loss');
      }
    },
  });
  await assert.rejects(value.adapter.finalize(value.request), /simulated process loss/);
  let database = await value.databaseStore.load();
  assert.equal(database.items.length, 1);
  assert.equal(database.history.length, 1);
  assert.equal((await value.manifestStore.load(OPERATION_ID)).outputs[0].itemState, 'pending');

  const resumed = await value.adapter.finalize(value.request);
  assert.equal(resumed.status, 'complete');
  database = await value.databaseStore.load();
  assert.equal(database.items.length, 1);
  assert.equal(database.history.length, 1);
});

test('an existing deterministic filename with different bytes stops for attention', async (t) => {
  const value = fixture(t);
  const output = value.manifest.outputs[0];
  fs.mkdirSync(value.mediaDirectory, { recursive: true });
  fs.writeFileSync(path.join(value.mediaDirectory, output.filename), 'different bytes');
  const result = await value.adapter.finalize(value.request);
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'asset_identity_mismatch');
  assert.equal(String(fs.readFileSync(path.join(value.mediaDirectory, output.filename))), 'different bytes');
  const database = await value.databaseStore.load();
  assert.equal(database.items.length, 0);
});

test('a history identity conflict does not partially insert its gallery item', async (t) => {
  const value = fixture(t);
  const output = value.manifest.outputs[0];
  await value.databaseStore.transaction((database) => {
    database.history = [{
      id: output.historyId,
      itemId: output.itemId,
      profileId: 'other-profile',
      finalization: {
        version: 1,
        operationId: OPERATION_ID,
        outputIndex: 0,
        assetId: output.assetId,
        filename: output.filename,
        sha256: output.sha256,
        bytes: output.bytes,
      },
    }];
  });
  const result = await value.adapter.finalize(value.request);
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'history_identity_mismatch');
  const database = await value.databaseStore.load();
  assert.equal(database.items.length, 0);
  assert.equal(database.history.length, 1);
  assert.equal(database.history[0].profileId, 'other-profile');
});

test('cancellation is durable and suppresses all filesystem and database writes', async (t) => {
  const value = fixture(t);
  const cancelledRequest = {
    ...value.request,
    manifest: requestFinalizationCancellation(value.manifest),
  };
  const result = await value.adapter.finalize(cancelledRequest);
  assert.equal(result.status, 'cancelled');
  assert.equal(fs.existsSync(value.mediaDirectory), false);
  assert.equal(fs.existsSync(path.join(value.root, 'db.json')), false);
  assert.equal((await value.manifestStore.load(OPERATION_ID)).cancelRequested, true);
});

test('a resumed manifest rejects changed output identity before side effects', async (t) => {
  const value = fixture(t);
  await value.manifestStore.save(value.manifest);
  const changed = createGalleryFinalizationManifest({
    operationId: OPERATION_ID,
    profileId: 'owner',
    workflow: 'create:krea2-elements',
    outputs: [{
      outputIndex: 0,
      kind: 'image',
      extension: '.png',
      sha256: hashAsset(Buffer.from('a changed output')),
      bytes: Buffer.byteLength('a changed output'),
    }],
  });
  await assert.rejects(
    value.adapter.finalize({ ...value.request, manifest: changed }),
    { code: 'gallery_finalization_manifest_conflict' },
  );
  assert.equal(fs.existsSync(value.mediaDirectory), false);
});
