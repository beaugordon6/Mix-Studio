'use strict';

const crypto = require('node:crypto');

const GALLERY_FINALIZATION_VERSION = 1;
const FINALIZATION_PHASES = new Set([
  'prepared',
  'assets_written',
  'catalog_upserted',
  'history_upserted',
  'complete',
  'cancelled',
  'attention',
]);
const ASSET_STATES = new Set(['pending', 'written', 'reused']);
const UPSERT_STATES = new Set(['pending', 'upserted']);

function finalizationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOperationId(value) {
  const id = cleanString(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw finalizationError('finalization_operation_id_invalid', 'A canonical operation UUID is required.');
  }
  return id;
}

function normalizeOutputIndex(value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw finalizationError('finalization_output_index_invalid', 'Output indexes must be non-negative integers.');
  }
  return index;
}

function normalizeToken(value, fallback, label) {
  const token = cleanString(value || fallback).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(token)) {
    throw finalizationError('finalization_token_invalid', `${label} contains unsafe characters.`, { label });
  }
  return token;
}

function normalizeExtension(value, kind) {
  let extension = cleanString(value || (kind === 'video' ? '.mp4' : '.png')).toLowerCase();
  if (!extension.startsWith('.')) extension = `.${extension}`;
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw finalizationError('finalization_extension_invalid', 'The output extension is invalid.');
  }
  return extension;
}

function normalizeDigest(value) {
  const digest = cleanString(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw finalizationError('finalization_hash_invalid', 'Every output needs a verified SHA-256 digest.');
  }
  return digest;
}

function normalizeByteLength(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw finalizationError('finalization_bytes_invalid', 'Every output needs a non-negative byte length.');
  }
  return bytes;
}

function stableToken(namespace, operationId, outputIndex, role, length = 16) {
  return crypto.createHash('sha256')
    .update(`mix-gallery-v${GALLERY_FINALIZATION_VERSION}\0${namespace}\0${operationId}\0${outputIndex}\0${role}`)
    .digest('hex')
    .slice(0, length);
}

function deterministicGalleryIdentity(operationId, outputIndex, options = {}) {
  operationId = normalizeOperationId(operationId);
  outputIndex = normalizeOutputIndex(outputIndex);
  const kind = normalizeToken(options.kind, 'image', 'kind');
  const role = normalizeToken(options.role, 'output', 'role');
  const extension = normalizeExtension(options.extension, kind);
  const itemId = stableToken('item', operationId, outputIndex, role);
  const mediaId = stableToken('media', operationId, outputIndex, role);
  const historyId = stableToken('history', operationId, outputIndex, role);
  const assetId = stableToken('asset', operationId, outputIndex, role, 24);
  return Object.freeze({
    operationId,
    outputIndex,
    kind,
    role,
    itemId,
    mediaId,
    historyId,
    assetId,
    filename: `${assetId}${extension}`,
  });
}

function hashAsset(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw finalizationError('finalization_asset_invalid', 'Asset content must be a Buffer or Uint8Array.');
  }
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createGalleryFinalizationManifest(source) {
  const operationId = normalizeOperationId(source?.operationId);
  const profileId = cleanString(source?.profileId);
  if (!profileId) throw finalizationError('finalization_profile_required', 'A profileId is required.');
  const workflow = cleanString(source?.workflow);
  if (!workflow) throw finalizationError('finalization_workflow_required', 'A workflow is required.');
  if (!Array.isArray(source?.outputs) || source.outputs.length === 0) {
    throw finalizationError('finalization_outputs_required', 'At least one output is required.');
  }
  const seen = new Set();
  const outputs = source.outputs.map((raw, position) => {
    const outputIndex = normalizeOutputIndex(raw?.outputIndex ?? position);
    if (seen.has(outputIndex)) {
      throw finalizationError('finalization_output_index_duplicate', `Output index ${outputIndex} is duplicated.`);
    }
    seen.add(outputIndex);
    const identity = deterministicGalleryIdentity(operationId, outputIndex, raw);
    return {
      ...identity,
      sha256: normalizeDigest(raw?.sha256),
      bytes: normalizeByteLength(raw?.bytes),
      assetState: 'pending',
      itemState: 'pending',
      historyState: 'pending',
    };
  });
  return {
    version: GALLERY_FINALIZATION_VERSION,
    operationId,
    profileId,
    workflow,
    phase: source.cancelRequested ? 'cancelled' : 'prepared',
    completed: false,
    cancelRequested: !!source.cancelRequested,
    lateCancellation: false,
    conflict: null,
    createdAt: source.createdAt == null ? null : Number(source.createdAt),
    outputs,
  };
}

function validateManifest(source) {
  if (!source || source.version !== GALLERY_FINALIZATION_VERSION) {
    throw finalizationError('finalization_manifest_version_invalid', 'Unsupported gallery finalization manifest version.');
  }
  normalizeOperationId(source.operationId);
  if (!cleanString(source.profileId) || !cleanString(source.workflow)) {
    throw finalizationError('finalization_manifest_invalid', 'The finalization manifest is incomplete.');
  }
  if (!FINALIZATION_PHASES.has(source.phase) || !Array.isArray(source.outputs) || source.outputs.length === 0) {
    throw finalizationError('finalization_manifest_invalid', 'The finalization manifest has an invalid state.');
  }
  const seen = new Set();
  for (const output of source.outputs) {
    const expected = deterministicGalleryIdentity(source.operationId, output.outputIndex, output);
    if (seen.has(expected.outputIndex)) {
      throw finalizationError('finalization_manifest_invalid', 'The finalization manifest has duplicate outputs.');
    }
    seen.add(expected.outputIndex);
    for (const key of ['itemId', 'mediaId', 'historyId', 'assetId', 'filename']) {
      if (output[key] !== expected[key]) {
        throw finalizationError('finalization_manifest_identity_invalid', `Output ${expected.outputIndex} has a modified ${key}.`);
      }
    }
    normalizeDigest(output.sha256);
    normalizeByteLength(output.bytes);
    if (!ASSET_STATES.has(output.assetState) || !UPSERT_STATES.has(output.itemState)
      || !UPSERT_STATES.has(output.historyState)) {
      throw finalizationError('finalization_manifest_invalid', 'The finalization manifest has an invalid output state.');
    }
  }
  return source;
}

function outputAt(manifest, outputIndex) {
  outputIndex = normalizeOutputIndex(outputIndex);
  const position = manifest.outputs.findIndex((output) => output.outputIndex === outputIndex);
  if (position === -1) {
    throw finalizationError('finalization_output_not_found', `Output ${outputIndex} is not in this manifest.`);
  }
  return position;
}

function expectedAsset(output) {
  return {
    assetId: output.assetId,
    filename: output.filename,
    sha256: output.sha256,
    bytes: output.bytes,
  };
}

function compareAssetIdentity(expected, actual) {
  const mismatches = [];
  if (cleanString(actual?.assetId) !== expected.assetId) mismatches.push('assetId');
  if (cleanString(actual?.filename) !== expected.filename) mismatches.push('filename');
  if (cleanString(actual?.sha256).toLowerCase() !== expected.sha256) mismatches.push('sha256');
  if (Number(actual?.bytes) !== expected.bytes) mismatches.push('bytes');
  return { ok: mismatches.length === 0, mismatches };
}

function planAssetWrite(manifest, outputIndex, observation) {
  validateManifest(manifest);
  const output = manifest.outputs[outputAt(manifest, outputIndex)];
  if (manifest.cancelRequested) return { action: 'suppress', reason: 'cancel_requested' };
  if (manifest.conflict) return { action: 'conflict', reason: 'manifest_attention', conflict: cloneJson(manifest.conflict) };
  if (!observation?.exists) return { action: 'write', asset: expectedAsset(output) };
  const comparison = compareAssetIdentity(expectedAsset(output), observation);
  if (comparison.ok) return { action: 'reuse', asset: expectedAsset(output) };
  return {
    action: 'conflict',
    reason: 'asset_identity_mismatch',
    mismatches: comparison.mismatches,
    expected: expectedAsset(output),
  };
}

function derivePhase(manifest) {
  if (manifest.conflict) return 'attention';
  if (manifest.cancelRequested) return 'cancelled';
  const every = (key, values) => manifest.outputs.every((output) => values.includes(output[key]));
  if (every('historyState', ['upserted'])) return manifest.completed ? 'complete' : 'history_upserted';
  if (every('itemState', ['upserted'])) return 'catalog_upserted';
  if (every('assetState', ['written', 'reused'])) return 'assets_written';
  return 'prepared';
}

function updateOutput(manifest, outputIndex, updater) {
  validateManifest(manifest);
  const next = cloneJson(manifest);
  const position = outputAt(next, outputIndex);
  updater(next.outputs[position], next);
  next.phase = derivePhase(next);
  return next;
}

function markAssetReady(manifest, outputIndex, observation, mode = 'written') {
  if (!['written', 'reused'].includes(mode)) {
    throw finalizationError('finalization_asset_state_invalid', 'Asset completion mode must be written or reused.');
  }
  return updateOutput(manifest, outputIndex, (output, next) => {
    if (next.cancelRequested) return;
    const comparison = compareAssetIdentity(expectedAsset(output), observation);
    if (!comparison.ok) {
      next.conflict = {
        type: 'asset_identity_mismatch',
        outputIndex: output.outputIndex,
        mismatches: comparison.mismatches,
      };
      return;
    }
    if (['written', 'reused'].includes(output.assetState)) return;
    output.assetState = mode;
  });
}

function finalizationMetadata(manifest, outputIndex) {
  validateManifest(manifest);
  const output = manifest.outputs[outputAt(manifest, outputIndex)];
  return {
    version: GALLERY_FINALIZATION_VERSION,
    operationId: manifest.operationId,
    outputIndex: output.outputIndex,
    assetId: output.assetId,
    filename: output.filename,
    sha256: output.sha256,
    bytes: output.bytes,
  };
}

function galleryItemRecord(manifest, outputIndex, fields = {}) {
  validateManifest(manifest);
  const output = manifest.outputs[outputAt(manifest, outputIndex)];
  return Object.assign({}, cloneJson(fields), {
    id: output.itemId,
    file: output.filename,
    profileId: manifest.profileId,
    finalization: finalizationMetadata(manifest, outputIndex),
  });
}

function galleryHistoryRecord(manifest, outputIndex, fields = {}) {
  validateManifest(manifest);
  const output = manifest.outputs[outputAt(manifest, outputIndex)];
  return Object.assign({}, cloneJson(fields), {
    id: output.historyId,
    itemId: output.itemId,
    profileId: manifest.profileId,
    finalization: finalizationMetadata(manifest, outputIndex),
  });
}

function sameRecordIdentity(expected, actual, type) {
  if (!actual || typeof actual !== 'object') return false;
  const idKey = type === 'history' ? 'historyId' : 'itemId';
  const expectedId = expected[idKey];
  const metadata = actual.finalization;
  return actual.id === expectedId
    && actual.profileId === expected.profileId
    && (type === 'history' ? actual.itemId === expected.itemId : actual.file === expected.filename)
    && metadata?.version === GALLERY_FINALIZATION_VERSION
    && metadata.operationId === expected.operationId
    && metadata.outputIndex === expected.outputIndex
    && metadata.assetId === expected.assetId
    && metadata.filename === expected.filename
    && metadata.sha256 === expected.sha256
    && metadata.bytes === expected.bytes;
}

function planRecordUpsert(manifest, outputIndex, records, candidate, type) {
  validateManifest(manifest);
  const output = manifest.outputs[outputAt(manifest, outputIndex)];
  if (manifest.cancelRequested) return { action: 'suppress', reason: 'cancel_requested' };
  if (manifest.conflict) return { action: 'conflict', reason: 'manifest_attention' };
  if (!['written', 'reused'].includes(output.assetState)) {
    return { action: 'blocked', reason: 'asset_not_ready' };
  }
  const expected = {
    operationId: manifest.operationId,
    outputIndex: output.outputIndex,
    profileId: manifest.profileId,
    assetId: output.assetId,
    filename: output.filename,
    sha256: output.sha256,
    bytes: output.bytes,
    itemId: output.itemId,
    historyId: output.historyId,
  };
  const recordId = type === 'history' ? output.historyId : output.itemId;
  if (!sameRecordIdentity(expected, candidate, type)) {
    return { action: 'conflict', reason: `${type}_candidate_identity_mismatch`, recordId };
  }
  const sameLogical = (Array.isArray(records) ? records : []).filter((record) => (
    record?.id === recordId
      || (record?.finalization?.operationId === manifest.operationId
        && record?.finalization?.outputIndex === output.outputIndex)
  ));
  if (sameLogical.length === 0) return { action: 'insert', record: cloneJson(candidate) };
  if (sameLogical.length === 1 && sameRecordIdentity(expected, sameLogical[0], type)) {
    return { action: 'reuse', record: cloneJson(sameLogical[0]) };
  }
  return { action: 'conflict', reason: `${type}_identity_mismatch`, recordId };
}

function planItemUpsert(manifest, outputIndex, items, candidate) {
  return planRecordUpsert(manifest, outputIndex, items, candidate, 'item');
}

function planHistoryUpsert(manifest, outputIndex, history, candidate) {
  const output = manifest.outputs[outputAt(validateManifest(manifest), outputIndex)];
  if (manifest.cancelRequested) return { action: 'suppress', reason: 'cancel_requested' };
  if (output.itemState !== 'upserted') return { action: 'blocked', reason: 'item_not_upserted' };
  return planRecordUpsert(manifest, outputIndex, history, candidate, 'history');
}

function markItemUpserted(manifest, outputIndex) {
  return updateOutput(manifest, outputIndex, (output, next) => {
    if (next.cancelRequested || next.conflict) return;
    if (!['written', 'reused'].includes(output.assetState)) {
      throw finalizationError('finalization_phase_invalid', 'The asset must be ready before its gallery item is committed.');
    }
    output.itemState = 'upserted';
  });
}

function markHistoryUpserted(manifest, outputIndex) {
  return updateOutput(manifest, outputIndex, (output, next) => {
    if (next.cancelRequested || next.conflict) return;
    if (output.itemState !== 'upserted') {
      throw finalizationError('finalization_phase_invalid', 'The gallery item must be committed before history.');
    }
    output.historyState = 'upserted';
  });
}

function requestFinalizationCancellation(manifest) {
  validateManifest(manifest);
  if (manifest.cancelRequested) return cloneJson(manifest);
  const next = cloneJson(manifest);
  next.cancelRequested = true;
  next.lateCancellation = next.outputs.some((output) => output.itemState === 'upserted');
  next.phase = derivePhase(next);
  return next;
}

function markFinalizationComplete(manifest) {
  validateManifest(manifest);
  if (manifest.cancelRequested || manifest.conflict) return cloneJson(manifest);
  if (!manifest.outputs.every((output) => output.historyState === 'upserted')) {
    throw finalizationError('finalization_phase_invalid', 'Every history record must be committed before finalization completes.');
  }
  const next = cloneJson(manifest);
  next.completed = true;
  next.phase = derivePhase(next);
  return next;
}

module.exports = {
  GALLERY_FINALIZATION_VERSION,
  compareAssetIdentity,
  createGalleryFinalizationManifest,
  deterministicGalleryIdentity,
  finalizationMetadata,
  galleryHistoryRecord,
  galleryItemRecord,
  hashAsset,
  markAssetReady,
  markFinalizationComplete,
  markHistoryUpserted,
  markItemUpserted,
  planAssetWrite,
  planHistoryUpsert,
  planItemUpsert,
  requestFinalizationCancellation,
  validateManifest,
};
