'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function section(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return server.slice(from, to);
}

test('the shared deletion adapter durably flushes its catalog tombstone only inside the journal checkpoint', () => {
  const helper = section(
    'async function deleteUploadedAssetDurably(asset)',
    'const durableGalleryManifestStore',
  );
  assert.match(helper, /durableInputDeletionJournal\.checkpointCatalog\(/);
  assert.match(helper, /async \(\) => \{[\s\S]*catalogAsset\.deletedAt = Date\.now\(\);[\s\S]*flushDbNow\(\);[\s\S]*\}/);
  const journalBranch = helper.slice(helper.indexOf('return durableInputDeletionJournal.checkpointCatalog('));
  assert.ok(journalBranch.indexOf('checkpointCatalog(') < journalBranch.indexOf('flushDbNow();'));
});

test('single uploaded-asset deletion can replay an ambiguous committed tombstone', () => {
  const route = section(
    "const uploadedAssetDelete = route.match(/^\\/api\\/uploaded-assets",
    "if (route === '/api/items/selection-stats'",
  );
  assert.doesNotMatch(route, /&& !entry\.deletedAt/);
  assert.match(route, /asset\.deletedAt[\s\S]*durableInputDeletionReceiptStore\.load\(asset\.assetId\)/);
  assert.match(route, /serializeMediaDeletion\(async \(\) => \{[\s\S]*deleteUploadedAssetDurably\(asset\)/);
});

test('profile deletion journals every uploaded asset before mutating the remaining profile catalog', () => {
  const route = section(
    "if (profMan && req.method === 'DELETE')",
    '// Everything else needs a signed-in profile',
  );
  const durableDelete = route.indexOf('await deleteUploadedAssetDurably(asset);');
  const itemCatalogDelete = route.indexOf('db.items = db.items.filter');
  const uploadedCatalogDelete = route.indexOf('db.uploadedAssets = db.uploadedAssets.filter');
  assert.ok(durableDelete >= 0);
  assert.ok(durableDelete < itemCatalogDelete);
  assert.ok(durableDelete < uploadedCatalogDelete);
  assert.match(route, /db\.uploadedAssets\.filter\(\(entry\) => entry\.profileId === target\.id\)/);
  assert.doesNotMatch(route.slice(0, itemCatalogDelete), /entry\.profileId === target\.id && !entry\.deletedAt/);
});

test('startup replays unfinished deletion receipts before serving API requests', () => {
  const recovery = section(
    'async function replayDurableInputDeletions()',
    'const durableGalleryManifestStore',
  );
  assert.match(recovery, /durableInputDeletionReceiptStore\.list\(\)/);
  assert.match(recovery, /\.filter\(\(entry\) => entry\.catalogState !== 'committed'\)/);
  assert.match(recovery, /await deleteUploadedAssetDurably\(asset\)/);
  assert.match(server, /url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,120}await durableInputDeletionRecovery/);
});

test('empty trash cannot destroy files needed by an unfinished deletion replay', () => {
  const route = section(
    "if (route === '/api/trash' && req.method === 'DELETE')",
    "if (route === '/api/update'",
  );
  assert.match(route, /durableInputDeletionReceiptStore\.list\(\)/);
  assert.match(route, /receipt\.catalogState !== 'committed'/);
  assert.ok(route.indexOf('durable_input_deletion_pending') < route.indexOf('emptyTrashDirectory(TRASH_ROOT)'));
});
