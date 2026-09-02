'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  compareAssetIdentity,
  deterministicGalleryIdentity,
  hashAsset,
} = require('./gallery-finalization');
const { atomicWriteFile } = require('./gallery-finalization-adapter');

const RECEIPT_VERSION = 1;
const RECEIPT_PHASES = new Set([
  'prepared',
  'asset_ready',
  'catalog_committed',
  'complete',
  'cancelled',
  'attention',
]);

function attachmentError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalOperationId(value) {
  const operationId = cleanString(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    throw attachmentError('catalog_attachment_operation_id_invalid', 'A canonical operation UUID is required.');
  }
  return operationId;
}

function safeExtension(value) {
  let extension = cleanString(value || '.png').toLowerCase();
  if (!extension.startsWith('.')) extension = `.${extension}`;
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw attachmentError('catalog_attachment_extension_invalid', 'The attachment extension is invalid.');
  }
  return extension;
}

function digest(value) {
  const sha256 = cleanString(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw attachmentError('catalog_attachment_hash_invalid', 'The attachment needs a verified SHA-256 digest.');
  }
  return sha256;
}

function byteLength(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw attachmentError('catalog_attachment_bytes_invalid', 'The attachment needs a non-negative byte length.');
  }
  return bytes;
}

function normalizedNullableString(value) {
  const result = cleanString(value);
  return result || null;
}

function safeToken(value, fallback, label) {
  const token = cleanString(value || fallback).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(token)) {
    throw attachmentError('catalog_attachment_token_invalid', `${label} contains unsafe characters.`);
  }
  return token;
}

function attachmentIdentity(operationId, extension = '.png', options = {}) {
  const kind = safeToken(options.kind, 'image', 'kind');
  const role = safeToken(options.role, 'upscale', 'role');
  const identity = deterministicGalleryIdentity(operationId, 0, {
    kind,
    role,
    extension: safeExtension(extension),
  });
  return {
    kind,
    role,
    assetId: identity.assetId,
    filename: identity.filename,
    receiptId: identity.mediaId,
    historyId: identity.historyId,
  };
}

function receiptMetadata(receipt) {
  return {
    version: RECEIPT_VERSION,
    operationId: receipt.operationId,
    receiptId: receipt.receiptId,
    strategy: receipt.strategy,
    assetId: receipt.output.assetId,
    filename: receipt.output.filename,
    kind: receipt.output.kind,
    role: receipt.output.role,
    sha256: receipt.output.sha256,
    bytes: receipt.output.bytes,
  };
}

function createCatalogAttachmentReceipt(source) {
  const operationId = canonicalOperationId(source?.operationId);
  const strategy = safeToken(source?.strategy, 'replace_upscale', 'strategy');
  const profileId = cleanString(source?.profileId);
  const itemId = cleanString(source?.target?.itemId);
  const sourceFile = cleanString(source?.target?.sourceVersion?.file);
  if (!profileId || !itemId || !sourceFile) {
    throw attachmentError('catalog_attachment_target_invalid', 'A profile-owned target item and source file version are required.');
  }
  const identity = attachmentIdentity(operationId, source?.output?.extension, {
    kind: source?.output?.kind,
    role: source?.output?.role || (strategy === 'replace_upscale' ? 'upscale' : strategy),
  });
  return {
    version: RECEIPT_VERSION,
    operationId,
    receiptId: identity.receiptId,
    strategy,
    profileId,
    target: {
      itemId,
      sourceVersion: {
        file: sourceFile,
        attachment: normalizedNullableString(source?.target?.sourceVersion?.attachment),
        receiptId: normalizedNullableString(source?.target?.sourceVersion?.receiptId),
        sha256: digest(source?.target?.sourceVersion?.sha256),
        bytes: byteLength(source?.target?.sourceVersion?.bytes),
      },
    },
    output: {
      kind: identity.kind,
      role: identity.role,
      assetId: identity.assetId,
      filename: identity.filename,
      sha256: digest(source?.output?.sha256),
      bytes: byteLength(source?.output?.bytes),
      state: 'pending',
    },
    historyId: identity.historyId,
    history: cloneJson(source?.history || {}),
    attachment: cloneJson(source?.attachment || {}),
    phase: source?.cancelRequested ? 'cancelled' : 'prepared',
    catalogState: 'pending',
    historyState: 'pending',
    completed: false,
    cancelRequested: source?.cancelRequested === true,
    lateCancellation: false,
    conflict: null,
    createdAt: Number.isFinite(Number(source?.createdAt)) ? Number(source.createdAt) : null,
  };
}

function validateCatalogAttachmentReceipt(receipt) {
  if (!receipt || receipt.version !== RECEIPT_VERSION) {
    throw attachmentError('catalog_attachment_receipt_version_invalid', 'Unsupported catalog attachment receipt version.');
  }
  const operationId = canonicalOperationId(receipt.operationId);
  const strategy = safeToken(receipt.strategy, '', 'strategy');
  const expected = attachmentIdentity(operationId, path.extname(receipt.output?.filename || ''), {
    kind: receipt.output?.kind,
    role: receipt.output?.role,
  });
  if (receipt.strategy !== strategy || !cleanString(receipt.profileId)
    || !cleanString(receipt.target?.itemId) || !cleanString(receipt.target?.sourceVersion?.file)
    || receipt.receiptId !== expected.receiptId || receipt.historyId !== expected.historyId
    || receipt.output?.assetId !== expected.assetId || receipt.output?.filename !== expected.filename
    || !['pending', 'written', 'reused'].includes(receipt.output?.state)
    || !['pending', 'committed'].includes(receipt.catalogState)
    || !['pending', 'committed'].includes(receipt.historyState)
    || !RECEIPT_PHASES.has(receipt.phase)) {
    throw attachmentError('catalog_attachment_receipt_invalid', 'The catalog attachment receipt has an invalid identity or state.');
  }
  digest(receipt.output.sha256);
  byteLength(receipt.output.bytes);
  digest(receipt.target.sourceVersion.sha256);
  byteLength(receipt.target.sourceVersion.bytes);
  return receipt;
}

function compatibleReceipt(expected, actual) {
  validateCatalogAttachmentReceipt(expected);
  validateCatalogAttachmentReceipt(actual);
  const immutable = (receipt) => ({
    version: receipt.version,
    operationId: receipt.operationId,
    receiptId: receipt.receiptId,
    strategy: receipt.strategy,
    profileId: receipt.profileId,
    target: receipt.target,
    output: {
      assetId: receipt.output.assetId,
      filename: receipt.output.filename,
      kind: receipt.output.kind,
      role: receipt.output.role,
      sha256: receipt.output.sha256,
      bytes: receipt.output.bytes,
    },
    historyId: receipt.historyId,
    history: receipt.history,
    attachment: receipt.attachment,
    createdAt: receipt.createdAt,
  });
  return JSON.stringify(immutable(expected)) === JSON.stringify(immutable(actual));
}

function attention(receipt, type, details = {}) {
  const next = cloneJson(receipt);
  next.phase = 'attention';
  next.conflict = Object.assign({ type }, cloneJson(details));
  return next;
}

async function observeAsset(fsImpl, mediaDirectory, output) {
  try {
    const content = await fsImpl.readFile(path.join(mediaDirectory, output.filename));
    return {
      exists: true,
      assetId: output.assetId,
      filename: output.filename,
      sha256: hashAsset(content),
      bytes: content.length,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function verifySourceAsset(fsImpl, mediaDirectory, sourceVersion) {
  const filename = cleanString(sourceVersion?.file);
  if (!filename || path.basename(filename) !== filename) {
    throw attachmentError('catalog_attachment_source_path_invalid', 'The source asset path is invalid.');
  }
  try {
    const content = await fsImpl.readFile(path.join(mediaDirectory, filename));
    const actual = { sha256: hashAsset(content), bytes: content.length };
    if (actual.sha256 !== sourceVersion.sha256 || actual.bytes !== sourceVersion.bytes) {
      return { ok: false, type: 'source_asset_identity_mismatch', actual };
    }
    return { ok: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, type: 'source_asset_missing' };
    throw error;
  }
}

async function syncDirectory(fsImpl, directory) {
  let handle;
  try {
    handle = await fsImpl.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishImmutableAsset(fsImpl, mediaDirectory, output, content) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw attachmentError('catalog_attachment_content_required', 'Attachment content is required.');
  }
  if (content.length !== output.bytes || hashAsset(content) !== output.sha256) {
    throw attachmentError('catalog_attachment_content_mismatch', 'Attachment content does not match its receipt.');
  }
  await fsImpl.mkdir(mediaDirectory, { recursive: true });
  const temporary = path.join(
    mediaDirectory,
    `.${output.filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.publish`,
  );
  await atomicWriteFile(temporary, content, { fs: fsImpl });
  try {
    await fsImpl.link(temporary, path.join(mediaDirectory, output.filename));
    await syncDirectory(fsImpl, mediaDirectory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await fsImpl.unlink(temporary).catch(() => {});
  }
  return observeAsset(fsImpl, mediaDirectory, output);
}

function sameReceiptMetadata(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function replaceUpscaleInspection(database, receipt) {
  if (!database || typeof database !== 'object') {
    return { status: 'conflict', type: 'database_invalid' };
  }
  if (!Array.isArray(database.items)) database.items = [];
  if (!Array.isArray(database.history)) database.history = [];
  const target = database.items.find((item) => item?.id === receipt.target.itemId);
  if (!target) return { status: 'conflict', type: 'target_missing' };
  if (target.profileId !== receipt.profileId) return { status: 'conflict', type: 'target_profile_mismatch' };

  const metadata = receiptMetadata(receipt);
  const currentAttachment = normalizedNullableString(target.upscaled);
  const expectedAttachment = normalizedNullableString(receipt.target.sourceVersion.attachment);
  const alreadyApplied = currentAttachment === receipt.output.filename
    && sameReceiptMetadata(target.upscaleReceipt, metadata);
  if (alreadyApplied) {
    const matches = database.history.filter((entry) => entry?.id === receipt.historyId);
    if (matches.length === 0) return { status: 'ready_history', target, metadata };
    if (matches.length !== 1 || matches[0].itemId !== target.id
      || matches[0].profileId !== receipt.profileId
      || !sameReceiptMetadata(matches[0].attachmentReceipt, metadata)) {
      return { status: 'conflict', type: 'history_identity_mismatch' };
    }
    return { status: 'applied', target, history: matches[0] };
  }
  if (target.file !== receipt.target.sourceVersion.file) {
    return { status: 'conflict', type: 'source_file_version_mismatch' };
  }
  if (currentAttachment !== expectedAttachment) {
    return { status: 'conflict', type: 'source_attachment_version_mismatch' };
  }
  const currentReceiptId = normalizedNullableString(target.upscaleReceipt?.receiptId);
  const expectedReceiptId = normalizedNullableString(receipt.target.sourceVersion.receiptId);
  if (currentReceiptId !== expectedReceiptId) {
    return { status: 'conflict', type: 'source_receipt_version_mismatch' };
  }
  if (database.history.some((entry) => entry?.id === receipt.historyId)) {
    return { status: 'conflict', type: 'history_identity_mismatch' };
  }
  return { status: 'ready', target, metadata };
}

function applyReplaceUpscale(database, receipt) {
  const inspected = replaceUpscaleInspection(database, receipt);
  if (!['ready', 'ready_history'].includes(inspected.status)) return inspected;
  const target = inspected.target;
  if (inspected.status === 'ready') {
    target.upscaled = receipt.output.filename;
    target.upscaleInfo = cloneJson(receipt.attachment.upscaleInfo || {});
    if (receipt.attachment.durationMs != null) target.upscaleDurationMs = Number(receipt.attachment.durationMs);
    target.upscaleReceipt = inspected.metadata;
  }
  target.upscalePending = false;
  delete target.upscalePendingOperationId;
  const history = Object.assign({}, cloneJson(receipt.history), {
    id: receipt.historyId,
    itemId: target.id,
    profileId: receipt.profileId,
    attachmentReceipt: inspected.metadata,
  });
  database.history.unshift(history);
  return { status: inspected.status === 'ready' ? 'inserted' : 'history_repaired', target, history };
}

const BUILTIN_STRATEGIES = Object.freeze({
  replace_upscale: Object.freeze({ inspect: replaceUpscaleInspection, apply: applyReplaceUpscale }),
});

function createFileCatalogAttachmentReceiptStore(directory, options = {}) {
  const root = cleanString(directory);
  if (!root) throw attachmentError('catalog_attachment_receipt_directory_required', 'A receipt directory is required.');
  const fsImpl = options.fs || fs.promises;
  const filename = (operationId) => path.join(root, `${canonicalOperationId(operationId)}.json`);
  return {
    async load(operationId) {
      try {
        return JSON.parse(await fsImpl.readFile(filename(operationId), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) {
          throw attachmentError('catalog_attachment_receipt_corrupt', 'The catalog attachment receipt is not valid JSON.');
        }
        throw error;
      }
    },
    async save(receipt) {
      validateCatalogAttachmentReceipt(receipt);
      await atomicWriteFile(filename(receipt.operationId), `${JSON.stringify(receipt, null, 2)}\n`, { fs: fsImpl });
    },
  };
}

function createCatalogAttachmentFinalizer(options = {}) {
  const mediaDirectory = cleanString(options.mediaDirectory);
  const receiptStore = options.receiptStore;
  const databaseStore = options.databaseStore;
  if (!mediaDirectory) throw attachmentError('catalog_attachment_media_directory_required', 'A media directory is required.');
  if (!receiptStore || typeof receiptStore.load !== 'function' || typeof receiptStore.save !== 'function') {
    throw attachmentError('catalog_attachment_receipt_store_required', 'A receipt store with load/save is required.');
  }
  if (!databaseStore || typeof databaseStore.transaction !== 'function') {
    throw attachmentError('catalog_attachment_database_store_required', 'A database store with an atomic transaction is required.');
  }
  const fsImpl = options.fs || fs.promises;
  const fault = typeof options.fault === 'function' ? options.fault : async () => {};
  const historyLimit = options.historyLimit == null ? 50 : Number(options.historyLimit);
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw attachmentError('catalog_attachment_history_limit_invalid', 'historyLimit must be a positive integer.');
  }
  const strategies = Object.assign({}, BUILTIN_STRATEGIES, options.strategies || {});
  let tail = Promise.resolve();

  async function execute(request) {
    const requested = createCatalogAttachmentReceipt(request);
    let receipt = await receiptStore.load(requested.operationId);
    if (receipt) {
      validateCatalogAttachmentReceipt(receipt);
      if (!compatibleReceipt(requested, receipt)) {
        return {
          status: 'attention',
          receipt,
          conflict: { type: 'receipt_identity_mismatch' },
        };
      }
    } else {
      receipt = requested;
      await receiptStore.save(receipt);
      await fault('after_receipt_prepared', { receipt: cloneJson(receipt) });
    }
    const strategy = strategies[receipt.strategy];
    if (!strategy || typeof strategy.inspect !== 'function' || typeof strategy.apply !== 'function') {
      throw attachmentError('catalog_attachment_strategy_unsupported', `Unsupported attachment strategy: ${receipt.strategy}.`);
    }
    if (receipt.completed) return { status: 'complete', receipt };
    if (receipt.conflict) return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };

    if (requested.cancelRequested && !receipt.cancelRequested) {
      const inspection = await databaseStore.transaction((database) => {
        const current = strategy.inspect(database, receipt);
        if (current.status !== 'ready_history') return current;
        const applied = strategy.apply(database, receipt);
        if (Array.isArray(database.history) && database.history.length > historyLimit) {
          database.history.length = historyLimit;
        }
        return applied;
      });
      if (['applied', 'history_repaired'].includes(inspection.status)) {
        receipt.catalogState = 'committed';
        receipt.historyState = 'committed';
        receipt.completed = true;
        receipt.lateCancellation = true;
        receipt.phase = 'complete';
      } else if (inspection.status === 'conflict') {
        receipt = attention(receipt, inspection.type);
      } else {
        receipt.cancelRequested = true;
        receipt.phase = 'cancelled';
      }
      await receiptStore.save(receipt);
    }
    if (receipt.cancelRequested) return { status: 'cancelled', receipt };
    if (receipt.conflict) return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
    if (receipt.completed) return { status: 'complete', receipt };

    const sourceCheck = await verifySourceAsset(fsImpl, mediaDirectory, receipt.target.sourceVersion);
    if (!sourceCheck.ok) {
      receipt = attention(receipt, sourceCheck.type, sourceCheck.actual ? { actual: sourceCheck.actual } : {});
      await receiptStore.save(receipt);
      return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
    }

    const expected = {
      assetId: receipt.output.assetId,
      filename: receipt.output.filename,
      sha256: receipt.output.sha256,
      bytes: receipt.output.bytes,
    };
    let observation = await observeAsset(fsImpl, mediaDirectory, receipt.output);
    let comparison = observation.exists ? compareAssetIdentity(expected, observation) : { ok: false };
    if (observation.exists && !comparison.ok) {
      receipt = attention(receipt, 'asset_identity_mismatch', { mismatches: comparison.mismatches });
      await receiptStore.save(receipt);
      return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
    }
    if (!observation.exists) {
      try {
        observation = await publishImmutableAsset(fsImpl, mediaDirectory, receipt.output, request?.output?.content);
      } catch (error) {
        if (!['catalog_attachment_content_required', 'catalog_attachment_content_mismatch'].includes(error?.code)) throw error;
        receipt = attention(receipt, error.code);
        await receiptStore.save(receipt);
        return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
      }
      comparison = compareAssetIdentity(expected, observation);
      if (!comparison.ok) {
        receipt = attention(receipt, 'asset_identity_mismatch', { mismatches: comparison.mismatches });
        await receiptStore.save(receipt);
        return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
      }
      receipt.output.state = 'written';
      await fault('after_asset_commit', { receipt: cloneJson(receipt) });
    } else {
      receipt.output.state = 'reused';
    }
    receipt.phase = 'asset_ready';
    await receiptStore.save(receipt);
    await fault('after_asset_checkpoint', { receipt: cloneJson(receipt) });

    const finalSourceCheck = await verifySourceAsset(fsImpl, mediaDirectory, receipt.target.sourceVersion);
    if (!finalSourceCheck.ok) {
      receipt = attention(receipt, finalSourceCheck.type, finalSourceCheck.actual ? { actual: finalSourceCheck.actual } : {});
      await receiptStore.save(receipt);
      return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
    }

    const result = await databaseStore.transaction((database) => {
      const inspected = strategy.inspect(database, receipt);
      if (inspected.status === 'applied') return inspected;
      if (inspected.status === 'conflict') return inspected;
      const applied = strategy.apply(database, receipt);
      if (Array.isArray(database.history) && database.history.length > historyLimit) {
        database.history.length = historyLimit;
      }
      return applied;
    });
    await fault('after_database_commit', { receipt: cloneJson(receipt) });
    if (!['inserted', 'history_repaired', 'applied'].includes(result?.status)) {
      receipt = attention(receipt, result?.type || 'catalog_commit_blocked');
      await receiptStore.save(receipt);
      return { status: 'attention', receipt, conflict: cloneJson(receipt.conflict) };
    }
    receipt.catalogState = 'committed';
    receipt.historyState = 'committed';
    receipt.phase = 'catalog_committed';
    await receiptStore.save(receipt);
    await fault('after_database_checkpoint', { receipt: cloneJson(receipt) });
    receipt.completed = true;
    receipt.phase = 'complete';
    await receiptStore.save(receipt);
    return { status: 'complete', receipt, target: cloneJson(result.target), history: cloneJson(result.history) };
  }

  return {
    finalize(request) {
      const run = tail.then(() => execute(request));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

module.exports = {
  RECEIPT_VERSION,
  BUILTIN_STRATEGIES,
  attachmentIdentity,
  createCatalogAttachmentFinalizer,
  createCatalogAttachmentReceipt,
  createFileCatalogAttachmentReceiptStore,
  validateCatalogAttachmentReceipt,
};
