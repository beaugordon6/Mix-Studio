'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const journal = fs.readFileSync(path.join(root, 'lib', 'job-journal.js'), 'utf8');
const attachment = fs.readFileSync(path.join(root, 'lib', 'catalog-attachment-finalizer.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('upscale jobs and their parent-child checkpoints survive restart', () => {
  assert.match(journal, /'upscale'/);
  assert.match(journal, /childReceipts:/);
  assert.match(journal, /attachmentFinalization:/);
  assert.match(journal, /attachmentDescriptor:/);
  assert.match(journal, /sourceAsset:/);
});

test('standalone upscale records the durable job before any external side effect', () => {
  const route = between(server, "if (route === '/api/upscale'", "if (route === '/api/director/assets'");
  const queue = between(server, 'async function queueDurableUpscale(', 'function ultimateSdUpscaleReadinessError(');
  assert.match(route, /queueDurableUpscale\(item, opts, req\.profile\.id\)/);
  assert.doesNotMatch(route, /queuePrompt\(/);
  assert.ok(queue.indexOf('trackJob(receipt.id, job)') < queue.indexOf('submitDurableUpscale(job)'));
});

test('durable upscale restores exact source bytes and keeps one stable provider id', () => {
  const stage = between(server, 'async function stageDurableUpscaleInput(', 'async function submitDurableUpscale(');
  const submit = between(server, 'async function submitDurableUpscale(', 'async function queueDurableUpscale(');
  assert.match(stage, /hashAsset\(content\) !== job\.sourceAsset\?\.sha256/);
  assert.match(stage, /uploaded !== job\.sourceAsset\.logicalName/);
  assert.match(submit, /promptId: pid/);
  assert.match(submit, /queuedPid !== pid/);
  assert.match(submit, /markChildAwaitingRecovery/);
});

test('post-upscale child is persisted and queued before the completed parent is removed', () => {
  const eligibility = between(server, 'function durableGenerationFinalizationEligible(', 'function finalizationStagingPath(');
  const children = between(server, 'async function ensurePostUpscaleChildren(', 'async function settleDurableGalleryResult(');
  const settle = between(server, 'async function settleDurableGalleryResult(', 'async function resumeDurableGalleryFromLocal(');
  assert.doesNotMatch(eligibility, /postUpscale/);
  assert.ok(children.indexOf('persistJob(pid, { childReceipts: receipts })') < children.indexOf('queueDurableUpscale('));
  assert.ok(settle.indexOf('await ensurePostUpscaleChildren(pid, job, created)') < settle.indexOf('jobs.delete(pid)'));
});

test('upscale output uses the durable image download and attachment finalizer', () => {
  const completion = between(server, "if (job.kind === 'upscale')", "if (job.kind === 'imageComposite')");
  const finalization = between(server, 'async function finalizeDurableUpscale(', 'async function resumeDurableUpscaleFromLocal(');
  assert.match(completion, /downloadImageOutput\(files\[0\]\)/);
  assert.match(completion, /finalizeDurableUpscale\(pid, job, buf, durationMs\)/);
  assert.match(server, /markUpscaleChildOutputReady\(pid, job\)/);
  assert.ok(finalization.indexOf('persistJob(pid, {') < finalization.indexOf('stageDurableOutput('));
  assert.match(finalization, /durableAttachmentFinalizer\.finalize\(descriptor\)/);
  assert.match(server, /transitionChildReceipt\(receipt, 'finalized'/);
});

test('attachment publication is immutable and catalog switch clears pending atomically', () => {
  assert.match(attachment, /deterministicGalleryIdentity\(operationId/);
  assert.match(attachment, /fsImpl\.link\(temporary, path\.join\(mediaDirectory, output\.filename\)\)/);
  const apply = between(attachment, 'function applyReplaceUpscale(', 'const BUILTIN_STRATEGIES');
  assert.match(apply, /target\.upscaled = receipt\.output\.filename/);
  assert.match(apply, /target\.upscalePending = false/);
  assert.match(apply, /delete target\.upscalePendingOperationId/);
  assert.match(apply, /database\.history\.unshift\(history\)/);
});
