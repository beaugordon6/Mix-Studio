'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createDurableInputDeletionJournal,
  createFileDurableInputDeletionReceiptStore,
} = require('../lib/durable-input-deletion');
const { durableInputIdentity } = require('../lib/durable-input-staging');

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-durable-delete-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directories = {
    aliasDirectory: path.join(root, 'aliases'),
    assetDirectory: path.join(root, 'assets'),
    manifestDirectory: path.join(root, 'manifests'),
    trashDirectory: path.join(root, 'trash'),
    receiptDirectory: path.join(root, 'receipts'),
  };
  await Promise.all(Object.values(directories).map((directory) => fsp.mkdir(directory, { recursive: true })));
  const profileId = 'owner-profile';
  const name = 'elements/hermes.png';
  const assetId = durableInputIdentity(profileId, name);
  const aliases = ['profile/hermes-preview.png', 'profile/hermes-source.jpg'];
  const files = [
    [path.join(directories.aliasDirectory, aliases[0]), 'preview bytes'],
    [path.join(directories.aliasDirectory, aliases[1]), 'source bytes'],
    [path.join(directories.assetDirectory, `${assetId}.bin`), 'blob bytes'],
    [path.join(directories.manifestDirectory, `${assetId}.json`), '{"manifest":true}'],
  ];
  for (const [file, content] of files) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  const fsImpl = options.fs || fsp;
  const receiptStore = createFileDurableInputDeletionReceiptStore(directories.receiptDirectory, { fs: fsImpl });
  const request = { profileId, name, assetId, aliases };
  const makeJournal = (extra = {}) => createDurableInputDeletionJournal({
    ...directories,
    receiptStore,
    fs: fsImpl,
    createReadStream: fs.createReadStream,
    ...extra,
  });
  return { root, directories, files, receiptStore, request, makeJournal };
}

test('the deletion tombstone is durable before the first file moves', async (t) => {
  const value = await fixture(t);
  const crash = new Error('stop after tombstone');
  const journal = value.makeJournal({
    fault(point) {
      if (point === 'after_receipt_prepared') throw crash;
    },
  });
  await assert.rejects(journal.moveToTrash(value.request), (error) => error === crash);
  const receipt = await value.receiptStore.load(value.request.assetId);
  const listed = await value.receiptStore.list();
  assert.equal(receipt.phase, 'prepared');
  assert.deepEqual(listed.map((entry) => entry.assetId), [value.request.assetId]);
  assert.equal(receipt.catalogState, 'pending');
  assert.ok(receipt.entries.every((entry) => entry.state === 'pending'));
  for (const [file] of value.files) assert.equal(fs.existsSync(file), true);
});

for (const crashPoint of [
  'after_alias_0_move',
  'after_alias_1_move',
  'after_blob_2_move',
  'after_manifest_3_move',
]) {
  test(`replay is idempotent after ${crashPoint}`, async (t) => {
    const value = await fixture(t);
    const crash = new Error(crashPoint);
    const crashing = value.makeJournal({
      fault(point) {
        if (point === crashPoint) throw crash;
      },
    });
    await assert.rejects(crashing.moveToTrash(value.request), (error) => error === crash);

    const replayed = await value.makeJournal().moveToTrash(value.request);
    assert.equal(replayed.status, 'ready_for_catalog_checkpoint');
    assert.equal(replayed.receipt.phase, 'files_moved');
    assert.ok(replayed.receipt.entries.every((entry) => entry.state === 'moved'));
    for (const entry of replayed.receipt.entries) {
      const sourceRoot = entry.kind === 'alias'
        ? value.directories.aliasDirectory
        : entry.kind === 'blob' ? value.directories.assetDirectory : value.directories.manifestDirectory;
      assert.equal(fs.existsSync(path.join(sourceRoot, entry.sourceRelativePath)), false);
      assert.equal(fs.existsSync(path.join(value.directories.trashDirectory, entry.trashRelativePath)), true);
    }
  });
}

test('catalog checkpoint runs only after every source is recoverably in deterministic trash', async (t) => {
  const value = await fixture(t);
  let catalogDeleted = false;
  let checkpointCalls = 0;
  let effectiveDeletes = 0;
  const checkpoint = async (receipt) => {
    checkpointCalls += 1;
    assert.equal(receipt.phase, 'files_moved');
    assert.ok(receipt.entries.every((entry) => (
      fs.existsSync(path.join(value.directories.trashDirectory, entry.trashRelativePath))
    )));
    if (!catalogDeleted) {
      catalogDeleted = true;
      effectiveDeletes += 1;
    }
  };
  const crash = new Error('lost response after database commit');
  const crashing = value.makeJournal({
    checkpointCatalog: checkpoint,
    fault(point) {
      if (point === 'after_catalog_commit') throw crash;
    },
  });
  await assert.rejects(crashing.deleteAsset(value.request), (error) => error === crash);
  assert.equal(catalogDeleted, true);
  assert.equal((await value.receiptStore.load(value.request.assetId)).catalogState, 'pending');

  const replay = await value.makeJournal({ checkpointCatalog: checkpoint }).deleteAsset(value.request);
  assert.equal(replay.status, 'complete');
  assert.equal(replay.receipt.catalogState, 'committed');
  assert.equal(checkpointCalls, 2, 'an ambiguous catalog acknowledgement is safely retried');
  assert.equal(effectiveDeletes, 1, 'the injected catalog transaction is idempotent');

  await value.makeJournal({ checkpointCatalog: checkpoint }).deleteAsset(value.request);
  assert.equal(checkpointCalls, 2, 'a completed receipt never repeats the catalog transaction');
});

test('move-only integration stops at an explicit catalog boundary', async (t) => {
  const value = await fixture(t);
  const moved = await value.makeJournal().deleteAsset(value.request);
  assert.equal(moved.status, 'ready_for_catalog_checkpoint');
  assert.equal(moved.receipt.catalogState, 'pending');

  let committed = 0;
  const complete = await value.makeJournal().checkpointCatalog(value.request, async () => { committed += 1; });
  assert.equal(complete.status, 'complete');
  assert.equal(committed, 1);
});

test('replay resumes cleanly after the all-files checkpoint', async (t) => {
  const value = await fixture(t);
  const crash = new Error('stop after files checkpoint');
  await assert.rejects(value.makeJournal({
    fault(point) {
      if (point === 'after_files_checkpoint') throw crash;
    },
  }).moveToTrash(value.request), (error) => error === crash);
  const replay = await value.makeJournal().moveToTrash(value.request);
  assert.equal(replay.status, 'ready_for_catalog_checkpoint');
  assert.equal(replay.receipt.phase, 'files_moved');
});

test('replay after the catalog receipt checkpoint is terminal and does not recommit', async (t) => {
  const value = await fixture(t);
  const crash = new Error('stop after catalog checkpoint');
  let commits = 0;
  await assert.rejects(value.makeJournal({
    checkpointCatalog: async () => { commits += 1; },
    fault(point) {
      if (point === 'after_catalog_checkpoint') throw crash;
    },
  }).deleteAsset(value.request), (error) => error === crash);
  const replay = await value.makeJournal({
    checkpointCatalog: async () => { commits += 1; },
  }).deleteAsset(value.request);
  assert.equal(replay.status, 'complete');
  assert.equal(commits, 1);
});

test('identity and traversal validation fail before any file or receipt changes', async (t) => {
  const value = await fixture(t);
  const journal = value.makeJournal();
  await assert.rejects(
    journal.moveToTrash({ ...value.request, aliases: ['../foreign.png'] }),
    { code: 'durable_input_deletion_path_invalid' },
  );
  await assert.rejects(
    journal.moveToTrash({ ...value.request, profileId: 'other-profile' }),
    { code: 'durable_input_deletion_identity_mismatch' },
  );
  await assert.rejects(
    journal.moveToTrash({ ...value.request, assetId: '../../foreign' }),
    { code: 'durable_input_deletion_asset_id_invalid' },
  );
  assert.equal(await value.receiptStore.load(value.request.assetId), null);
  for (const [file] of value.files) assert.equal(fs.existsSync(file), true);
});

test('a symlink cannot escape a configured deletion root', async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'foreign.png'), 'must remain outside');
  await fsp.symlink(outside, path.join(value.directories.aliasDirectory, 'escape'));
  await assert.rejects(
    value.makeJournal().moveToTrash({ ...value.request, aliases: ['escape/foreign.png'] }),
    { code: 'durable_input_deletion_path_invalid' },
  );
  assert.equal(await fsp.readFile(path.join(outside, 'foreign.png'), 'utf8'), 'must remain outside');
  assert.equal(await value.receiptStore.load(value.request.assetId), null);
});

test('recoverable deletion never calls unlink', async (t) => {
  const fsImpl = Object.create(fsp);
  fsImpl.unlink = async () => { throw new Error('unlink is forbidden'); };
  const value = await fixture(t, { fs: fsImpl });
  const result = await value.makeJournal().moveToTrash(value.request);
  assert.equal(result.status, 'ready_for_catalog_checkpoint');
});
