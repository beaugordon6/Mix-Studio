'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOURNAL_VERSION = 1;
const DURABLE_KINDS = new Set(['gen', 'loraHunt', 'upscale']);

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
    inputAssets: Array.isArray(job.inputAssets) ? job.inputAssets : [],
    workflowContractId: String(job.workflowContractId || ''),
    recoveryError: job.recoveryError || undefined,
    refinedPrompt: job.refinedPrompt || null,
    huntPlan: job.huntPlan || undefined,
    smartRunId: job.smartRunId || undefined,
    smartStepId: job.smartStepId || undefined,
    parentOperationId: job.parentOperationId || undefined,
    parentReceiptId: job.parentReceiptId || undefined,
    childReceipts: Array.isArray(job.childReceipts) ? job.childReceipts : undefined,
    itemId: job.itemId || undefined,
    sourceAsset: job.sourceAsset || undefined,
    upscaleInfo: job.upscaleInfo || undefined,
    attachmentFinalization: job.attachmentFinalization || undefined,
    attachmentDescriptor: job.attachmentDescriptor || undefined,
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
    finalization: job.finalization || undefined,
    finalizationOutputs: Array.isArray(job.finalizationOutputs) ? job.finalizationOutputs : undefined,
    finalizationRetryAt: Number(job.finalizationRetryAt) || null,
    enqueuedAt: Number(job.enqueuedAt) || Date.now(),
    startedAt: Number(job.startedAt) || null,
  };
}

function loadJournal(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) {
      const error = new Error('The durable generation journal has an invalid schema.');
      error.code = 'job_journal_corrupt';
      throw error;
    }
    if (parsed.version !== JOURNAL_VERSION) {
      const error = new Error(`Unsupported durable generation journal version: ${String(parsed.version)}.`);
      error.code = 'job_journal_version_invalid';
      throw error;
    }
    const ids = new Set();
    return parsed.jobs.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)) {
        const error = new Error(`The durable generation journal has an invalid job at index ${index}.`);
        error.code = 'job_journal_corrupt';
        throw error;
      }
      ids.add(entry.id);
      const job = serializableJob(entry.job);
      if (!job) {
        const error = new Error(`The durable generation journal has an invalid job payload at index ${index}.`);
        error.code = 'job_journal_corrupt';
        throw error;
      }
      if (!job.operationId) job.operationId = entry.id;
      if (!job.promptId) job.promptId = entry.id;
      return [entry.id, job];
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (['job_journal_corrupt', 'job_journal_version_invalid'].includes(error?.code)) throw error;
    const wrapped = new Error(`The durable generation journal could not be read: ${error.message}`);
    wrapped.code = error instanceof SyntaxError ? 'job_journal_corrupt' : 'job_journal_read_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

function createJobJournal(file) {
  const records = new Map(loadJournal(file));

  function flush() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({
        version: JOURNAL_VERSION,
        jobs: [...records].map(([id, job]) => ({ id, job })),
      }, null, 2), { mode: 0o600 });
      const descriptor = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
      try {
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch { /* Windows and some filesystems do not permit directory fsync. */ }
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      const wrapped = new Error(`The durable generation journal could not be saved: ${error.message}`);
      wrapped.code = 'job_journal_write_failed';
      wrapped.cause = error;
      throw wrapped;
    }
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
