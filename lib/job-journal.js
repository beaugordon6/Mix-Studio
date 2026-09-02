'use strict';

const fs = require('fs');
const path = require('path');

const JOURNAL_VERSION = 1;
const DURABLE_KINDS = new Set(['gen', 'loraHunt']);

function serializableJob(job) {
  if (!job || !DURABLE_KINDS.has(job.kind) || !job.profileId || !job.params || !job.graph) return null;
  const storedElementInputNames = Array.isArray(job.elementInputNames) ? job.elementInputNames : [];
  const inferredElementInputNames = (Array.isArray(job.params.elementsUsed) ? job.params.elementsUsed : [])
    .flatMap((element) => Array.isArray(element?.assetNames) ? element.assetNames : []);
  return {
    kind: job.kind,
    profileId: String(job.profileId),
    operationId: String(job.operationId || ''),
    promptId: String(job.promptId || job.operationId || ''),
    params: job.params,
    graph: job.graph,
    refImageNames: Array.isArray(job.refImageNames) ? job.refImageNames : [],
    elementInputNames: storedElementInputNames.length ? storedElementInputNames : inferredElementInputNames,
    workflowContractId: String(job.workflowContractId || ''),
    recoveryError: job.recoveryError || undefined,
    refinedPrompt: job.refinedPrompt || null,
    huntPlan: job.huntPlan || undefined,
    smartRunId: job.smartRunId || undefined,
    smartStepId: job.smartStepId || undefined,
    recoveryAttempts: Math.max(0, Number(job.recoveryAttempts) || 0),
    submissionState: String(job.submissionState || 'submitted'),
    submissionAttemptId: String(job.submissionAttemptId || ''),
    stagedAt: Number(job.stagedAt) || null,
    submitStartedAt: Number(job.submitStartedAt) || null,
    submittedAt: Number(job.submittedAt) || null,
    lastReconciledAt: Number(job.lastReconciledAt) || null,
    queueNumber: Number.isFinite(Number(job.queueNumber)) ? Number(job.queueNumber) : null,
    cancelRequested: job.cancelRequested === true,
    cancelRequestedAt: Number(job.cancelRequestedAt) || null,
    cancelMessage: job.cancelMessage ? String(job.cancelMessage) : undefined,
    enqueuedAt: Number(job.enqueuedAt) || Date.now(),
    startedAt: Number(job.startedAt) || null,
  };
}

function loadJournal(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== JOURNAL_VERSION || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs
      .map((entry) => {
        if (!entry || typeof entry.id !== 'string') return null;
        const job = serializableJob(entry.job);
        if (!job) return null;
        if (!job.operationId) job.operationId = entry.id;
        if (!job.promptId) job.promptId = entry.id;
        return [entry.id, job];
      })
      .filter((entry) => entry && entry[1]);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[queue] Could not read pending-job journal: ${error.message}`);
    return [];
  }
}

function createJobJournal(file) {
  const records = new Map(loadJournal(file));

  function flush() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      version: JOURNAL_VERSION,
      jobs: [...records].map(([id, job]) => ({ id, job })),
    }, null, 2));
    fs.renameSync(temporary, file);
  }

  return {
    entries() {
      return [...records.entries()];
    },
    put(id, job) {
      const value = serializableJob(job);
      if (!value) return false;
      records.set(String(id), value);
      flush();
      return true;
    },
    remove(id) {
      if (!records.delete(String(id))) return false;
      flush();
      return true;
    },
  };
}

function recoverableGenerationJob(history, profiles) {
  const graph = history?.prompt?.[2];
  const promptMeta = history?.prompt?.[3];
  if (!graph || typeof graph !== 'object' || !String(promptMeta?.client_id || '').startsWith('kreastudio-')) return null;
  const save = Object.values(graph).find((node) => node?.class_type === 'SaveImage');
  const prefix = String(save?.inputs?.filename_prefix || '');
  const profile = (profiles || []).find((entry) => prefix.startsWith(`MixStudio/${entry.outputFolder || ''}/`));
  if (!profile) return null;
  const sampler = Object.values(graph).find((node) => node?.class_type === 'KSampler');
  const positive = Object.values(graph).find((node) => node?.class_type === 'CLIPTextEncode' && typeof node?.inputs?.text === 'string');
  const source = Object.values(graph).find((node) => node?.class_type === 'LoadImage');
  const scale = Object.values(graph).find((node) => node?.class_type === 'ImageScale' && Number(node?.inputs?.width) > 0);
  if (!sampler || !positive || !save) return null;
  const imageName = source ? String(source.inputs.image || '') : '';
  const params = {
    mode: 't2i',
    prompt: positive.inputs.text,
    authoredPrompt: positive.inputs.text,
    negativePrompt: '',
    width: Number(scale?.inputs?.width) || 1024,
    height: Number(scale?.inputs?.height) || 1024,
    seed: Number(sampler.inputs.seed) || 0,
    steps: Number(sampler.inputs.steps) || 8,
    cfg: Number(sampler.inputs.cfg) || 1,
    denoise: Number(sampler.inputs.denoise) || 1,
    batch: 1,
    krea2Turbo: true,
    imageName: imageName || undefined,
    imageGuideMode: imageName ? 'image' : undefined,
    loras: [],
    folder: null,
  };
  return {
    kind: 'gen',
    profileId: profile.id,
    params,
    graph,
    refImageNames: imageName ? [imageName] : [],
    refinedPrompt: null,
    enqueuedAt: Number(promptMeta?.create_time) || Date.now(),
    startedAt: Number(history?.status?.messages?.[0]?.[1]?.timestamp) || null,
  };
}

module.exports = { createJobJournal, loadJournal, recoverableGenerationJob, serializableJob };
