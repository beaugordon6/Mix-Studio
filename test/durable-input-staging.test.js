'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createDurableInputStager,
  createFileDurableInputManifestStore,
  durableInputIdentity,
} = require('../lib/durable-input-staging');

async function fixture(t, upload, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-durable-input-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const assetDirectory = path.join(root, 'assets');
  const manifestDirectory = path.join(root, 'manifests');
  const manifestStore = createFileDurableInputManifestStore(manifestDirectory);
  return {
    root,
    assetDirectory,
    manifestDirectory,
    manifestStore,
    stager: createDurableInputStager({ assetDirectory, manifestStore, upload, ...options }),
  };
}

const request = () => ({
  profileId: 'owner-profile',
  name: 'elements/hermes.png',
  content: Buffer.from('authoritative hermes bytes'),
  createdAt: 100,
});

test('durable bytes and ownership manifest exist before the first Comfy upload', async (t) => {
  let value;
  value = await fixture(t, async (content, name, asset) => {
    const manifest = await value.manifestStore.load(asset.assetId);
    assert.equal(manifest.profileId, 'owner-profile');
    assert.equal(manifest.name, name);
    assert.deepEqual(await fsp.readFile(path.join(value.assetDirectory, `${asset.assetId}.bin`)), content);
    return name;
  });
  const result = await value.stager.preserveAndStage(request());
  assert.equal(result.state, 'staged');
  assert.equal(result.preserved, 'created');
  assert.equal(result.remoteName, 'elements/hermes.png');
});

test('offline upload retains the asset and a later process stages the exact bytes and name', async (t) => {
  const first = await fixture(t, async () => {
    const error = new Error('Comfy is offline');
    error.code = 'ECONNREFUSED';
    throw error;
  });
  const offline = await first.stager.preserveAndStage(request());
  assert.equal(offline.state, 'waiting_for_comfy');
  assert.equal(offline.error.code, 'durable_input_upload_unavailable');
  assert.equal(offline.error.retryable, true);

  let observed;
  const restarted = createDurableInputStager({
    assetDirectory: first.assetDirectory,
    manifestStore: createFileDurableInputManifestStore(first.manifestDirectory),
    upload: async (content, name) => {
      observed = { content: Buffer.from(content), name };
      return name;
    },
  });
  const staged = await restarted.stage({ profileId: 'owner-profile', assetId: offline.asset.assetId });
  assert.equal(staged.state, 'staged');
  assert.equal(observed.name, request().name);
  assert.deepEqual(observed.content, request().content);
});

test('a cross-profile claim cannot read or upload another profile asset', async (t) => {
  let uploads = 0;
  const value = await fixture(t, async (content, name) => { uploads += 1; return name; });
  const preserved = await value.stager.preserve(request());
  await assert.rejects(
    value.stager.stage({ profileId: 'other-profile', assetId: preserved.asset.assetId }),
    { code: 'durable_input_profile_mismatch', state: 'attention', retryable: false },
  );
  assert.equal(uploads, 0);
});

test('the same profile and name cannot be rebound to changed content', async (t) => {
  const value = await fixture(t);
  const original = await value.stager.preserve(request());
  await assert.rejects(
    value.stager.preserve({ ...request(), content: Buffer.from('replacement bytes') }),
    { code: 'durable_input_content_conflict' },
  );
  assert.deepEqual(
    await fsp.readFile(path.join(value.assetDirectory, `${original.asset.assetId}.bin`)),
    request().content,
  );
});

test('identical preservation is idempotent and does not create another asset', async (t) => {
  const value = await fixture(t);
  const [first, second] = await Promise.all([
    value.stager.preserve(request()),
    value.stager.preserve(request()),
  ]);
  assert.equal(first.asset.assetId, second.asset.assetId);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(await fsp.readdir(value.assetDirectory), [`${first.asset.assetId}.bin`]);
});

test('a changed remote name stops before prompt submission and keeps local bytes', async (t) => {
  const value = await fixture(t, async () => 'renamed/hermes.png');
  const result = await value.stager.preserveAndStage(request());
  assert.equal(result.state, 'attention');
  assert.equal(result.error.code, 'durable_input_remote_name_mismatch');
  assert.equal(fs.existsSync(path.join(value.assetDirectory, `${result.asset.assetId}.bin`)), true);
});

test('corrupt or missing authoritative bytes fail closed without calling Comfy', async (t) => {
  let uploads = 0;
  const value = await fixture(t, async (content, name) => { uploads += 1; return name; });
  const preserved = await value.stager.preserve(request());
  await fsp.writeFile(path.join(value.assetDirectory, `${preserved.asset.assetId}.bin`), 'corrupt');
  await assert.rejects(
    value.stager.stage({ profileId: 'owner-profile', assetId: preserved.asset.assetId }),
    { code: 'durable_input_bytes_changed' },
  );
  assert.equal(uploads, 0);
});

test('caller-supplied name and digest claims must match the immutable manifest', async (t) => {
  const value = await fixture(t, async (content, name) => name);
  const preserved = await value.stager.preserve(request());
  await assert.rejects(
    value.stager.stage({ profileId: 'owner-profile', assetId: preserved.asset.assetId, name: 'other.png' }),
    { code: 'durable_input_name_mismatch' },
  );
  await assert.rejects(
    value.stager.stage({ profileId: 'owner-profile', assetId: preserved.asset.assetId, sha256: '0'.repeat(64) }),
    { code: 'durable_input_content_conflict' },
  );
});

test('unsafe Comfy names and invalid asset identities are rejected', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    value.stager.preserve({ ...request(), name: '../foreign.png' }),
    { code: 'durable_input_name_invalid' },
  );
  await assert.rejects(
    value.stager.stage({ profileId: 'owner-profile', assetId: '../../foreign' }),
    { code: 'durable_input_asset_id_invalid' },
  );
  assert.notEqual(
    durableInputIdentity('owner-profile', 'same.png'),
    durableInputIdentity('other-profile', 'same.png'),
  );
});

test('upload classification distinguishes retryable transport loss from terminal attention', async (t) => {
  const value = await fixture(t, async () => {
    const error = new Error('provider rejected content');
    error.code = 'VALIDATION';
    throw error;
  }, {
    classifyUploadError(error) {
      return error.code === 'VALIDATION'
        ? { code: 'durable_input_upload_rejected', message: error.message, retryable: false }
        : { code: 'durable_input_upload_unavailable', retryable: true };
    },
  });
  const result = await value.stager.preserveAndStage(request());
  assert.equal(result.state, 'attention');
  assert.deepEqual(result.error, {
    code: 'durable_input_upload_rejected',
    message: 'provider rejected content',
    retryable: false,
  });
  assert.equal(fs.existsSync(path.join(value.assetDirectory, `${result.asset.assetId}.bin`)), true);
});

test('preserveFile streams the caller file and never uses readFile on it', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-durable-input-file-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'large-source.bin');
  await fsp.writeFile(source, Buffer.alloc(4 * 1024 * 1024, 7));
  let sourceReadFileCalls = 0;
  const fsImpl = Object.create(fsp);
  fsImpl.readFile = async (file, ...args) => {
    if (path.resolve(file) === path.resolve(source)) {
      sourceReadFileCalls += 1;
      throw new Error('preserveFile must not buffer the caller file');
    }
    return fsp.readFile(file, ...args);
  };
  const assetDirectory = path.join(root, 'assets');
  const streamedPaths = [];
  const stager = createDurableInputStager({
    assetDirectory,
    manifestStore: createFileDurableInputManifestStore(path.join(root, 'manifests')),
    fs: fsImpl,
    createReadStream(file, ...args) {
      streamedPaths.push(path.resolve(file));
      return fs.createReadStream(file, ...args);
    },
  });
  const result = await stager.preserveFile({ profileId: 'owner', name: 'large.bin', filePath: source });
  assert.equal(result.state, 'preserved');
  assert.equal(result.asset.bytes, 4 * 1024 * 1024);
  assert.equal(sourceReadFileCalls, 0);
  assert.equal(streamedPaths.filter((file) => file === path.resolve(source)).length, 1);
  assert.equal(
    streamedPaths.filter((file) => file === path.resolve(assetDirectory, `${result.asset.assetId}.bin`)).length,
    0,
    'a newly published immutable target is not hashed again',
  );
  assert.equal(fs.existsSync(source), true, 'the caller source remains after durable publication');
});

test('new buffer publication does not redundantly read immutable bytes back', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-durable-input-buffer-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const assetDirectory = path.join(root, 'assets');
  let assetReads = 0;
  const fsImpl = Object.create(fsp);
  fsImpl.readFile = async (file, ...args) => {
    if (path.dirname(file) === assetDirectory && path.extname(file) === '.bin') assetReads += 1;
    return fsp.readFile(file, ...args);
  };
  const stager = createDurableInputStager({
    assetDirectory,
    manifestStore: createFileDurableInputManifestStore(path.join(root, 'manifests'), { fs: fsImpl }),
    fs: fsImpl,
  });
  await stager.preserve(request());
  assert.equal(assetReads, 0);
});

test('offline stageFile retains authoritative storage and later uploads its exact path and name', async (t) => {
  const value = await fixture(t);
  const source = path.join(value.root, 'video.mp4');
  await fsp.writeFile(source, 'streamed video content');
  const preserved = await value.stager.preserveFile({
    profileId: 'owner-profile', name: 'video/source.mp4', filePath: source,
  });
  const offline = await value.stager.stageFile({ profileId: 'owner-profile', assetId: preserved.asset.assetId });
  assert.equal(offline.state, 'waiting_for_comfy');
  assert.equal(fs.existsSync(path.join(value.assetDirectory, `${preserved.asset.assetId}.bin`)), true);
  assert.equal(fs.existsSync(source), true);

  let observed;
  const restarted = createDurableInputStager({
    assetDirectory: value.assetDirectory,
    manifestStore: createFileDurableInputManifestStore(value.manifestDirectory),
    uploadFile: async (file, name, manifest) => {
      observed = { file, name, size: (await fsp.stat(file)).size, manifest };
      return name;
    },
  });
  const staged = await restarted.stageFile({ profileId: 'owner-profile', assetId: preserved.asset.assetId });
  assert.equal(staged.state, 'staged');
  assert.equal(observed.file, path.join(value.assetDirectory, `${preserved.asset.assetId}.bin`));
  assert.equal(observed.name, 'video/source.mp4');
  assert.equal(observed.size, Buffer.byteLength('streamed video content'));
});

test('preserveFile rejects changed content for an existing owned name and keeps both files intact', async (t) => {
  const value = await fixture(t);
  const source = path.join(value.root, 'source.png');
  await fsp.writeFile(source, 'first version');
  const first = await value.stager.preserveFile({ profileId: 'owner-profile', name: 'source.png', filePath: source });
  await fsp.writeFile(source, 'changed version');
  await assert.rejects(
    value.stager.preserveFile({ profileId: 'owner-profile', name: 'source.png', filePath: source }),
    { code: 'durable_input_content_conflict' },
  );
  assert.equal(await fsp.readFile(source, 'utf8'), 'changed version');
  assert.equal(
    await fsp.readFile(path.join(value.assetDirectory, `${first.asset.assetId}.bin`), 'utf8'),
    'first version',
  );
});

test('stageFile rejects cross-profile access before exposing an authoritative path', async (t) => {
  let uploadCalls = 0;
  const value = await fixture(t, undefined, {
    uploadFile: async (file, name) => { uploadCalls += 1; return name; },
  });
  const source = path.join(value.root, 'private.wav');
  await fsp.writeFile(source, 'private audio');
  const preserved = await value.stager.preserveFile({
    profileId: 'owner-profile', name: 'audio/private.wav', filePath: source,
  });
  await assert.rejects(
    value.stager.stageFile({ profileId: 'other-profile', assetId: preserved.asset.assetId }),
    { code: 'durable_input_profile_mismatch' },
  );
  assert.equal(uploadCalls, 0);
});

test('stageFile verifies authoritative content by stream and rejects mutation before upload', async (t) => {
  let uploadCalls = 0;
  const value = await fixture(t, undefined, {
    uploadFile: async (file, name) => { uploadCalls += 1; return name; },
  });
  const source = path.join(value.root, 'source.mov');
  await fsp.writeFile(source, 'original movie');
  const preserved = await value.stager.preserveFile({
    profileId: 'owner-profile', name: 'source.mov', filePath: source,
  });
  await fsp.writeFile(path.join(value.assetDirectory, `${preserved.asset.assetId}.bin`), 'mutated movie');
  await assert.rejects(
    value.stager.stageFile({ profileId: 'owner-profile', assetId: preserved.asset.assetId }),
    { code: 'durable_input_bytes_changed' },
  );
  assert.equal(uploadCalls, 0);
});

test('different assets stage concurrently without global head-of-line blocking', async (t) => {
  let secondStarted;
  const sawSecond = new Promise((resolve) => { secondStarted = resolve; });
  let timedOut = false;
  let timeout;
  const value = await fixture(t, async (content, name) => {
    if (name === 'first.png') await sawSecond;
    if (name === 'second.png') secondStarted();
    return name;
  });
  const first = await value.stager.preserve({
    profileId: 'owner-profile', name: 'first.png', content: Buffer.from('first'),
  });
  const second = await value.stager.preserve({
    profileId: 'owner-profile', name: 'second.png', content: Buffer.from('second'),
  });
  timeout = setTimeout(() => {
    timedOut = true;
    secondStarted();
  }, 500);
  await Promise.all([
    value.stager.stage({ profileId: 'owner-profile', assetId: first.asset.assetId }),
    value.stager.stage({ profileId: 'owner-profile', assetId: second.asset.assetId }),
  ]);
  clearTimeout(timeout);
  assert.equal(timedOut, false, 'one asset must not wait for an unrelated asset upload');
});

test('operations for the same asset remain serialized', async (t) => {
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const value = await fixture(t, async (content, name) => {
    calls += 1;
    if (calls === 1) await firstCanFinish;
    return name;
  });
  const preserved = await value.stager.preserve(request());
  const first = value.stager.stage({ profileId: 'owner-profile', assetId: preserved.asset.assetId });
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = value.stager.stage({ profileId: 'owner-profile', assetId: preserved.asset.assetId });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('staging concurrency is bounded across unrelated assets', async (t) => {
  let active = 0;
  let maximum = 0;
  let releaseUploads;
  const uploadsCanFinish = new Promise((resolve) => { releaseUploads = resolve; });
  let twoStarted;
  const sawTwo = new Promise((resolve) => { twoStarted = resolve; });
  const value = await fixture(t, async (content, name) => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (active === 2) twoStarted();
    await uploadsCanFinish;
    active -= 1;
    return name;
  }, { maxConcurrentOperations: 2 });
  const assets = [];
  for (let index = 0; index < 5; index += 1) {
    assets.push(await value.stager.preserve({
      profileId: 'owner-profile',
      name: `bounded-${index}.png`,
      content: Buffer.from(`content-${index}`),
    }));
  }
  const stages = assets.map(({ asset }) => value.stager.stage({
    profileId: 'owner-profile', assetId: asset.assetId,
  }));
  await sawTwo;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maximum, 2);
  releaseUploads();
  await Promise.all(stages);
  assert.equal(maximum, 2);
});

test('invalid concurrency configuration fails closed', async (t) => {
  const value = await fixture(t);
  assert.throws(() => createDurableInputStager({
    assetDirectory: value.assetDirectory,
    manifestStore: value.manifestStore,
    maxConcurrentOperations: 0,
  }), { code: 'durable_input_concurrency_invalid' });
});
