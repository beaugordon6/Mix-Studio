'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  assertVerifiedComfyRuntime,
  attestComfyEndpoint,
  compareComfyRuntime,
  expectedComfyInstallation,
  observedComfyInstance,
} = require('../lib/comfy-runtime-identity');

const runtime = { comfy: { path: '/studio/Mix-ComfyUI', modelsPath: '/studio/Mix-ComfyUI/models' } };
const stats = (source = '/studio/Mix-ComfyUI', extra = []) => ({
  system: {
    argv: [`${source}/main.py`, '--listen', '127.0.0.1', ...extra],
    comfyui_version: '0.34.0', python_version: '3.14.7', pytorch_version: '2.9.0',
  },
  devices: [],
});

test('same configured install survives port and process-version changes but gets a new instance id', () => {
  const expected = expectedComfyInstallation(runtime);
  const first = observedComfyInstance('http://127.0.0.1:8188', stats(), { pid: 10, processStartedAt: 'one' });
  const second = observedComfyInstance('http://127.0.0.1:8197', stats('/studio/Mix-ComfyUI'), { pid: 11, processStartedAt: 'two' });
  assert.equal(compareComfyRuntime(expected, first).status, 'verified');
  assert.equal(compareComfyRuntime(expected, second).status, 'verified');
  assert.equal(first.installId, second.installId);
  assert.notEqual(first.instanceId, second.instanceId);
});

test('a system-stats-shaped listener from another source install is rejected', async () => {
  const attestation = await attestComfyEndpoint(runtime, 'http://127.0.0.1:8188', {
    fetchImpl: async () => ({ ok: true, async json() { return stats('/other/ComfyUI'); } }),
  });
  assert.equal(attestation.match.status, 'foreign');
  assert.deepEqual(attestation.match.mismatches, ['sourcePath', 'inputPath', 'modelsPath']);
  assert.throws(() => assertVerifiedComfyRuntime(attestation), (error) => (
    error.code === 'comfy_runtime_mismatch' && error.status === 409
  ));
});

test('alternate input or models roots are treated as a different runtime', () => {
  const expected = expectedComfyInstallation(runtime);
  const input = observedComfyInstance('http://localhost:8188', stats('/studio/Mix-ComfyUI', [
    '--input-directory', '/tmp/fresh-input',
  ]));
  const models = observedComfyInstance('http://localhost:8188', stats('/studio/Mix-ComfyUI', [
    '--models-directory=/tmp/wrong-models',
  ]));
  assert.deepEqual(compareComfyRuntime(expected, input).mismatches, ['inputPath']);
  assert.deepEqual(compareComfyRuntime(expected, models).mismatches, ['modelsPath']);
});

test('missing launch identity is unverifiable and remote runtimes remain explicitly classified', () => {
  const expected = expectedComfyInstallation(runtime);
  const unknown = observedComfyInstance('http://127.0.0.1:8188', { system: {}, devices: [] });
  const remote = observedComfyInstance('https://generation.example.test', stats());
  assert.equal(compareComfyRuntime(expected, unknown).status, 'unverifiable');
  assert.equal(compareComfyRuntime(expected, remote).status, 'remote');
});

test('Windows path aliases and case differences normalize to one installation', () => {
  const options = { platform: 'win32', pathImpl: path.win32, realpathSync: (value) => value };
  const expected = expectedComfyInstallation({
    comfy: { path: 'C:\\AI\\ComfyUI', modelsPath: 'C:\\AI\\ComfyUI\\models' },
  }, options);
  const observed = observedComfyInstance('http://127.0.0.1:8188', stats('c:\\ai\\comfyui'), options);
  assert.equal(compareComfyRuntime(expected, observed).status, 'verified');
});
