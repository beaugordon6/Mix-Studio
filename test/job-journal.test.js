'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobJournal, recoverableGenerationJob } = require('../lib/job-journal');

test('generation jobs survive a new journal instance and disappear on completion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  const job = { kind: 'gen', profileId: 'owner', params: { prompt: 'test' }, graph: { save: {} } };
  assert.equal(createJobJournal(file).put('prompt-1', job), true);
  assert.equal(createJobJournal(file).entries()[0][0], 'prompt-1');
  const reloaded = createJobJournal(file);
  assert.equal(reloaded.remove('prompt-1'), true);
  assert.deepEqual(createJobJournal(file).entries(), []);
});

test('stable submission lifecycle survives restart before Comfy acknowledgement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  const operationId = '4ecfc3f0-ea78-4e8e-b1e4-7fbf13e24a74';
  const job = {
    kind: 'gen', profileId: 'owner', params: { prompt: 'test' }, graph: { save: {} },
    operationId, promptId: operationId, submissionState: 'submitting',
    submissionAttemptId: '0f6df3a6-b7e0-448d-b2fb-186d05515bd4', submitStartedAt: 123,
    cancelRequested: true, cancelRequestedAt: 124, cancelMessage: 'Cancelled by user',
  };
  assert.equal(createJobJournal(file).put(operationId, job), true);
  const restored = createJobJournal(file).entries()[0][1];
  assert.equal(restored.operationId, operationId);
  assert.equal(restored.promptId, operationId);
  assert.equal(restored.submissionState, 'submitting');
  assert.equal(restored.submissionAttemptId, job.submissionAttemptId);
  assert.equal(restored.cancelRequested, true);
  assert.equal(restored.cancelRequestedAt, 124);
});

test('gallery finalization checkpoints and record descriptors survive restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  const operationId = '7ecfc3f0-ea78-4e8e-b1e4-7fbf13e24a74';
  const finalization = {
    version: 1, operationId, profileId: 'owner', workflow: 'create:krea2-elements',
    phase: 'prepared', completed: false, cancelRequested: false, lateCancellation: false,
    conflict: null, createdAt: 1234,
    outputs: [{ outputIndex: 0, itemId: 'item', filename: 'asset.png' }],
  };
  const finalizationOutputs = [{ outputIndex: 0, item: { prompt: 'test' }, history: { kind: 'gen' } }];
  const job = {
    kind: 'gen', profileId: 'owner', params: { prompt: 'test' }, graph: { save: {} },
    operationId, promptId: operationId, submissionState: 'finalizing',
    finalization, finalizationOutputs, finalizationRetryAt: 5678,
  };
  assert.equal(createJobJournal(file).put(operationId, job), true);
  const restored = createJobJournal(file).entries()[0][1];
  assert.deepEqual(restored.finalization, finalization);
  assert.deepEqual(restored.finalizationOutputs, finalizationOutputs);
  assert.equal(restored.finalizationRetryAt, 5678);
});

test('post-upscale child identity and attachment checkpoints survive restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  const operationId = '8ecfc3f0-ea78-4e8e-b1e4-7fbf13e24a74';
  const receipt = {
    version: 1,
    id: operationId,
    parentId: '7ecfc3f0-ea78-4e8e-b1e4-7fbf13e24a74',
    relation: 'post_upscale',
    ordinal: 0,
    profileId: 'owner',
    state: 'output_ready',
    revision: 4,
  };
  const job = {
    kind: 'upscale', profileId: 'owner', params: { mode: 'upscale' }, graph: { save: {} },
    operationId, promptId: operationId, submissionState: 'finalizing',
    parentOperationId: receipt.parentId, parentReceiptId: receipt.id,
    childReceipts: [receipt], itemId: 'item-1',
    sourceAsset: { file: 'base.png', sha256: 'a'.repeat(64), bytes: 123 },
    upscaleInfo: { engine: 'seedvr2', resolution: 2160 },
    attachmentFinalization: { version: 1, operationId, phase: 'asset_ready' },
    attachmentDescriptor: { history: { kind: 'upscale' } },
  };
  assert.equal(createJobJournal(file).put(operationId, job), true);
  const restored = createJobJournal(file).entries()[0][1];
  assert.equal(restored.kind, 'upscale');
  assert.equal(restored.parentOperationId, receipt.parentId);
  assert.deepEqual(restored.childReceipts, [receipt]);
  assert.deepEqual(restored.sourceAsset, job.sourceAsset);
  assert.deepEqual(restored.upscaleInfo, job.upscaleInfo);
  assert.deepEqual(restored.attachmentFinalization, job.attachmentFinalization);
  assert.deepEqual(restored.attachmentDescriptor, job.attachmentDescriptor);
});

test('legacy durable jobs adopt their journal key as stable operation identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    jobs: [{ id: 'legacy-prompt', job: {
      kind: 'gen', profileId: 'owner', params: { prompt: 'legacy' }, graph: { save: {} },
    } }],
  }));
  const restored = createJobJournal(file).entries()[0][1];
  assert.equal(restored.operationId, 'legacy-prompt');
  assert.equal(restored.promptId, 'legacy-prompt');
  assert.equal(restored.submissionState, 'submitted');
});

test('ephemeral jobs are not persisted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = createJobJournal(path.join(root, 'pending.json'));
  assert.equal(journal.put('prompt-1', { kind: 'enhance', profileId: 'owner', params: {}, graph: {} }), false);
  assert.deepEqual(journal.entries(), []);
});

test('a corrupt durable journal fails closed instead of silently erasing the queue', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  fs.writeFileSync(file, '{"version":1,"jobs":[');
  assert.throws(() => createJobJournal(file), { code: 'job_journal_corrupt' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"jobs":[');
});

test('valid JSON with an invalid journal version or schema fails closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.json');
  const validJob = { kind: 'gen', profileId: 'owner', params: {}, graph: {} };
  for (const [document, code] of [
    [{ version: 2, jobs: [] }, 'job_journal_version_invalid'],
    [{ version: 1 }, 'job_journal_corrupt'],
    [{ version: 1, jobs: [{ id: '', job: {} }] }, 'job_journal_corrupt'],
    [{ version: 1, jobs: [{ id: 'same', job: validJob }, { id: 'same', job: validJob }] }, 'job_journal_corrupt'],
  ]) {
    fs.writeFileSync(file, JSON.stringify(document));
    assert.throws(() => createJobJournal(file), { code });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), document);
  }
});

test('a completed Mix image graph can be reconstructed for disaster recovery', () => {
  const history = {
    prompt: [1, 'pid', {
      pos: { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
      source: { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
      scale: { class_type: 'ImageScale', inputs: { width: 992, height: 736 } },
      sampler: { class_type: 'KSampler', inputs: { seed: 42, steps: 8, cfg: 1, denoise: 0.48 } },
      save: { class_type: 'SaveImage', inputs: { filename_prefix: 'MixStudio/Owner_abc12345/gen' } },
    }, { client_id: 'kreastudio-old', create_time: 100 }],
    status: { messages: [['execution_start', { timestamp: 200 }]] },
  };
  const recovered = recoverableGenerationJob(history, [{ id: 'abc12345zzz', outputFolder: 'Owner_abc12345' }]);
  assert.equal(recovered.profileId, 'abc12345zzz');
  assert.equal(recovered.params.prompt, 'portrait');
  assert.equal(recovered.params.width, 992);
  assert.equal(recovered.params.imageName, 'reference.png');
  assert.deepEqual(recovered.refImageNames, ['reference.png']);
});
