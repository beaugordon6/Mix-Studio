'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { inputAssetPath } = require('../lib/input-assets');
const { stageElementInputs } = require('../lib/comfy-input-stager');

async function fixture(t, assets = []) {
  const inputDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-comfy-stage-'));
  t.after(() => fsp.rm(inputDirectory, { recursive: true, force: true }));
  for (const asset of assets) {
    await fsp.writeFile(inputAssetPath(inputDirectory, asset.name), asset.contents || 'image');
  }
  return inputDirectory;
}

function image(name, overrides = {}) {
  return {
    id: `asset-${name}`,
    name,
    profileId: 'owner',
    kind: 'image',
    createdAt: 1,
    ...overrides,
  };
}

test('stages profile-owned Element images under their exact logical names', async (t) => {
  const asset = image('ks_hermes.jpg');
  const inputDirectory = await fixture(t, [asset]);
  const calls = [];
  const staged = await stageElementInputs({
    names: [asset.name],
    profileId: 'owner',
    uploadedAssets: [asset],
    inputDirectory,
    uploadFile: async (file, name) => {
      calls.push({ file, name });
      return name;
    },
  });

  assert.deepEqual(staged, [asset.name]);
  assert.deepEqual(calls, [{
    file: inputAssetPath(inputDirectory, asset.name),
    name: asset.name,
  }]);
});

test('deduplicates requested logical names while preserving first-seen order', async (t) => {
  const hermes = image('ks_hermes.jpg');
  const valley = image('ks_valley.png');
  const inputDirectory = await fixture(t, [hermes, valley]);
  const calls = [];
  const staged = await stageElementInputs({
    names: [hermes.name, valley.name, hermes.name, '', valley.name],
    profileId: 'owner',
    uploadedAssets: [hermes, valley],
    inputDirectory,
    uploadFile: async (_file, name) => {
      calls.push(name);
      return name;
    },
  });

  assert.deepEqual(staged, [hermes.name, valley.name]);
  assert.deepEqual(calls, [hermes.name, valley.name]);
});

test('rejects an Element image missing from durable Mix storage before upload', async (t) => {
  const asset = image('ks_missing.jpg');
  const inputDirectory = await fixture(t);
  let uploaded = false;
  await assert.rejects(stageElementInputs({
    names: [asset.name],
    profileId: 'owner',
    uploadedAssets: [asset],
    inputDirectory,
    uploadFile: async (_file, name) => {
      uploaded = true;
      return name;
    },
  }), (error) => (
    error.code === 'element_asset_missing'
    && error.assetName === asset.name
    && error.recoverable === true
    && /Mix Studio storage/.test(error.message)
  ));
  assert.equal(uploaded, false);
});

test('rejects foreign, deleted, and non-image catalog entries for Elements', async (t) => {
  const inputDirectory = await fixture(t);
  const cases = [
    { asset: image('foreign.jpg', { profileId: 'guest' }), reason: 'wrong_profile' },
    { asset: image('deleted.jpg', { deletedAt: 2 }), reason: 'deleted' },
    { asset: image('video.mp4', { kind: 'video' }), reason: 'not_image' },
  ];

  for (const { asset, reason } of cases) {
    await assert.rejects(stageElementInputs({
      names: [asset.name],
      profileId: 'owner',
      uploadedAssets: [asset],
      inputDirectory,
      uploadFile: async (_file, name) => name,
    }), (error) => (
      error.code === 'element_asset_unavailable'
      && error.reason === reason
      && error.assetName === asset.name
    ));
  }
});

test('wraps ComfyUI upload failures with an actionable staging error', async (t) => {
  const asset = image('ks_upload.jpg');
  const inputDirectory = await fixture(t, [asset]);
  const cause = new Error('connection refused');
  await assert.rejects(stageElementInputs({
    names: [asset.name],
    profileId: 'owner',
    uploadedAssets: [asset],
    inputDirectory,
    uploadFile: async () => { throw cause; },
  }), (error) => (
    error.code === 'comfy_input_stage_failed'
    && error.status === 502
    && error.cause === cause
    && /Check the ComfyUI connection/.test(error.message)
  ));
});

test('rejects a ComfyUI rename so graph references cannot become stale', async (t) => {
  const asset = image('ks_exact.jpg');
  const inputDirectory = await fixture(t, [asset]);
  await assert.rejects(stageElementInputs({
    names: [asset.name],
    profileId: 'owner',
    uploadedAssets: [asset],
    inputDirectory,
    uploadFile: async () => 'ks_exact_2.jpg',
  }), (error) => (
    error.code === 'comfy_input_name_changed'
    && error.assetName === asset.name
    && error.reason === 'name_changed'
  ));
});

test('a staging failure prevents prompt submission and success preserves ordering', async (t) => {
  const asset = image('ks_submit.jpg');
  const inputDirectory = await fixture(t, [asset]);
  const events = [];
  const submit = async (uploadFile) => {
    await stageElementInputs({
      names: [asset.name], profileId: 'owner', uploadedAssets: [asset], inputDirectory, uploadFile,
    });
    events.push('prompt');
  };
  await assert.rejects(submit(async () => {
    events.push('upload');
    throw new Error('offline');
  }), /restore this Element image/);
  assert.deepEqual(events, ['upload']);

  events.length = 0;
  await submit(async (_file, name) => {
    events.push('upload');
    return name;
  });
  assert.deepEqual(events, ['upload', 'prompt']);
});
