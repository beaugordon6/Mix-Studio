'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs').promises;
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startServer(dataDirectory, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      MIXBOX_DATA_DIR: dataDirectory,
      MIXBOX_COMFY_URL: 'http://127.0.0.1:9',
      COMFYUI_PATH: path.join(dataDirectory, 'missing-comfy'),
      COMFYUI_MODELS_DIR: path.join(dataDirectory, 'missing-models'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes('Mix Studio running')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}:\n${output}`));
    });
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
}

test('request failures get correlation IDs and appear in the owner support bundle without content', async (t) => {
  const dataDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-incident-api-'));
  let port;
  try {
    port = await availablePort();
  } catch (error) {
    await fsp.rm(dataDirectory, { recursive: true, force: true });
    if (['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('This sandbox does not permit loopback test servers');
      return;
    }
    throw error;
  }
  const child = await startServer(dataDirectory, port);
  t.after(async () => {
    await stopServer(child);
    await fsp.rm(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const secretContent = 'private prompt and filename.jpg';
  const failed = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{${secretContent}`,
  });
  const failure = await failed.json();
  const correlationId = failed.headers.get('x-mix-correlation-id');
  assert.equal(failed.status, 500);
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(failure.correlationId, correlationId);
  assert.equal(failure.code, 'unclassified_server_error');

  const response = await fetch(`${base}/api/support-bundle`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="mix-studio-support-/);
  const text = await response.text();
  const bundle = JSON.parse(text);
  assert.equal(bundle.privacy.promptsExcluded, true);
  assert.equal(bundle.summary.byCode.unclassified_server_error, 1);
  assert.equal(bundle.incidents[0].correlationId, correlationId);
  assert.equal(text.includes(secretContent), false);
  assert.equal(text.includes(dataDirectory), false);
});
