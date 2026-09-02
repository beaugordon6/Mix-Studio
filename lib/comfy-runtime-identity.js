'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isLoopbackUrl, normalizedComfyUrl } = require('./comfy-discovery');

const RUNTIME_IDENTITY_VERSION = 1;

function stableHash(value) {
  const ordered = {};
  for (const key of Object.keys(value || {}).sort()) ordered[key] = value[key];
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function canonicalPath(value, options = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const pathImpl = options.pathImpl || path;
  const platform = options.platform || process.platform;
  const realpathSync = options.realpathSync || fs.realpathSync.native || fs.realpathSync;
  let resolved = pathImpl.resolve(text);
  try { resolved = realpathSync(resolved); } catch { /* a configured path may not exist yet */ }
  resolved = pathImpl.normalize(resolved).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function argvOption(argv, names) {
  const values = Array.isArray(argv) ? argv.map(String) : [];
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    for (const name of names) {
      if (token === name) return String(values[index + 1] || '');
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return '';
}

function sourcePathFromArgv(argv, options = {}) {
  const pathImpl = options.pathImpl || path;
  const main = (Array.isArray(argv) ? argv : []).map(String)
    .find((entry) => /(?:^|[\\/])main\.py$/i.test(entry));
  return main ? canonicalPath(pathImpl.dirname(main), options) : '';
}

function expectedComfyInstallation(runtime, options = {}) {
  const pathImpl = options.pathImpl || path;
  const comfy = runtime?.comfy || {};
  const sourcePath = canonicalPath(comfy.path, options);
  const basePath = canonicalPath(comfy.dataPath || sourcePath, options);
  const modelsPath = canonicalPath(comfy.modelsPath || (basePath ? pathImpl.join(basePath, 'models') : ''), options);
  const inputPath = canonicalPath(comfy.inputPath || (basePath ? pathImpl.join(basePath, 'input') : ''), options);
  const stable = {
    schemaVersion: RUNTIME_IDENTITY_VERSION,
    sourcePath,
    dataPath: basePath,
    modelsPath,
    inputPath,
    pythonPath: canonicalPath(comfy.pythonPath, options),
    desktopInstallationId: String(comfy.desktopInstallationId || ''),
  };
  return Object.freeze({ ...stable, installId: stableHash(stable) });
}

function observedComfyInstance(url, stats = {}, options = {}) {
  const pathImpl = options.pathImpl || path;
  const argv = Array.isArray(stats?.system?.argv) ? stats.system.argv.map(String) : [];
  const sourcePath = sourcePathFromArgv(argv, options);
  const baseArg = argvOption(argv, ['--base-directory']);
  const dataPath = canonicalPath(baseArg || sourcePath, options);
  const modelsArg = argvOption(argv, ['--models-directory', '--model-directory']);
  const inputArg = argvOption(argv, ['--input-directory']);
  const modelsPath = canonicalPath(modelsArg || (dataPath ? pathImpl.join(dataPath, 'models') : ''), options);
  const inputPath = canonicalPath(inputArg || (dataPath ? pathImpl.join(dataPath, 'input') : ''), options);
  const stable = {
    schemaVersion: RUNTIME_IDENTITY_VERSION,
    sourcePath,
    dataPath,
    modelsPath,
    inputPath,
    pythonPath: canonicalPath(options.pythonPath, options),
    desktopInstallationId: String(options.desktopInstallationId || ''),
  };
  const installId = sourcePath ? stableHash(stable) : null;
  const instance = {
    schemaVersion: RUNTIME_IDENTITY_VERSION,
    installId,
    url: normalizedComfyUrl(url),
    pid: Number(options.pid) || null,
    processStartedAt: String(options.processStartedAt || ''),
    comfyVersion: String(stats?.system?.comfyui_version || ''),
    pythonVersion: String(stats?.system?.python_version || ''),
    pytorchVersion: String(stats?.system?.pytorch_version || ''),
    argv,
    ...stable,
  };
  return Object.freeze({ ...instance, instanceId: stableHash(instance) });
}

function compareComfyRuntime(expected, observed, options = {}) {
  if (!isLoopbackUrl(observed?.url)) {
    return { status: 'remote', code: 'comfy_runtime_remote', mismatches: [] };
  }
  if (!expected?.sourcePath) {
    return { status: 'unverifiable', code: 'comfy_runtime_path_unconfigured', mismatches: ['sourcePath'] };
  }
  if (!observed?.sourcePath) {
    return { status: 'unverifiable', code: 'comfy_runtime_identity_unavailable', mismatches: ['sourcePath'] };
  }
  const compared = ['sourcePath', 'inputPath', 'modelsPath'];
  const mismatches = compared.filter((key) => expected[key] && observed[key] && expected[key] !== observed[key]);
  if (mismatches.length) return { status: 'foreign', code: 'comfy_runtime_mismatch', mismatches };
  const missing = compared.filter((key) => expected[key] && !observed[key]);
  if (missing.length) return { status: 'unverifiable', code: 'comfy_runtime_identity_unavailable', mismatches: missing };
  return { status: 'verified', code: 'comfy_runtime_verified', mismatches: [] };
}

async function attestComfyEndpoint(runtime, url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = normalizedComfyUrl(url);
  const expected = expectedComfyInstallation(runtime, options);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/system_stats`, {
      signal: options.signal || AbortSignal.timeout(Math.max(250, Number(options.timeoutMs) || 4000)),
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    const error = new Error(`Could not verify the configured ComfyUI runtime at ${baseUrl || url}.`, { cause });
    error.code = 'comfy_runtime_unreachable';
    error.status = 503;
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(`ComfyUI runtime verification failed with HTTP ${response?.status || 'error'}.`);
    error.code = 'comfy_runtime_unreachable';
    error.status = 503;
    throw error;
  }
  const observed = observedComfyInstance(baseUrl, await response.json(), options);
  const match = compareComfyRuntime(expected, observed, options);
  return Object.freeze({ expected, observed, match: Object.freeze(match) });
}

function assertVerifiedComfyRuntime(attestation) {
  if (['verified', 'remote'].includes(attestation?.match?.status)) return attestation;
  const mismatch = (attestation?.match?.mismatches || []).join(', ');
  const error = new Error(attestation?.match?.status === 'foreign'
    ? `Mix Studio reached a different ComfyUI installation than the one configured${mismatch ? ` (${mismatch})` : ''}. Start the configured installation or reconnect it in Generation Setup.`
    : 'Mix Studio could not verify that the running ComfyUI belongs to the configured installation. Reconnect it in Generation Setup before generating.');
  error.code = attestation?.match?.code || 'comfy_runtime_identity_unavailable';
  error.status = 409;
  error.attestation = attestation;
  throw error;
}

module.exports = {
  RUNTIME_IDENTITY_VERSION,
  argvOption,
  assertVerifiedComfyRuntime,
  attestComfyEndpoint,
  canonicalPath,
  compareComfyRuntime,
  expectedComfyInstallation,
  observedComfyInstance,
  sourcePathFromArgv,
  stableHash,
};
