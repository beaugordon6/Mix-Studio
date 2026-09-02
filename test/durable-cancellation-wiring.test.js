'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('durable image cancellation is persisted before any Comfy request', () => {
  const route = server.slice(
    server.indexOf("route === '/api/queue/cancel'"),
    server.indexOf("route === '/api/queue/reset'"),
  );
  assert.ok(route.indexOf('persistJob(pid, {') < route.indexOf('reconcileDurableCancellation(pid, job)'));
  assert.match(route, /cancelRequested: true[\s\S]*?cancelRequestedAt: Date\.now\(\)[\s\S]*?submissionState:[\s\S]*?'cancel_requested'/);
  assert.match(route, /if \(\['gen', 'loraHunt'\]\.includes\(job\.kind\)\)[\s\S]*?pending: cancellation\.pending/);
});

test('reconciliation suppresses completion while a durable cancellation tombstone exists', () => {
  assert.match(server, /if \(durableJob\?\.cancelRequested && \['gen', 'loraHunt'\]\.includes\(durableJob\.kind\)\) \{[\s\S]*?reconcileDurableCancellation\(pid, durableJob\);[\s\S]*?continue;/);
  assert.match(server, /interrupt_running_prompt[\s\S]*?body: JSON\.stringify\(\{ prompt_id: action\.promptId \}\)/);
  assert.match(server, /delete_queued_prompt[\s\S]*?body: JSON\.stringify\(\{ delete: \[action\.promptId\] \}\)/);
});

test('queue UI reports a retained cancellation instead of claiming it was removed', () => {
  assert.match(app, /j\.cancelling \? 'Cancelling'/);
  assert.match(app, /result\.pending \? 'Cancellation saved — waiting for ComfyUI'/);
  assert.match(app, /!!j\.cancelling \|\| j\.cancellable === false/);
});
