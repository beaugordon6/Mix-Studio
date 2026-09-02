'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  attachmentIdentity,
  createCatalogAttachmentFinalizer,
  createCatalogAttachmentReceipt,
  createFileCatalogAttachmentReceiptStore,
  validateCatalogAttachmentReceipt,
} = require('../lib/catalog-attachment-finalizer');
const { createAtomicJsonDatabaseStore } = require('../lib/gallery-finalization-adapter');
const { hashAsset } = require('../lib/gallery-finalization');

const OPERATION_ID = '780d9cc9-a18f-452d-8ccd-a21a60bfea89';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-catalog-attachment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaDirectory = path.join(root, 'images');
  const receiptDirectory = path.join(root, 'receipts');
  const dbFile = path.join(root, 'db.json');
  const oldUpscale = options.oldUpscale === undefined ? 'prior-upscale.png' : options.oldUpscale;
  const initialDb = {
    items: [{
      id: 'item-1',
      profileId: 'owner',
      file: 'source.png',
      upscaled: oldUpscale,
      upscaleInfo: { engine: 'old' },
    }],
    history: [],
  };
  const databaseStore = createAtomicJsonDatabaseStore(dbFile, { initialValue: initialDb });
  const receiptStore = createFileCatalogAttachmentReceiptStore(receiptDirectory);
  const content = Buffer.from('complete replacement upscale bytes');
  const request = {
    operationId: OPERATION_ID,
    strategy: 'replace_upscale',
    profileId: 'owner',
    target: {
      itemId: 'item-1',
      sourceVersion: { file: 'source.png', attachment: oldUpscale },
    },
    output: {
      kind: 'image', role: 'upscale', extension: '.png', content,
      sha256: hashAsset(content), bytes: content.length,
    },
    attachment: { upscaleInfo: { engine: 'seedvr2', resolution: 2160 }, durationMs: 1234 },
    history: { kind: 'upscale', label: 'Upscaled: fixture', ts: 4567 },
    createdAt: 4567,
  };
  const makeFinalizer = (fault) => createCatalogAttachmentFinalizer({
    mediaDirectory,
    receiptStore,
    databaseStore,
    fault,
  });
  return { root, mediaDirectory, receiptStore, databaseStore, request, content, makeFinalizer, oldUpscale };
}

async function database(value) {
  return value.databaseStore.load();
}

test('operation-scoped asset, receipt, and history identities are deterministic and path-safe', () => {
  const first = attachmentIdentity(OPERATION_ID, '.png');
  const second = attachmentIdentity(OPERATION_ID.toUpperCase(), 'png');
  assert.deepEqual(first, second);
  assert.match(first.filename, /^[0-9a-f]{24}\.png$/);
  assert.match(first.receiptId, /^[0-9a-f]{16}$/);
  assert.match(first.historyId, /^[0-9a-f]{16}$/);
  assert.notEqual(first.receiptId, first.historyId);
});

test('receipt validation binds target version, output digest, and deterministic identities', () => {
  const content = Buffer.from('asset');
  const receipt = createCatalogAttachmentReceipt({
    operationId: OPERATION_ID,
    strategy: 'replace_upscale',
    profileId: 'owner',
    target: { itemId: 'item-1', sourceVersion: { file: 'source.png', attachment: null } },
    output: { extension: '.png', sha256: hashAsset(content), bytes: content.length },
  });
  assert.equal(validateCatalogAttachmentReceipt(receipt), receipt);
  assert.throws(
    () => validateCatalogAttachmentReceipt({ ...receipt, historyId: 'changed' }),
    { code: 'catalog_attachment_receipt_invalid' },
  );
  assert.throws(
    () => createCatalogAttachmentReceipt({
      operationId: OPERATION_ID,
      profileId: 'owner',
      target: { itemId: 'item-1', sourceVersion: { file: 'source.png' } },
      output: { sha256: 'bad', bytes: content.length },
    }),
    { code: 'catalog_attachment_hash_invalid' },
  );
});

test('replace_upscale publishes immutably and atomically switches catalog and history once', async (t) => {
  const value = fixture(t);
  await value.databaseStore.transaction((db) => {
    db.items[0].upscalePending = true;
    db.items[0].upscalePendingOperationId = OPERATION_ID;
  });
  fs.mkdirSync(value.mediaDirectory, { recursive: true });
  fs.writeFileSync(path.join(value.mediaDirectory, value.oldUpscale), 'prior bytes');
  const result = await value.makeFinalizer().finalize(value.request);
  assert.equal(result.status, 'complete');
  const db = await database(value);
  const item = db.items[0];
  assert.equal(item.upscaled, result.receipt.output.filename);
  assert.deepEqual(item.upscaleInfo, value.request.attachment.upscaleInfo);
  assert.equal(item.upscaleDurationMs, 1234);
  assert.equal(item.upscalePending, false);
  assert.equal(item.upscalePendingOperationId, undefined);
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].id, result.receipt.historyId);
  assert.equal(db.history[0].itemId, item.id);
  assert.equal(fs.readFileSync(path.join(value.mediaDirectory, item.upscaled), 'utf8'), value.content.toString());
  assert.equal(fs.readFileSync(path.join(value.mediaDirectory, value.oldUpscale), 'utf8'), 'prior bytes');
});

test('the prior attachment remains selected until the atomic database commit', async (t) => {
  const value = fixture(t);
  const stop = new Error('stop after asset checkpoint');
  await assert.rejects(value.makeFinalizer(async (point) => {
    if (point === 'after_asset_checkpoint') throw stop;
  }).finalize(value.request), stop);
  const db = await database(value);
  assert.equal(db.items[0].upscaled, value.oldUpscale);
  assert.equal(db.history.length, 0);
  const identity = attachmentIdentity(OPERATION_ID, '.png');
  assert.equal(fs.readFileSync(path.join(value.mediaDirectory, identity.filename), 'utf8'), value.content.toString());
});

for (const crashPoint of ['after_asset_commit', 'after_asset_checkpoint', 'after_database_commit', 'after_database_checkpoint']) {
  test(`replay after ${crashPoint} is idempotent`, async (t) => {
    const value = fixture(t);
    const crash = new Error(`injected ${crashPoint}`);
    crash.code = 'injected_crash';
    await assert.rejects(value.makeFinalizer(async (point) => {
      if (point === crashPoint) throw crash;
    }).finalize(value.request), crash);
    const result = await value.makeFinalizer().finalize(value.request);
    assert.equal(result.status, 'complete');
    const db = await database(value);
    assert.equal(db.items.length, 1);
    assert.equal(db.items[0].upscaled, result.receipt.output.filename);
    assert.equal(db.history.length, 1);
    assert.equal(db.history[0].id, result.receipt.historyId);
    assert.equal(fs.readdirSync(value.mediaDirectory).filter((name) => !name.startsWith('.')).length, 1);
  });
}

test('repeated completion reuses the same asset and catalog records', async (t) => {
  const value = fixture(t);
  const first = await value.makeFinalizer().finalize(value.request);
  const second = await value.makeFinalizer().finalize({
    ...value.request,
    output: { ...value.request.output, content: undefined },
  });
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(second.status, 'complete');
  const db = await database(value);
  assert.equal(db.items.length, 1);
  assert.equal(db.history.length, 1);
});

test('catalog attachment history keeps the same bounded retention as the gallery', async (t) => {
  const value = fixture(t);
  await value.databaseStore.transaction((db) => {
    db.history = Array.from({ length: 50 }, (_, index) => ({ id: `old-${index}` }));
  });
  const result = await value.makeFinalizer().finalize(value.request);
  assert.equal(result.status, 'complete');
  const db = await database(value);
  assert.equal(db.history.length, 50);
  assert.equal(db.history[0].id, result.receipt.historyId);
  assert.equal(db.history.some((entry) => entry.id === 'old-49'), false);
});

test('catalog attachment history limit must be a positive integer', (t) => {
  const value = fixture(t);
  assert.throws(() => createCatalogAttachmentFinalizer({
    mediaDirectory: value.mediaDirectory,
    receiptStore: value.receiptStore,
    databaseStore: value.databaseStore,
    historyLimit: 0,
  }), { code: 'catalog_attachment_history_limit_invalid' });
});

test('a later operation can replace an operation-scoped upscale only from its exact receipt version', async (t) => {
  const value = fixture(t, { oldUpscale: null });
  const first = await value.makeFinalizer().finalize(value.request);
  const nextContent = Buffer.from('second upscale');
  const nextOperationId = '4b96849f-122b-4ab7-a107-765c8340579e';
  const next = {
    ...value.request,
    operationId: nextOperationId,
    target: {
      itemId: 'item-1',
      sourceVersion: {
        file: 'source.png',
        attachment: first.receipt.output.filename,
        receiptId: first.receipt.receiptId,
      },
    },
    output: {
      ...value.request.output,
      content: nextContent,
      sha256: hashAsset(nextContent),
      bytes: nextContent.length,
    },
  };
  const result = await value.makeFinalizer().finalize(next);
  assert.equal(result.status, 'complete');
  const db = await database(value);
  assert.equal(db.items[0].upscaled, result.receipt.output.filename);
  assert.equal(db.items[0].upscaleReceipt.receiptId, result.receipt.receiptId);
  assert.equal(db.history.length, 2);
  assert.equal(fs.existsSync(path.join(value.mediaDirectory, first.receipt.output.filename)), true);
  assert.equal(fs.existsSync(path.join(value.mediaDirectory, result.receipt.output.filename)), true);
});

test('a stale or omitted prior receipt version cannot replace an operation-scoped upscale', async (t) => {
  const value = fixture(t, { oldUpscale: null });
  const first = await value.makeFinalizer().finalize(value.request);
  const nextContent = Buffer.from('stale replacement');
  const result = await value.makeFinalizer().finalize({
    ...value.request,
    operationId: '28dbb8a2-91fb-4487-97fe-cc37b7de16ed',
    target: {
      itemId: 'item-1',
      sourceVersion: { file: 'source.png', attachment: first.receipt.output.filename },
    },
    output: {
      ...value.request.output,
      content: nextContent,
      sha256: hashAsset(nextContent),
      bytes: nextContent.length,
    },
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'source_receipt_version_mismatch');
  assert.equal((await database(value)).items[0].upscaled, first.receipt.output.filename);
});

test('replay repairs a pruned deterministic history record without replacing the asset again', async (t) => {
  const value = fixture(t);
  const first = await value.makeFinalizer().finalize(value.request);
  const saved = await value.receiptStore.load(OPERATION_ID);
  saved.completed = false;
  saved.phase = 'asset_ready';
  saved.catalogState = 'pending';
  saved.historyState = 'pending';
  await value.receiptStore.save(saved);
  await value.databaseStore.transaction((db) => { db.history = []; });
  const result = await value.makeFinalizer().finalize(value.request);
  assert.equal(result.status, 'complete');
  const db = await database(value);
  assert.equal(db.items[0].upscaled, first.receipt.output.filename);
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].id, first.receipt.historyId);
});

test('cancellation before publication suppresses every visible effect', async (t) => {
  const value = fixture(t);
  const result = await value.makeFinalizer().finalize({ ...value.request, cancelRequested: true });
  assert.equal(result.status, 'cancelled');
  assert.equal(fs.existsSync(value.mediaDirectory), false);
  const db = await database(value);
  assert.equal(db.items[0].upscaled, value.oldUpscale);
  assert.equal(db.history.length, 0);
});

test('cancellation after an asset crash leaves the published bytes invisible', async (t) => {
  const value = fixture(t);
  const crash = new Error('asset crash');
  await assert.rejects(value.makeFinalizer(async (point) => {
    if (point === 'after_asset_commit') throw crash;
  }).finalize(value.request), crash);
  const result = await value.makeFinalizer().finalize({ ...value.request, cancelRequested: true });
  assert.equal(result.status, 'cancelled');
  const db = await database(value);
  assert.equal(db.items[0].upscaled, value.oldUpscale);
  assert.equal(db.history.length, 0);
  assert.equal(fs.existsSync(path.join(value.mediaDirectory, attachmentIdentity(OPERATION_ID).filename)), true);
});

test('cancellation discovered after a database-boundary crash preserves the committed attachment', async (t) => {
  const value = fixture(t);
  const crash = new Error('database crash');
  await assert.rejects(value.makeFinalizer(async (point) => {
    if (point === 'after_database_commit') throw crash;
  }).finalize(value.request), crash);
  const result = await value.makeFinalizer().finalize({ ...value.request, cancelRequested: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.receipt.lateCancellation, true);
  const db = await database(value);
  assert.equal(db.items[0].upscaled, result.receipt.output.filename);
  assert.equal(db.history.length, 1);
});

test('an existing deterministic filename with different bytes stops for attention without overwrite', async (t) => {
  const value = fixture(t);
  const identity = attachmentIdentity(OPERATION_ID);
  fs.mkdirSync(value.mediaDirectory, { recursive: true });
  fs.writeFileSync(path.join(value.mediaDirectory, identity.filename), 'different');
  const result = await value.makeFinalizer().finalize(value.request);
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'asset_identity_mismatch');
  assert.equal(fs.readFileSync(path.join(value.mediaDirectory, identity.filename), 'utf8'), 'different');
  const db = await database(value);
  assert.equal(db.items[0].upscaled, value.oldUpscale);
  assert.equal(db.history.length, 0);
});

for (const [name, mutate, type] of [
  ['profile mismatch', (db) => { db.items[0].profileId = 'other'; }, 'target_profile_mismatch'],
  ['source file mismatch', (db) => { db.items[0].file = 'new-source.png'; }, 'source_file_version_mismatch'],
  ['source attachment mismatch', (db) => { db.items[0].upscaled = 'newer-upscale.png'; }, 'source_attachment_version_mismatch'],
]) {
  test(`${name} becomes attention and never replaces the current attachment`, async (t) => {
    const value = fixture(t);
    await value.databaseStore.transaction((db) => mutate(db));
    const before = (await database(value)).items[0].upscaled;
    const result = await value.makeFinalizer().finalize(value.request);
    assert.equal(result.status, 'attention');
    assert.equal(result.conflict.type, type);
    const db = await database(value);
    assert.equal(db.items[0].upscaled, before);
    assert.equal(db.history.length, 0);
  });
}

test('changed content for the same operation becomes attention before publication', async (t) => {
  const value = fixture(t);
  const result = await value.makeFinalizer().finalize({
    ...value.request,
    output: { ...value.request.output, content: Buffer.from('wrong bytes') },
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'catalog_attachment_content_mismatch');
  assert.equal(fs.existsSync(value.mediaDirectory), false);
  assert.equal((await database(value)).items[0].upscaled, value.oldUpscale);
});

test('reusing an operation id for a different request returns attention without changing the saved receipt', async (t) => {
  const value = fixture(t);
  const crash = new Error('prepared');
  await assert.rejects(value.makeFinalizer(async (point) => {
    if (point === 'after_receipt_prepared') throw crash;
  }).finalize(value.request), crash);
  const result = await value.makeFinalizer().finalize({
    ...value.request,
    target: { ...value.request.target, itemId: 'some-other-item' },
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.conflict.type, 'receipt_identity_mismatch');
  assert.equal((await value.receiptStore.load(OPERATION_ID)).target.itemId, 'item-1');
});

test('the strategy registry accepts future attachment strategies without changing orchestration', async (t) => {
  const value = fixture(t, { oldUpscale: null });
  const custom = {
    inspect(db, receipt) {
      const target = db.items[0];
      if (target.customReceipt?.operationId === receipt.operationId) {
        return { status: 'applied', target, history: db.history[0] };
      }
      return { status: 'ready', target };
    },
    apply(db, receipt) {
      const target = db.items[0];
      target.customReceipt = { operationId: receipt.operationId };
      const history = { id: receipt.historyId, itemId: target.id, profileId: receipt.profileId };
      db.history.unshift(history);
      return { status: 'inserted', target, history };
    },
  };
  const request = {
    ...value.request,
    strategy: 'attach_video',
    output: { ...value.request.output, kind: 'video', role: 'attach_video', extension: '.mp4' },
  };
  const finalizer = createCatalogAttachmentFinalizer({
    mediaDirectory: value.mediaDirectory,
    receiptStore: value.receiptStore,
    databaseStore: value.databaseStore,
    strategies: { attach_video: custom },
  });
  assert.equal((await finalizer.finalize(request)).status, 'complete');
  assert.equal((await database(value)).items[0].customReceipt.operationId, OPERATION_ID);
});
