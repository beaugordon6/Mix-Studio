'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const journal = fs.readFileSync(path.join(root, 'lib', 'job-journal.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('ordinary Create, Edit, and Element jobs use the durable gallery adapter', () => {
  const eligibility = between(server, 'function durableGenerationFinalizationEligible(', 'function finalizationNeedsAttention(');
  const completion = between(server, 'async function completeJob(', '/* Polling fallback:');
  assert.match(eligibility, /job\?\.kind === 'gen'/);
  assert.doesNotMatch(eligibility, /!job\.params\?\.postUpscale/);
  assert.match(eligibility, /!job\.params\?\.editSequence/);
  assert.match(completion, /createGalleryFinalizationManifest\(/);
  assert.match(completion, /durableGalleryFinalizer\.finalize\(/);
  assert.match(completion, /downloadImageOutput\(outputFile\)/);
  assert.match(completion, /stageDurableOutput\(/);
  assert.match(completion, /elementsUsed:/);
  assert.ok(completion.indexOf("submissionState: 'output_ready'") < completion.indexOf('downloadImageOutput(outputFile)'));
  assert.match(completion, /if \(!files\.length\)[\s\S]*durableGenerationFinalizationEligible\(pid, job\)[\s\S]*deferDurableFinalization/);
  const settle = between(server, 'async function settleDurableGalleryResult(', 'async function resumeDurableGalleryFromLocal(');
  assert.ok(settle.indexOf('await ensurePostUpscaleChildren(pid, job, created)') < settle.indexOf('jobs.delete(pid)'));
});

test('finalization checkpoints survive restart and prevent resubmission', () => {
  const requeue = between(server, 'async function requeueMissingDurableJob(', 'function queueEntryCreatedAt(');
  const polling = between(server, '/* Polling fallback:', '/* Prompt enhance');
  assert.match(journal, /finalization: job\.finalization \|\| undefined/);
  assert.match(journal, /finalizationOutputs:/);
  assert.match(requeue, /job\.finalization \|\| job\.attachmentFinalization/);
  assert.match(requeue, /\['output_ready', 'finalizing', 'finalized'\]/);
  assert.match(polling, /resumeDurableGalleryFromLocal/);
  assert.match(server, /stagedDurableOutput\([\s\S]*durableGalleryFinalizer\.finalize/);
});

test('database commit is synchronous before the durable job is removed', () => {
  const durableWrite = between(server, 'function saveJsonDurablySync(', 'function normalizeSettings(');
  const flush = between(server, 'function flushDbNow(', 'function durableGalleryTransaction(');
  const transaction = between(server, 'function durableGalleryTransaction(', 'function uid(');
  const settle = between(server, 'function settleDurableGalleryResult(', 'async function resumeDurableGalleryFromLocal(');
  assert.ok(durableWrite.indexOf('fs.fsyncSync(descriptor)') < durableWrite.indexOf('fs.renameSync(tmp, file)'));
  assert.match(durableWrite, /fs\.fsyncSync\(directoryDescriptor\)/);
  assert.match(flush, /saveJsonDurablySync\(DB_FILE, db\)/);
  assert.match(transaction, /const result = mutator\(db\)[\s\S]*flushDbNow\(\)/);
  assert.doesNotMatch(transaction, /await mutator/);
  assert.match(settle, /result\.status !== 'complete'[\s\S]*jobs\.delete\(pid\)/);
});

test('resumed output identity is verified before bytes enter durable staging', () => {
  const completion = between(server, 'async function completeJob(', '/* Polling fallback:');
  const mismatch = completion.indexOf("error.code = 'gallery_finalization_asset_content_mismatch'");
  const staging = completion.indexOf('await stageDurableOutput(');
  assert.notEqual(mismatch, -1);
  assert.notEqual(staging, -1);
  assert.ok(mismatch < staging);
});

test('deterministic finalization validation failures stop for attention', () => {
  const classifier = between(server, 'function finalizationNeedsAttention(', 'function deferDurableFinalization(');
  assert.match(classifier, /code\.startsWith\('finalization_'\)/);
  assert.match(classifier, /gallery_finalization_manifest_conflict/);
  assert.match(classifier, /gallery_finalization_database_corrupt/);
});

test('hard reset preserves jobs already committing gallery results', () => {
  const route = between(server, "if (route === '/api/queue/reset'", "if (route === '/api/private/status'");
  assert.match(route, /protectedFinalizations/);
  assert.match(route, /job\.finalization \|\| \['output_ready', 'finalizing', 'finalized'\]/);
  assert.match(route, /clearedJobs = \[\.\.\.jobs\.keys\(\)\]\.filter/);
});
