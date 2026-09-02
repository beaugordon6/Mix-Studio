'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCatalogAttachmentReceipt } = require('../lib/catalog-attachment-finalizer');
const { hashAsset } = require('../lib/gallery-finalization');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = server.indexOf(start);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  const to = server.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return server.slice(from, to);
}

test('pre-submit durable upscale states enter reconciliation instead of being skipped forever', () => {
  const polling = sourceBetween(
    '/* Polling fallback: no native WebSocket',
    '/* ------------------------------------------------------------------ */\n/* Prompt enhance',
  );

  assert.doesNotMatch(
    polling,
    /if \(\['staging', 'submitting', 'reconciling'\]\.includes\(job\.submissionState\)\) continue;/,
    'a crash-persisted pre-submit state needs queue/history reconciliation; an unconditional continue strands it forever',
  );
  assert.match(
    polling,
    /requeueMissingDurableJob\(pid, job\)/,
    'the poller must route a remotely absent durable upscale through the stable-ID reconciliation path',
  );
});

test('durable attachment replay is attempted before a cancellation tombstone can delete the job', () => {
  const polling = sourceBetween(
    '/* Polling fallback: no native WebSocket',
    '/* ------------------------------------------------------------------ */\n/* Prompt enhance',
  );
  const cancellation = polling.indexOf('reconcileDurableCancellation(pid, durableJob)');
  const attachmentReplay = polling.indexOf('resumeDurableUpscaleFromLocal(pid, durableJob)');

  assert.notEqual(cancellation, -1, 'durable cancellation must remain reconciled');
  assert.notEqual(attachmentReplay, -1, 'durable attachment replay must remain wired');
  assert.ok(
    attachmentReplay < cancellation,
    'a completed attachment/database checkpoint must be reconciled before cancellation removes its journal entry',
  );
});

test('supervisor recovery also replays a durable attachment before cancellation', () => {
  const recovery = sourceBetween(
    'async function reconcilePreservedJobsAfterComfyRecovery()',
    'function getComfyAvailabilitySupervisor()',
  );
  const cancellation = recovery.indexOf('reconcileDurableCancellation(pid, job)');
  const attachmentReplay = recovery.indexOf('resumeDurableUpscaleFromLocal(pid, job)');

  assert.notEqual(cancellation, -1);
  assert.notEqual(attachmentReplay, -1);
  assert.ok(attachmentReplay < cancellation);
  assert.match(recovery, /for \(const \[pid, job\][\s\S]*try \{[\s\S]*catch \(error\)[\s\S]*submissionState: 'attention'/);
  assert.match(recovery, /Other queued work will continue recovering/);
});

test('attachment source preconditions retain the exact source digest and byte length', () => {
  const source = Buffer.from('source image version');
  const output = Buffer.from('upscaled output');
  const receipt = createCatalogAttachmentReceipt({
    operationId: '780d9cc9-a18f-452d-8ccd-a21a60bfea89',
    strategy: 'replace_upscale',
    profileId: 'owner',
    target: {
      itemId: 'item-1',
      sourceVersion: {
        file: 'source.png',
        attachment: null,
        receiptId: null,
        sha256: hashAsset(source),
        bytes: source.length,
      },
    },
    output: {
      extension: '.png',
      sha256: hashAsset(output),
      bytes: output.length,
    },
  });

  assert.equal(receipt.target.sourceVersion.sha256, hashAsset(source));
  assert.equal(receipt.target.sourceVersion.bytes, source.length);

  const descriptor = sourceBetween(
    'function durableUpscaleDescriptor(job, content, durationMs)',
    'function settleDurableUpscaleResult',
  );
  assert.match(descriptor, /sourceVersion:[\s\S]*sha256:\s*job\.sourceAsset\?\.sha256/);
  assert.match(descriptor, /sourceVersion:[\s\S]*bytes:\s*job\.sourceAsset\?\.bytes/);
});

test('only the owner can issue a global shared-Comfy queue reset', () => {
  const reset = sourceBetween(
    "if (route === '/api/queue/reset' && req.method === 'POST')",
    "if (route === '/api/private/status')",
  );

  assert.match(reset, /if \(!isAdmin\(\)\) return json\(res, 403,/);
  assert.ok(
    reset.indexOf('if (!isAdmin())') < reset.indexOf('comfyResetRequests()'),
    'the owner guard must run before global Comfy queue or interrupt calls',
  );
});
