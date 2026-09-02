'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createJobJournal } = require('../lib/job-journal');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

test('generation submission stages Element inputs before posting a prompt', () => {
  assert.match(server, /async function queuePrompt\(graph, options = \{\}\) \{[\s\S]*?await stageElementInputs\(\{[\s\S]*?uploadFile: uploadFileToComfy,[\s\S]*?comfyFetch\('\/prompt'/);
  assert.match(server, /queueGenerationJob[\s\S]*?const pid = crypto\.randomUUID\(\)[\s\S]*?trackJob\(pid, job\)[\s\S]*?submitDurableGeneration\(pid, job\)/);
  assert.match(server, /submitDurableGeneration[\s\S]*?submissionState: 'staging'[\s\S]*?stageQueuedElementInputs\(job\)[\s\S]*?submissionState: 'submitting'[\s\S]*?queuePrompt\(job\.graph,[\s\S]*?promptId: pid/);
  assert.match(server, /queuePrompt\(graph, options = \{\}\)[\s\S]*?assertWorkflowCapability\(options\.workflowContractId, graph, await getObjectInfo\(\)\)/);
  assert.match(server, /if \(stablePromptId\) body\.prompt_id = stablePromptId/);
  assert.ok(server.indexOf('trackJob(pid, job)') < server.indexOf('submitDurableGeneration(pid, job)'), 'intent is durable before staging or submission');
});

test('Element input manifests survive restart recovery and queue reorder', () => {
  assert.match(server, /requeueMissingDurableJob[\s\S]*?elementInputNames: job\.elementInputNames/);
  assert.match(server, /requeueMissingDurableJob[\s\S]*?promptId: pid[\s\S]*?nextJobId: pid/);
  const reorder = server.slice(server.indexOf("route === '/api/queue/reorder'"), server.indexOf("route === '/api/queue/cancel'"));
  assert.ok(reorder.indexOf('stageQueuedElementInputs') < reorder.indexOf('body: JSON.stringify({ delete: pendingIds })'));
  assert.match(reorder, /elementInputNames: job\.elementInputNames/);
  assert.match(reorder, /elementInputsStaged: true/);
  assert.match(server, /elementNeedsAttention[\s\S]*?recoveryError[\s\S]*?attentionRequired: true/);
  assert.match(server, /requeueMissingDurableJob[\s\S]*?recoveryError\?\.attentionRequired\) return false/);
  assert.match(server, /const attentionRows = attentionQueueRows\(jobs,[\s\S]*?profileId: req\.profile\.id/);
  assert.match(server, /const upcoming = attentionRows\.concat\(db\.smartRuns/);
  assert.match(app, /j\.attentionRequired \? 'Attention'/);
  assert.match(app, /j\.attentionRequired && j\.error \? `\$\{j\.label\} — \$\{j\.error\}`/);
  assert.match(style, /\.q-state\.attention[\s\S]*?\.queue-row\.attention \.q-label/);
});

test('durable job journal preserves Element input manifests', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-element-journal-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'jobs.json');
  const journal = createJobJournal(file);
  journal.put('prompt-1', {
    kind: 'gen',
    profileId: 'owner',
    params: { prompt: '@hermes' },
    graph: { source: { class_type: 'LoadImage', inputs: { image: 'ks_hermes.jpg' } } },
    refImageNames: ['ks_hermes.jpg'],
    elementInputNames: ['ks_hermes.jpg'],
  });
  const restored = createJobJournal(file).entries();
  assert.deepEqual(restored[0][1].elementInputNames, ['ks_hermes.jpg']);
});

test('legacy journals infer Element input manifests from generation metadata', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-element-legacy-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'jobs.json');
  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'legacy-prompt',
      job: {
        kind: 'gen', profileId: 'owner', graph: { source: { class_type: 'LoadImage', inputs: { image: 'ks_hermes.jpg' } } },
        params: { prompt: '@hermes', elementsUsed: [{ assetNames: ['ks_hermes.jpg'] }] },
        refImageNames: ['ks_hermes.jpg'],
      },
    }],
  }));
  const restored = createJobJournal(file).entries();
  assert.deepEqual(restored[0][1].elementInputNames, ['ks_hermes.jpg']);
});
