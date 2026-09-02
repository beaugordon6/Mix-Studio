#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createJobJournal, recoverableGenerationJob } = require('../lib/job-journal');
const { profileOutputFolder } = require('../lib/output-prefix');
const { resolveRuntimeConfig } = require('../lib/runtime-config');

async function main() {
  const promptId = String(process.argv[2] || '').trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(promptId)) throw new Error('Pass the ComfyUI prompt id to recover');
  const root = path.resolve(__dirname, '..');
  const runtime = resolveRuntimeConfig(root);
  const settings = JSON.parse(fs.readFileSync(path.join(runtime.dataDir, 'settings.json'), 'utf8'));
  const db = JSON.parse(fs.readFileSync(path.join(runtime.dataDir, 'db.json'), 'utf8'));
  const url = String(settings.comfyUrl || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const response = await fetch(`${url}/history/${encodeURIComponent(promptId)}`);
  if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`);
  const history = (await response.json())[promptId];
  if (!history?.status?.completed) throw new Error('That ComfyUI prompt is not complete');
  const profiles = (db.profiles || []).map((profile) => ({
    id: profile.id,
    outputFolder: profileOutputFolder(profile),
  }));
  const job = recoverableGenerationJob(history, profiles);
  if (!job) throw new Error('The prompt is not a recoverable Mix Studio image generation');
  const journal = createJobJournal(path.join(runtime.dataDir, 'pending-jobs.json'));
  journal.put(promptId, job);
  console.log(`Queued completed ComfyUI image ${promptId} for safe Mix Studio recovery.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
