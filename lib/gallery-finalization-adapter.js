'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
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
} = require('./gallery-finalization');

function adapterError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalOperationId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw adapterError('gallery_finalization_operation_id_invalid', 'A canonical operation UUID is required.');
  }
  return id;
}

async function syncDirectory(fsImpl, directory) {
  let handle;
  try {
    handle = await fsImpl.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not allow directory handles to fsync.
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteFile(file, content, options = {}) {
  const fsImpl = options.fs || fs.promises;
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fsImpl.open(temporary, 'wx', options.mode == null ? 0o600 : options.mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    await syncDirectory(fsImpl, directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsImpl.unlink(temporary).catch(() => {});
    throw error;
  }
}

function createFileManifestStore(directory, options = {}) {
  if (!String(directory || '').trim()) {
    throw adapterError('gallery_finalization_manifest_directory_required', 'A manifest directory is required.');
  }
  const fsImpl = options.fs || fs.promises;
  const filename = (operationId) => path.join(directory, `${canonicalOperationId(operationId)}.json`);
  return {
    async load(operationId) {
      try {
        return JSON.parse(await fsImpl.readFile(filename(operationId), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) {
          throw adapterError('gallery_finalization_manifest_corrupt', 'The finalization checkpoint is not valid JSON.', {
            operationId: canonicalOperationId(operationId), cause: error,
          });
        }
        throw error;
      }
    },
    async save(manifest) {
      validateManifest(manifest);
      await atomicWriteFile(filename(manifest.operationId), `${JSON.stringify(manifest, null, 2)}\n`, { fs: fsImpl });
    },
    pathFor(operationId) {
      return filename(operationId);
    },
  };
}

function createAtomicJsonDatabaseStore(file, options = {}) {
  if (!String(file || '').trim()) {
    throw adapterError('gallery_finalization_database_path_required', 'A database file is required.');
  }
  const fsImpl = options.fs || fs.promises;
  const initialValue = cloneJson(options.initialValue || { items: [], history: [] });
  let tail = Promise.resolve();

  async function load() {
    try {
      return JSON.parse(await fsImpl.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return cloneJson(initialValue);
      if (error instanceof SyntaxError) {
        throw adapterError('gallery_finalization_database_corrupt', 'The gallery database is not valid JSON.', { cause: error });
      }
      throw error;
    }
  }

  return {
    load,
    transaction(mutator) {
      const run = tail.then(async () => {
        const database = await load();
        const result = await mutator(database);
        await atomicWriteFile(file, `${JSON.stringify(database, null, 2)}\n`, { fs: fsImpl });
        return result;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function assertCompatibleManifest(expected, actual) {
  validateManifest(expected);
  validateManifest(actual);
  const expectedOutputs = expected.outputs.map((output) => ({
    outputIndex: output.outputIndex,
    kind: output.kind,
    role: output.role,
    filename: output.filename,
    sha256: output.sha256,
    bytes: output.bytes,
  }));
  const actualOutputs = actual.outputs.map((output) => ({
    outputIndex: output.outputIndex,
    kind: output.kind,
    role: output.role,
    filename: output.filename,
    sha256: output.sha256,
    bytes: output.bytes,
  }));
  if (expected.operationId !== actual.operationId
    || expected.profileId !== actual.profileId
    || expected.workflow !== actual.workflow
    || JSON.stringify(expectedOutputs) !== JSON.stringify(actualOutputs)) {
    throw adapterError('gallery_finalization_manifest_conflict', 'The saved finalization checkpoint describes different output.', {
      operationId: expected.operationId,
    });
  }
}

async function observeAsset(fsImpl, mediaDirectory, output) {
  const file = path.join(mediaDirectory, output.filename);
  try {
    const content = await fsImpl.readFile(file);
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

async function publishAsset(fsImpl, mediaDirectory, output, content) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw adapterError('gallery_finalization_asset_content_required', `Output ${output.outputIndex} needs asset content.`, {
      outputIndex: output.outputIndex,
    });
  }
  if (content.length !== output.bytes || hashAsset(content) !== output.sha256) {
    throw adapterError('gallery_finalization_asset_content_mismatch', `Output ${output.outputIndex} does not match its manifest.`, {
      outputIndex: output.outputIndex,
    });
  }
  await fsImpl.mkdir(mediaDirectory, { recursive: true });
  const destination = path.join(mediaDirectory, output.filename);
  const temporary = path.join(
    mediaDirectory,
    `.${output.filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fsImpl.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    // A hard link publishes without overwriting an existing deterministic asset.
    // If another recovery won the race, its bytes are verified by the caller.
    await fsImpl.link(temporary, destination);
    await syncDirectory(fsImpl, mediaDirectory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fsImpl.unlink(temporary).catch(() => {});
  }
  return observeAsset(fsImpl, mediaDirectory, output);
}

function attentionManifest(manifest, outputIndex, plan) {
  const next = cloneJson(manifest);
  next.conflict = {
    type: plan.reason || 'gallery_finalization_conflict',
    outputIndex,
    mismatches: plan.mismatches || undefined,
    recordId: plan.recordId || undefined,
  };
  next.phase = 'attention';
  return next;
}

function createGalleryFinalizationAdapter(options = {}) {
  const mediaDirectory = String(options.mediaDirectory || '').trim();
  if (!mediaDirectory) {
    throw adapterError('gallery_finalization_media_directory_required', 'A media directory is required.');
  }
  const manifestStore = options.manifestStore;
  const databaseStore = options.databaseStore;
  if (!manifestStore || typeof manifestStore.load !== 'function' || typeof manifestStore.save !== 'function') {
    throw adapterError('gallery_finalization_manifest_store_required', 'A manifest store with load/save is required.');
  }
  if (!databaseStore || typeof databaseStore.transaction !== 'function') {
    throw adapterError('gallery_finalization_database_store_required', 'A database store with transaction is required.');
  }
  const fsImpl = options.fs || fs.promises;
  const historyLimit = options.historyLimit == null ? 50 : Number(options.historyLimit);
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw adapterError('gallery_finalization_history_limit_invalid', 'historyLimit must be a positive integer.');
  }
  const fault = typeof options.fault === 'function' ? options.fault : async () => {};
  let tail = Promise.resolve();

  async function execute(request) {
    const requested = validateManifest(cloneJson(request?.manifest));
    const descriptors = new Map((request?.outputs || []).map((entry) => [Number(entry?.outputIndex), entry]));
    let manifest = await manifestStore.load(requested.operationId);
    if (manifest) {
      assertCompatibleManifest(requested, manifest);
      if (requested.cancelRequested && !manifest.cancelRequested && !manifest.completed) {
        manifest = requestFinalizationCancellation(manifest);
        await manifestStore.save(manifest);
      }
    } else {
      manifest = requested;
      await manifestStore.save(manifest);
      await fault('after_manifest_prepared', { manifest: cloneJson(manifest) });
    }
    if (manifest.completed) return { status: 'complete', manifest };
    if (manifest.cancelRequested) return { status: 'cancelled', manifest };
    if (manifest.conflict) return { status: 'attention', manifest, conflict: cloneJson(manifest.conflict) };

    for (const output of manifest.outputs) {
      const descriptor = descriptors.get(output.outputIndex) || {};
      let observation = await observeAsset(fsImpl, mediaDirectory, output);
      let plan = planAssetWrite(manifest, output.outputIndex, observation);
      if (plan.action === 'conflict') {
        manifest = attentionManifest(manifest, output.outputIndex, plan);
        await manifestStore.save(manifest);
        return { status: 'attention', manifest, conflict: cloneJson(manifest.conflict) };
      }
      if (plan.action === 'write') {
        observation = await publishAsset(fsImpl, mediaDirectory, output, descriptor.content);
        await fault('after_asset_commit', { outputIndex: output.outputIndex, manifest: cloneJson(manifest) });
        plan = planAssetWrite(manifest, output.outputIndex, observation);
        if (plan.action !== 'reuse') {
          manifest = attentionManifest(manifest, output.outputIndex, plan);
          await manifestStore.save(manifest);
          return { status: 'attention', manifest, conflict: cloneJson(manifest.conflict) };
        }
        manifest = markAssetReady(manifest, output.outputIndex, observation, 'written');
      } else {
        manifest = markAssetReady(manifest, output.outputIndex, observation, 'reused');
      }
      await manifestStore.save(manifest);
      await fault('after_asset_checkpoint', { outputIndex: output.outputIndex, manifest: cloneJson(manifest) });

      let recordPlans;
      try {
        recordPlans = await databaseStore.transaction((database) => {
          if (!database || typeof database !== 'object') {
            throw adapterError('gallery_finalization_database_invalid', 'The gallery database must be an object.');
          }
          if (!Array.isArray(database.items)) database.items = [];
          if (!Array.isArray(database.history)) database.history = [];
          const item = galleryItemRecord(manifest, output.outputIndex, descriptor.item || {});
          const itemPlan = planItemUpsert(manifest, output.outputIndex, database.items, item);
          if (itemPlan.action === 'conflict') return { itemPlan };
          if (itemPlan.action === 'blocked' || itemPlan.action === 'suppress') return { itemPlan };

          const itemReady = markItemUpserted(manifest, output.outputIndex);
          const history = galleryHistoryRecord(itemReady, output.outputIndex, descriptor.history || {});
          const historyPlan = planHistoryUpsert(itemReady, output.outputIndex, database.history, history);
          if (historyPlan.action === 'conflict') return { itemPlan, historyPlan };
          if (historyPlan.action === 'blocked' || historyPlan.action === 'suppress') return { itemPlan, historyPlan };
          // Plan both records before changing the draft so a conflict cannot
          // make only the item visible. The store persists both in one rename.
          if (itemPlan.action === 'insert') database.items.unshift(itemPlan.record);
          if (historyPlan.action === 'insert') database.history.unshift(historyPlan.record);
          if (database.history.length > historyLimit) database.history.length = historyLimit;
          return { itemPlan, historyPlan };
        });
      } catch (error) {
        throw adapterError('gallery_finalization_database_write_failed', `Could not commit output ${output.outputIndex} to the gallery database: ${error.message}`, {
          outputIndex: output.outputIndex, cause: error,
        });
      }
      await fault('after_database_commit', { outputIndex: output.outputIndex, manifest: cloneJson(manifest) });
      const conflictPlan = [recordPlans?.itemPlan, recordPlans?.historyPlan]
        .find((candidate) => candidate?.action === 'conflict');
      if (conflictPlan) {
        manifest = attentionManifest(manifest, output.outputIndex, conflictPlan);
        await manifestStore.save(manifest);
        return { status: 'attention', manifest, conflict: cloneJson(manifest.conflict) };
      }
      const incompletePlan = [recordPlans?.itemPlan, recordPlans?.historyPlan]
        .find((candidate) => !candidate || !['insert', 'reuse'].includes(candidate.action));
      if (incompletePlan) {
        throw adapterError('gallery_finalization_plan_blocked', `Output ${output.outputIndex} could not be finalized.`, {
          outputIndex: output.outputIndex, plan: incompletePlan,
        });
      }
      manifest = markItemUpserted(manifest, output.outputIndex);
      manifest = markHistoryUpserted(manifest, output.outputIndex);
      await manifestStore.save(manifest);
      await fault('after_database_checkpoint', { outputIndex: output.outputIndex, manifest: cloneJson(manifest) });
    }

    manifest = markFinalizationComplete(manifest);
    await manifestStore.save(manifest);
    return { status: 'complete', manifest };
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
  atomicWriteFile,
  createAtomicJsonDatabaseStore,
  createFileManifestStore,
  createGalleryFinalizationAdapter,
};
