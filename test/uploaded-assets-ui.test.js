'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('source picker exposes uploaded assets for image, video, and audio inputs', () => {
  assert.match(html, /Browse Library/);
  assert.match(html, /Generations and uploaded assets/);
  assert.match(app, /function uploadedAssetPickerAssets\(accept\)/);
  assert.match(app, /function assetPickerKinds\(accept\)[\s\S]{0,240}\['image', 'video', 'audio'\]/);
  assert.match(app, /directorOpenMediaPicker\('audio'\)/);
  assert.match(app, /pickUpload\('audio\/\*'/);
});

test('Library has a virtual Uploaded assets collection with deletion controls', () => {
  assert.match(html, /id="uploadedAssetsLibrary"/);
  assert.match(html, /id="uploadedAssetsGrid"/);
  assert.match(app, /id: 'uploaded-assets', name: 'Uploaded assets'/);
  assert.match(app, /api\/uploaded-assets\/\$\{encodeURIComponent\(asset\.id\)\}/);
  assert.match(css, /\.uploaded-asset-delete/);
});

test('cataloged upload and safe deletion APIs are wired server-side', () => {
  assert.match(server, /req\.headers\['x-asset-catalog'\] === '1'/);
  assert.match(server, /uploadedAssetUsage\(asset, \{ items: db\.items, jobs: \[\.\.\.jobs\.values\(\)\], elements: db\.elements \}\)/);
  assert.match(server, /createDurableInputDeletionJournal\(\{[\s\S]*aliasDirectory: INPUTS[\s\S]*trashDirectory: TRASH_ROOT/);
  assert.match(server, /durableInputDeletionJournal\.checkpointCatalog\([\s\S]*catalogAsset\.deletedAt = Date\.now\(\)[\s\S]*flushDbNow\(\)/);
  assert.match(server, /await deleteUploadedAssetDurably\(asset\)/);
});

test('input previews resolve ownership by profile instead of the first matching name', () => {
  const route = server.slice(
    server.indexOf("if (route === '/api/input' && req.method === 'GET')"),
    server.indexOf("if (route === '/api/upload' && req.method === 'POST')"),
  );
  assert.match(route, /catalogedAssets\.find\(\(asset\) => asset\.profileId === req\.profile\.id\)/);
  assert.match(route, /catalogedAssets\.length && !catalogedAsset/);
});

test('profile deletion refuses to orphan active durable work or a reorder receipt', () => {
  const route = server.slice(
    server.indexOf("if (profMan && req.method === 'DELETE')"),
    server.indexOf('// Everything else needs a signed-in profile'),
  );
  assert.match(route, /\[\.\.\.jobs\.values\(\)\]\.some\(\(job\) => job\?\.profileId === target\.id\)/);
  assert.match(route, /queueReorderReceipt\?\.profileId === target\.id/);
  assert.ok(route.indexOf('profile_has_durable_work') < route.indexOf("backupDb('pre-delete')"));
});
