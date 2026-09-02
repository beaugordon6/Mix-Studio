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

test('ephemeral jobs are not persisted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-job-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = createJobJournal(path.join(root, 'pending.json'));
  assert.equal(journal.put('prompt-1', { kind: 'enhance', profileId: 'owner', params: {}, graph: {} }), false);
  assert.deepEqual(journal.entries(), []);
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
