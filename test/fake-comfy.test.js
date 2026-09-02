'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FakeComfy } = require('./support/fake-comfy');

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.ok, true);
  return response.json();
}

async function fixture(t) {
  const comfy = await new FakeComfy().start();
  t.after(() => comfy.close());
  return comfy;
}

test('accepts a caller-supplied UUID and exposes it through queue then history', async (t) => {
  const comfy = await fixture(t);
  const promptId = crypto.randomUUID();
  const accepted = await jsonRequest(`${comfy.url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: promptId, prompt: { save: { class_type: 'SaveImage', inputs: {} } } }),
  });
  assert.equal(accepted.prompt_id, promptId);

  const queued = await jsonRequest(`${comfy.url}/queue`);
  assert.deepEqual(queued.queue_pending.map((entry) => entry[1]), [promptId]);
  assert.deepEqual(await jsonRequest(`${comfy.url}/history/${promptId}`), {});

  comfy.startPrompt(promptId);
  comfy.completePrompt(promptId, { outputs: { save: { images: [{ filename: 'result.png' }] } } });
  const history = await jsonRequest(`${comfy.url}/history/${promptId}`);
  assert.equal(history[promptId].status.status_str, 'success');
  assert.equal(history[promptId].status.completed, true);
  assert.deepEqual((await jsonRequest(`${comfy.url}/queue`)).queue_running, []);
});

test('models an accepted prompt whose HTTP response is dropped', async (t) => {
  const comfy = await fixture(t);
  const promptId = crypto.randomUUID();
  comfy.fault('prompt.afterAccept', 'drop');

  await assert.rejects(fetch(`${comfy.url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: promptId, prompt: {} }),
  }));

  assert.equal(comfy.submissionCount(promptId), 1);
  const queue = await jsonRequest(`${comfy.url}/queue`);
  assert.equal(queue.queue_pending[0][1], promptId);
});

test('does not provide server-side deduplication for duplicate prompt UUIDs', async (t) => {
  const comfy = await fixture(t);
  const promptId = crypto.randomUUID();
  const body = JSON.stringify({ prompt_id: promptId, prompt: {} });
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
  await jsonRequest(`${comfy.url}/prompt`, options);
  await jsonRequest(`${comfy.url}/prompt`, options);

  assert.equal(comfy.submissionCount(promptId), 2);
  const queue = await jsonRequest(`${comfy.url}/queue`);
  assert.deepEqual(queue.queue_pending.map((entry) => entry[1]), [promptId, promptId]);
});

test('cancels pending and running prompts using Comfy-compatible routes', async (t) => {
  const comfy = await fixture(t);
  const pendingId = comfy.enqueue(crypto.randomUUID());
  const runningId = comfy.enqueue(crypto.randomUUID(), { state: 'running' });

  await jsonRequest(`${comfy.url}/queue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: [pendingId] }),
  });
  assert.equal(comfy.snapshot().cancelled.includes(pendingId), true);
  assert.equal(comfy.snapshot().history[pendingId], undefined);

  const cancelled = await jsonRequest(`${comfy.url}/api/jobs/${runningId}/cancel`, { method: 'POST' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(comfy.snapshot().history[runningId].status.messages[0][0], 'execution_interrupted');
  assert.deepEqual(comfy.snapshot().queue, { queue_running: [], queue_pending: [] });
});

test('fault points are deterministic, one-shot, and distinguish before from after side effects', async (t) => {
  const comfy = await fixture(t);
  const beforeId = crypto.randomUUID();
  comfy.fault('prompt.beforeAccept', { type: 'http', status: 503, body: { error: 'offline' } });
  const rejected = await fetch(`${comfy.url}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: beforeId, prompt: {} }),
  });
  assert.equal(rejected.status, 503);
  assert.equal(comfy.submissionCount(beforeId), 0);

  // The queued fault was consumed, so the exact retry now succeeds.
  const accepted = await jsonRequest(`${comfy.url}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: beforeId, prompt: {} }),
  });
  assert.equal(accepted.prompt_id, beforeId);

  comfy.fault('queue.beforeResponse', 'drop');
  await assert.rejects(fetch(`${comfy.url}/queue`));
  assert.equal((await jsonRequest(`${comfy.url}/queue`)).queue_pending.length, 1);

  comfy.fault('cancel.afterApply', 'drop');
  await assert.rejects(fetch(`${comfy.url}/queue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: [beforeId] }),
  }));
  assert.equal(comfy.snapshot().cancelled.includes(beforeId), true);
  assert.equal((await jsonRequest(`${comfy.url}/queue`)).queue_pending.length, 0);
});

test('queued faults at one point execute FIFO without affecting other endpoints', async (t) => {
  const comfy = await fixture(t);
  comfy
    .fault('history.beforeResponse', { type: 'http', status: 502, body: { sequence: 1 } })
    .fault('history.beforeResponse', { type: 'http', status: 504, body: { sequence: 2 } });

  assert.equal((await fetch(`${comfy.url}/history`)).status, 502);
  assert.equal((await jsonRequest(`${comfy.url}/queue`)).queue_pending.length, 0);
  assert.equal((await fetch(`${comfy.url}/history`)).status, 504);
  assert.deepEqual(await jsonRequest(`${comfy.url}/history`), {});
});
