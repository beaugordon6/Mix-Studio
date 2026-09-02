'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function between(start, end) {
  const from = server.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = server.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return server.slice(from, to);
}

test('queue reorder persists the complete stable-ID receipt before remote cancellation', () => {
  const route = between(
    "if (route === '/api/queue/reorder' && req.method === 'POST')",
    "if (route === '/api/queue/cancel' && req.method === 'POST')",
  );
  const persist = route.indexOf('persistQueueReorderReceipt(createQueueReorderReceipt');
  assert.notEqual(persist, -1);
  assert.doesNotMatch(route, /jobs\.delete\(oldPid\)|jobs\.set\(newPid/);
  assert.doesNotMatch(route, /const newPid = await queuePrompt/);
  assert.match(route, /Object\.fromEntries\(order\.map\(\(promptId\) => \[promptId, promptId\]\)\)/);
});

test('reorder actions are receipt-driven and keep original prompt IDs', () => {
  const runner = between('async function resumeQueueReorder()', '/* --------------------------- WebSocket');
  assert.match(runner, /planQueueReorder\(queueReorderReceipt, snapshot/);
  assert.ok(
    runner.indexOf('persistQueueReorderReceipt(plan.receipt)') < runner.indexOf("plan.type === 'cancel_pending'"),
    'planner checkpoints must be persisted before cancellation actions',
  );
  assert.match(runner, /promptId: plan\.promptId/);
  assert.match(runner, /job = jobs\.get\(plan\.promptId\);[\s\S]*job\.cancelRequested[\s\S]*cancelTombstone: job\.cancelRequested === true/);
  assert.match(runner, /recordQueueReorderSubmitOutcome[\s\S]*'ambiguous'/);
});

test('normal recovery cannot race a durable queue reorder', () => {
  const supervisor = between(
    'async function reconcilePreservedJobsAfterComfyRecoveryInner()',
    'function getComfyAvailabilitySupervisor()',
  );
  const poller = between(
    '/* Polling fallback: no native WebSocket',
    '/* ------------------------------------------------------------------ */\n/* Prompt enhance',
  );
  assert.match(supervisor, /await resumeQueueReorder\(\);[\s\S]*reorderingIds\.has\(pid\)/);
  assert.match(poller, /await resumeQueueReorder\(\);[\s\S]*reorderingIds\.has\(pid\)/);
});

test('cancel and reset cannot mutate jobs owned by an active reorder receipt', () => {
  const cancel = between(
    "if (route === '/api/queue/cancel' && req.method === 'POST')",
    "if (route === '/api/queue/reset' && req.method === 'POST')",
  );
  const reset = between(
    "if (route === '/api/queue/reset' && req.method === 'POST')",
    "if (route === '/api/private/status')",
  );
  assert.match(cancel, /activeQueueReorderIds\(\)\.has\(pid\)[\s\S]*queue_reorder_active/);
  assert.match(reset, /activeQueueReorderIds\(\)\.size[\s\S]*queue_reorder_active/);
});

test('recovery-internal requests never await their own supervisor flight', () => {
  const fetcher = between('async function comfyFetch(p, opts)', 'async function inspectComfySubmission');
  assert.match(server, /const comfyRecoveryContext = new AsyncLocalStorage\(\)/);
  assert.match(fetcher, /comfyRecoveryContext\.getStore\(\)\?\.suppressRecovery/);
  assert.ok(
    fetcher.indexOf('comfyRecoveryContext.getStore()?.suppressRecovery') < fetcher.indexOf('ensureComfyAvailability('),
  );
});
