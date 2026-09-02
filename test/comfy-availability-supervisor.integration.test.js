'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createComfyAvailabilitySupervisor } = require('../lib/comfy-availability-supervisor');
const { FakeComfy } = require('./support/fake-comfy');

const CANONICAL_SOURCE = '/studio/Mix-ComfyUI';
const FOREIGN_SOURCE = '/applications/ComfyUI';

function statsFor(sourcePath) {
  return {
    system: {
      comfyui_version: '0.34.0',
      python_version: '3.12-test',
      argv: [`${sourcePath}/main.py`, '--listen', '127.0.0.1'],
      mix_source_path: sourcePath,
    },
    devices: [],
  };
}

async function unusedLoopbackUrl() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function getJson(url, pathname) {
  const response = await fetch(`${url}${pathname}`, { signal: AbortSignal.timeout(250) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function queuedIds(queue) {
  return [...(queue.queue_running || []), ...(queue.queue_pending || [])]
    .map((entry) => String(entry[1]));
}

function integrationHarness(options) {
  const canonical = options.canonical;
  const durableJobs = new Map(options.jobs || []);
  const events = [];
  let configuredUrl = options.configuredUrl;
  let startCount = 0;
  let reconcileCount = 0;

  const supervisor = createComfyAvailabilitySupervisor({
    runtime: { comfy: { url: configuredUrl, path: CANONICAL_SOURCE } },
    getConfiguredUrl: () => configuredUrl,
    probe: async (url) => {
      events.push(`probe:${url}`);
      try {
        await getJson(url, '/system_stats');
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    discover: async () => {
      events.push('discover');
      return typeof options.discover === 'function' ? options.discover() : [];
    },
    attest: async (url) => {
      events.push(`attest:${url}`);
      const stats = await getJson(url, '/system_stats');
      const observedSource = stats?.system?.mix_source_path || '';
      return {
        observed: { url, sourcePath: observedSource },
        match: {
          status: observedSource === CANONICAL_SOURCE ? 'verified' : 'foreign',
          mismatches: observedSource === CANONICAL_SOURCE ? [] : ['sourcePath'],
        },
      };
    },
    adopt: async (url) => {
      events.push(`adopt:${url}`);
      configuredUrl = url;
    },
    startStatus: () => ({ canStart: true, kind: 'python', requiresUserAction: false }),
    start: async () => {
      startCount += 1;
      events.push('start');
      if (typeof options.start === 'function') await options.start();
      return {};
    },
    wait: async () => new Promise((resolve) => setTimeout(resolve, 5)),
    reconcile: async ({ url }) => {
      reconcileCount += 1;
      events.push(`reconcile:${url}`);
      const [queue, history] = await Promise.all([
        getJson(url, '/queue'),
        getJson(url, '/history'),
      ]);
      const remoteQueued = new Set(queuedIds(queue));
      for (const [id, job] of durableJobs) {
        if (remoteQueued.has(id)) job.state = 'queued';
        else if (history[id]) job.state = history[id]?.status?.completed ? 'completed' : 'failed';
        else job.state = 'preserved';
      }
    },
    maxLaunchAttempts: 1,
    readinessChecksPerAttempt: 8,
    readinessIntervalMs: 5,
    backoffMs: [5],
  });

  return {
    canonical,
    durableJobs,
    events,
    supervisor,
    configuredUrl: () => configuredUrl,
    startCount: () => startCount,
    reconcileCount: () => reconcileCount,
  };
}

test('offline recovery performs one real HTTP start, attests, adopts, and reconciles preserved work', async (t) => {
  const fake = new FakeComfy({ systemStats: statsFor(CANONICAL_SOURCE) });
  t.after(() => fake.close());
  const jobId = '3019f0ee-acde-4ef2-b078-e7058b1203d0';
  fake.enqueue(jobId, { state: 'pending', prompt: { output: { class_type: 'SaveImage' } } });

  const harness = integrationHarness({
    canonical: fake,
    configuredUrl: await unusedLoopbackUrl(),
    jobs: [[jobId, { state: 'preserved' }]],
    discover: () => fake.url ? [{ url: fake.url, source: 'process' }] : [],
    start: () => fake.start(),
  });

  const websocketRecovery = harness.supervisor.ensure('websocket_close');
  const uploadRecovery = harness.supervisor.ensure('upload_failure');
  assert.equal(websocketRecovery, uploadRecovery, 'concurrent failures must share one recovery flight');

  const [first, second] = await Promise.all([websocketRecovery, uploadRecovery]);
  assert.equal(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.launched, true);
  assert.equal(first.url, fake.url);
  assert.equal(harness.startCount(), 1);
  assert.equal(harness.reconcileCount(), 1);
  assert.equal(harness.configuredUrl(), fake.url);
  assert.equal(harness.durableJobs.get(jobId).state, 'queued');

  const attestIndex = harness.events.indexOf(`attest:${fake.url}`);
  const adoptIndex = harness.events.indexOf(`adopt:${fake.url}`);
  const reconcileIndex = harness.events.indexOf(`reconcile:${fake.url}`);
  assert.ok(attestIndex >= 0 && attestIndex < adoptIndex);
  assert.ok(adoptIndex < reconcileIndex);
  assert.ok(fake.requests.some((entry) => entry.method === 'GET' && entry.route === '/queue'));
  assert.ok(fake.requests.some((entry) => entry.method === 'GET' && entry.route === '/history'));
});

test('a real foreign listener on the saved address is rejected without launch, adoption, or reconciliation', async (t) => {
  const foreign = await new FakeComfy({ systemStats: statsFor(FOREIGN_SOURCE) }).start();
  t.after(() => foreign.close());
  const harness = integrationHarness({
    canonical: foreign,
    configuredUrl: foreign.url,
    discover: () => [],
  });

  await assert.rejects(harness.supervisor.ensure('boot'), (error) => (
    error.code === 'comfy_runtime_mismatch'
      && error.status === 409
      && error.details.mismatches.includes('sourcePath')
  ));

  assert.equal(harness.startCount(), 0);
  assert.equal(harness.reconcileCount(), 0);
  assert.equal(harness.configuredUrl(), foreign.url);
  assert.equal(harness.events.some((entry) => entry.startsWith('adopt:')), false);
  assert.ok(foreign.requests.some((entry) => entry.method === 'GET' && entry.route === '/system_stats'));
});

test('a canonical service discovered on a drifted port is attested and adopted without starting another process', async (t) => {
  const canonical = await new FakeComfy({ systemStats: statsFor(CANONICAL_SOURCE) }).start();
  t.after(() => canonical.close());
  const completedId = '7f1fd35c-12b7-4070-a759-f70533f209f0';
  canonical.completePrompt(completedId, { outcome: 'success', outputs: { save: { images: [] } } });
  const originalUrl = await unusedLoopbackUrl();
  const harness = integrationHarness({
    canonical,
    configuredUrl: originalUrl,
    jobs: [[completedId, { state: 'preserved' }]],
    discover: () => [{ url: canonical.url, source: 'process' }],
  });

  const result = await harness.supervisor.ensure('poll_failure');

  assert.equal(result.ok, true);
  assert.equal(result.launched, false);
  assert.equal(result.url, canonical.url);
  assert.equal(harness.startCount(), 0);
  assert.equal(harness.reconcileCount(), 1);
  assert.equal(harness.configuredUrl(), canonical.url);
  assert.equal(harness.durableJobs.get(completedId).state, 'completed');
  assert.ok(harness.events.indexOf(`attest:${canonical.url}`) < harness.events.indexOf(`adopt:${canonical.url}`));
  assert.ok(harness.events.indexOf(`adopt:${canonical.url}`) < harness.events.indexOf(`reconcile:${canonical.url}`));
});
