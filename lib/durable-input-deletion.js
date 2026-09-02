'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile } = require('./gallery-finalization-adapter');
const { durableInputIdentity } = require('./durable-input-staging');

const DELETION_RECEIPT_VERSION = 1;
const ASSET_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ENTRY_KINDS = new Set(['alias', 'blob', 'manifest']);

function deletionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.state = details.state || 'attention';
  error.retryable = details.retryable === true;
  Object.assign(error, details);
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalAssetId(value) {
  const id = cleanString(value).toLowerCase();
  if (!ASSET_ID.test(id)) {
    throw deletionError('durable_input_deletion_asset_id_invalid', 'A valid durable input asset ID is required.');
  }
  return id;
}

function canonicalProfileId(value) {
  const id = cleanString(value);
  if (!id || id !== value || id.includes('\0')) {
    throw deletionError('durable_input_deletion_profile_invalid', 'A valid profile owner is required.');
  }
  return id;
}

function safeRelativePath(value, label = 'path') {
  const name = typeof value === 'string' ? value : '';
  if (!name || name !== name.trim() || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) {
    throw deletionError('durable_input_deletion_path_invalid', `The ${label} must be a safe relative path.`);
  }
  if (name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw deletionError('durable_input_deletion_path_invalid', `The ${label} cannot contain empty or traversal segments.`);
  }
  return name;
}

function canonicalRequest(request) {
  const profileId = canonicalProfileId(request?.profileId);
  const name = safeRelativePath(request?.name, 'durable input name');
  const assetId = canonicalAssetId(request?.assetId);
  if (durableInputIdentity(profileId, name) !== assetId) {
    throw deletionError(
      'durable_input_deletion_identity_mismatch',
      'The durable input asset ID does not belong to this profile and name.',
    );
  }
  const aliases = [...new Set((Array.isArray(request?.aliases) ? request.aliases : []).map((alias) => (
    safeRelativePath(alias, 'alias path')
  )))].sort();
  return { profileId, name, assetId, aliases };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function aliasTrashName(alias) {
  const token = crypto.createHash('sha256').update(alias).digest('hex').slice(0, 16);
  return `${token}-${path.posix.basename(alias)}`;
}

function plannedEntries(request) {
  const prefix = `durable-inputs/${request.assetId}`;
  return [
    ...request.aliases.map((alias) => ({
      kind: 'alias',
      sourceRelativePath: alias,
      trashRelativePath: `${prefix}/aliases/${aliasTrashName(alias)}`,
    })),
    {
      kind: 'blob',
      sourceRelativePath: `${request.assetId}.bin`,
      trashRelativePath: `${prefix}/blob/${request.assetId}.bin`,
    },
    {
      kind: 'manifest',
      sourceRelativePath: `${request.assetId}.json`,
      trashRelativePath: `${prefix}/manifest/${request.assetId}.json`,
    },
  ];
}

function validateReceipt(receipt) {
  if (!receipt || receipt.version !== DELETION_RECEIPT_VERSION) {
    throw deletionError('durable_input_deletion_receipt_version_invalid', 'Unsupported deletion receipt version.');
  }
  const request = canonicalRequest(receipt);
  if (!['prepared', 'files_moved', 'complete'].includes(receipt.phase)
    || !['pending', 'committed'].includes(receipt.catalogState)
    || !Number.isFinite(Number(receipt.createdAt))
    || !Array.isArray(receipt.entries)) {
    throw deletionError('durable_input_deletion_receipt_invalid', 'The deletion receipt has invalid state.');
  }
  const expected = plannedEntries(request);
  if (receipt.entries.length !== expected.length) {
    throw deletionError('durable_input_deletion_receipt_invalid', 'The deletion receipt has an invalid file plan.');
  }
  receipt.entries.forEach((entry, index) => {
    const plan = expected[index];
    if (!entry || !ENTRY_KINDS.has(entry.kind) || entry.kind !== plan.kind
      || safeRelativePath(entry.sourceRelativePath) !== plan.sourceRelativePath
      || safeRelativePath(entry.trashRelativePath) !== plan.trashRelativePath
      || !['pending', 'moved'].includes(entry.state)
      || !DIGEST.test(String(entry.sha256 || ''))
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw deletionError('durable_input_deletion_receipt_invalid', 'The deletion receipt has an invalid file entry.');
    }
  });
  const allMoved = receipt.entries.every((entry) => entry.state === 'moved');
  if ((receipt.phase === 'files_moved' || receipt.phase === 'complete') && !allMoved) {
    throw deletionError('durable_input_deletion_receipt_invalid', 'A deletion checkpoint claims files that are not moved.');
  }
  if ((receipt.catalogState === 'committed') !== (receipt.phase === 'complete')) {
    throw deletionError('durable_input_deletion_receipt_invalid', 'Committed catalog state must be complete.');
  }
  return receipt;
}

function assertDescendant(root, candidate) {
  const relation = path.relative(root, candidate);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw deletionError('durable_input_deletion_path_invalid', 'A deletion path escaped its configured root.');
  }
}

async function hashRegularFile(fsImpl, createReadStream, root, file) {
  let stat;
  try {
    stat = await fsImpl.lstat(file);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw deletionError('durable_input_deletion_source_invalid', 'A deletion source is not a regular file.');
  }
  const [realRoot, realFile] = await Promise.all([fsImpl.realpath(root), fsImpl.realpath(file)]);
  assertDescendant(realRoot, realFile);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
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

function sameContent(observed, entry) {
  return observed && observed.bytes === entry.bytes && observed.sha256 === entry.sha256;
}

function resolveBelow(root, relative) {
  const safe = safeRelativePath(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...safe.split('/'));
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw deletionError('durable_input_deletion_path_invalid', 'A deletion path escaped its configured root.');
  }
  return resolved;
}

function createFileDurableInputDeletionReceiptStore(directory, options = {}) {
  const root = cleanString(directory);
  if (!root) throw deletionError('durable_input_deletion_receipt_directory_required', 'A receipt directory is required.');
  const fsImpl = options.fs || fs.promises;
  const filename = (assetId) => path.join(root, `${canonicalAssetId(assetId)}.json`);
  const store = {
    async load(assetId) {
      try {
        return validateReceipt(JSON.parse(await fsImpl.readFile(filename(assetId), 'utf8')));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) {
          throw deletionError('durable_input_deletion_receipt_corrupt', 'The deletion receipt is not valid JSON.');
        }
        throw error;
      }
    },
    async save(receipt) {
      validateReceipt(receipt);
      await atomicWriteFile(filename(receipt.assetId), `${JSON.stringify(receipt, null, 2)}\n`, { fs: fsImpl });
    },
    async list() {
      let names;
      try {
        names = await fsImpl.readdir(root);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const receipts = [];
      for (const name of names.sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const receipt = await store.load(name.slice(0, -5));
        if (receipt) receipts.push(receipt);
      }
      return receipts;
    },
  };
  return store;
}

function createDurableInputDeletionJournal(options = {}) {
  const aliasDirectory = cleanString(options.aliasDirectory);
  const assetDirectory = cleanString(options.assetDirectory);
  const manifestDirectory = cleanString(options.manifestDirectory);
  const trashDirectory = cleanString(options.trashDirectory);
  const receiptStore = options.receiptStore;
  const fsImpl = options.fs || fs.promises;
  const createReadStream = options.createReadStream || fs.createReadStream;
  const defaultCatalogCheckpoint = options.checkpointCatalog;
  const fault = typeof options.fault === 'function' ? options.fault : async () => {};
  if (!aliasDirectory || !assetDirectory || !manifestDirectory || !trashDirectory) {
    throw deletionError('durable_input_deletion_directories_required', 'Alias, asset, manifest, and trash directories are required.');
  }
  if (!receiptStore || typeof receiptStore.load !== 'function' || typeof receiptStore.save !== 'function') {
    throw deletionError('durable_input_deletion_receipt_store_required', 'A deletion receipt store with load/save is required.');
  }
  if (defaultCatalogCheckpoint != null && typeof defaultCatalogCheckpoint !== 'function') {
    throw deletionError('durable_input_deletion_catalog_checkpoint_invalid', 'The catalog checkpoint must be a function.');
  }
  const roots = { alias: aliasDirectory, blob: assetDirectory, manifest: manifestDirectory };
  const tails = new Map();

  function compatible(receipt, request) {
    return receipt.profileId === request.profileId && receipt.name === request.name
      && receipt.assetId === request.assetId
      && JSON.stringify(receipt.aliases) === JSON.stringify(request.aliases);
  }

  async function initialReceipt(request) {
    const entries = [];
    for (const plan of plannedEntries(request)) {
      const source = resolveBelow(roots[plan.kind], plan.sourceRelativePath);
      const observed = await hashRegularFile(fsImpl, createReadStream, roots[plan.kind], source);
      if (!observed) {
        throw deletionError('durable_input_deletion_source_missing', `The ${plan.kind} deletion source is missing.`);
      }
      entries.push({ ...plan, ...observed, state: 'pending' });
    }
    return {
      version: DELETION_RECEIPT_VERSION,
      assetId: request.assetId,
      profileId: request.profileId,
      name: request.name,
      aliases: request.aliases,
      entries,
      phase: 'prepared',
      catalogState: 'pending',
      createdAt: Date.now(),
    };
  }

  async function moveEntry(receipt, entry, index) {
    const source = resolveBelow(roots[entry.kind], entry.sourceRelativePath);
    const destination = resolveBelow(trashDirectory, entry.trashRelativePath);
    await fsImpl.mkdir(path.dirname(destination), { recursive: true });
    const [realTrashRoot, realTrashParent] = await Promise.all([
      fsImpl.realpath(trashDirectory),
      fsImpl.realpath(path.dirname(destination)),
    ]);
    assertDescendant(realTrashRoot, realTrashParent);
    const [sourceContent, trashContent] = await Promise.all([
      hashRegularFile(fsImpl, createReadStream, roots[entry.kind], source),
      hashRegularFile(fsImpl, createReadStream, trashDirectory, destination),
    ]);
    if (trashContent) {
      if (!sameContent(trashContent, entry) || sourceContent) {
        throw deletionError('durable_input_deletion_destination_conflict', 'The deterministic trash destination conflicts with the deletion receipt.');
      }
      if (entry.state !== 'moved') {
        entry.state = 'moved';
        await receiptStore.save(receipt);
      }
      return;
    }
    if (!sameContent(sourceContent, entry)) {
      throw deletionError(
        sourceContent ? 'durable_input_deletion_source_changed' : 'durable_input_deletion_source_missing',
        'The deletion source no longer matches its prepared receipt.',
      );
    }
    try {
      await fsImpl.rename(source, destination);
    } catch (cause) {
      if (cause?.code === 'EXDEV') {
        throw deletionError(
          'durable_input_deletion_cross_device_unsupported',
          'Recoverable deletion requires the trash directory to be on the same filesystem.',
          { cause },
        );
      }
      throw cause;
    }
    await Promise.all([
      syncDirectory(fsImpl, path.dirname(source)),
      syncDirectory(fsImpl, path.dirname(destination)),
    ]);
    await fault(`after_${entry.kind}_${index}_move`, { receipt: clone(receipt), entry: clone(entry) });
    entry.state = 'moved';
    await receiptStore.save(receipt);
    await fault(`after_${entry.kind}_${index}_checkpoint`, { receipt: clone(receipt), entry: clone(entry) });
  }

  async function moveNow(rawRequest) {
    const request = canonicalRequest(rawRequest);
    let receipt = await receiptStore.load(request.assetId);
    if (receipt) {
      validateReceipt(receipt);
      if (!compatible(receipt, request)) {
        throw deletionError('durable_input_deletion_receipt_conflict', 'The saved deletion receipt describes another request.');
      }
    } else {
      receipt = await initialReceipt(request);
      await receiptStore.save(receipt);
      await fault('after_receipt_prepared', { receipt: clone(receipt) });
    }
    if (receipt.catalogState === 'committed') return { status: 'complete', receipt: clone(receipt) };
    for (let index = 0; index < receipt.entries.length; index += 1) {
      await moveEntry(receipt, receipt.entries[index], index);
    }
    if (receipt.phase !== 'files_moved') {
      receipt.phase = 'files_moved';
      await receiptStore.save(receipt);
      await fault('after_files_checkpoint', { receipt: clone(receipt) });
    }
    return { status: 'ready_for_catalog_checkpoint', receipt: clone(receipt) };
  }

  function serialized(assetId, operation) {
    const prior = tails.get(assetId) || Promise.resolve();
    const run = prior.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    tails.set(assetId, settled);
    settled.then(() => {
      if (tails.get(assetId) === settled) tails.delete(assetId);
    });
    return run;
  }

  function keyed(request, operation) {
    let assetId;
    try { assetId = canonicalAssetId(request?.assetId); } catch (error) { return Promise.reject(error); }
    return serialized(assetId, operation);
  }

  async function checkpointNow(request, checkpointCatalog) {
    const moved = await moveNow(request);
    if (moved.status === 'complete') return moved;
    if (typeof checkpointCatalog !== 'function') return moved;
    const receipt = moved.receipt;
    if (receipt.phase !== 'files_moved' || receipt.entries.some((entry) => entry.state !== 'moved')) {
      throw deletionError('durable_input_deletion_files_not_moved', 'The catalog cannot be changed before every file is recoverably moved.');
    }
    await checkpointCatalog(clone(receipt));
    await fault('after_catalog_commit', { receipt: clone(receipt) });
    receipt.catalogState = 'committed';
    receipt.phase = 'complete';
    await receiptStore.save(receipt);
    await fault('after_catalog_checkpoint', { receipt: clone(receipt) });
    return { status: 'complete', receipt: clone(receipt) };
  }

  return {
    moveToTrash(request) {
      return keyed(request, () => moveNow(request));
    },
    checkpointCatalog(request, checkpoint = defaultCatalogCheckpoint) {
      return keyed(request, () => checkpointNow(request, checkpoint));
    },
    deleteAsset(request) {
      return keyed(request, () => checkpointNow(request, defaultCatalogCheckpoint));
    },
  };
}

module.exports = {
  DELETION_RECEIPT_VERSION,
  createDurableInputDeletionJournal,
  createFileDurableInputDeletionReceiptStore,
  deletionError,
  validateReceipt,
};
