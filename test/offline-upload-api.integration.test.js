'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
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
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

async function crashServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not exit after SIGKILL')), 1500)),
  ]);
}

test('acknowledged offline upload survives immediate Mix process loss and remains byte-identical', async (t) => {
  const dataDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-offline-upload-api-'));
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
  let child = await startServer(dataDirectory, port);
  t.after(async () => {
    await stopServer(child);
    await fsp.rm(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const original = Buffer.from('offline-input-exact-bytes');
  const upload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Filename': encodeURIComponent('offline-reference.png'),
      'X-Asset-Catalog': '1',
    },
    body: original,
  });
  const result = await upload.json();
  assert.equal(upload.status, 202);
  assert.equal(result.durable, true);
  assert.equal(result.staged, false);
  assert.ok(result.asset?.id);
  assert.ok(result.asset?.name);

  await crashServer(child);
  child = await startServer(dataDirectory, port);
  const restored = await fetch(`${base}/api/input?name=${encodeURIComponent(result.name)}`);
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), original);

  const manifests = await fsp.readdir(path.join(dataDirectory, 'durable-input-manifests'));
  const assets = await fsp.readdir(path.join(dataDirectory, 'durable-input-assets'));
  assert.equal(manifests.length, 1);
  assert.equal(assets.length, 1);
  assert.equal((await fsp.readdir(path.join(dataDirectory, 'inputs'))).some((name) => name.endsWith('.tmp')), false);
});
