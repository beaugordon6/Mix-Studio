'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile } = require('./gallery-finalization-adapter');

const MANIFEST_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

function stagingError(code, message, details = {}) {
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
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw stagingError('durable_input_asset_id_invalid', 'A valid durable input asset ID is required.');
  }
  return id;
}

function logicalName(value) {
  const name = typeof value === 'string' ? value : '';
  if (!name || name !== name.trim() || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) {
    throw stagingError('durable_input_name_invalid', 'The durable input name must be a safe relative Comfy input name.');
  }
  const segments = name.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) {
    throw stagingError('durable_input_name_invalid', 'The durable input name cannot contain empty or traversal segments.');
  }
  return name;
}

function profileId(value) {
  const id = cleanString(value);
  if (!id) throw stagingError('durable_input_profile_required', 'A profile owner is required.');
  return id;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function hashFile(file, createReadStream, maxBytes = MAX_FILE_BYTES) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw stagingError('durable_input_file_too_large', 'Durable input files cannot exceed 2 GB.');
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error?.code?.startsWith?.('durable_input_')) throw error;
    throw stagingError('durable_input_file_read_failed', 'The durable input file could not be read.', { cause: error });
  }
  return { sha256: hash.digest('hex'), bytes };
}

function durableInputIdentity(owner, name) {
  const normalizedOwner = profileId(owner);
  const normalizedName = logicalName(name);
  return crypto.createHash('sha256')
    .update(`mix-durable-input-v${MANIFEST_VERSION}\0${normalizedOwner}\0${normalizedName}`)
    .digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== MANIFEST_VERSION) {
    throw stagingError('durable_input_manifest_version_invalid', 'Unsupported durable input manifest version.');
  }
  const owner = profileId(manifest.profileId);
  const name = logicalName(manifest.name);
  const id = canonicalAssetId(manifest.assetId);
  if (id !== durableInputIdentity(owner, name) || manifest.storedFilename !== `${id}.bin`) {
    throw stagingError('durable_input_manifest_identity_invalid', 'The durable input manifest identity is invalid.');
  }
  if (!/^[0-9a-f]{64}$/.test(String(manifest.sha256 || ''))) {
    throw stagingError('durable_input_manifest_hash_invalid', 'The durable input manifest needs a SHA-256 digest.');
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0) {
    throw stagingError('durable_input_manifest_bytes_invalid', 'The durable input manifest has an invalid byte length.');
  }
  return manifest;
}

function publicManifest(manifest) {
  const copy = clone(validateManifest(manifest));
  delete copy.storedFilename;
  return copy;
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

async function publishImmutable(fsImpl, directory, filename, content) {
  await fsImpl.mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.publish`);
  await atomicWriteFile(temporary, content, { fs: fsImpl });
  let created = false;
  try {
    await fsImpl.link(temporary, target);
    created = true;
    await syncDirectory(fsImpl, directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await fsImpl.unlink(temporary).catch(() => {});
  }
  return { target, created };
}

async function syncFile(fsImpl, file) {
  const handle = await fsImpl.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishImmutableFile(fsImpl, createReadStream, directory, filename, sourceFile, expected) {
  await fsImpl.mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.publish`);
  let created = false;
  try {
    await fsImpl.copyFile(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
    await syncFile(fsImpl, temporary);
    const copied = await hashFile(temporary, createReadStream);
    if (copied.bytes !== expected.bytes || copied.sha256 !== expected.sha256) {
      throw stagingError(
        'durable_input_source_changed',
        'The source file changed while Mix was preserving it; no manifest was published.',
      );
    }
    try {
      await fsImpl.link(temporary, target);
      created = true;
      await syncDirectory(fsImpl, directory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await fsImpl.unlink(temporary).catch(() => {});
  }
  // The copied temporary was already hashed before its hard link was published, so a
  // newly-created target cannot differ. Only an older target is an external trust
  // boundary that needs another full-file integrity pass.
  if (!created) {
    const published = await hashFile(target, createReadStream);
    if (published.bytes !== expected.bytes || published.sha256 !== expected.sha256) {
      throw stagingError('durable_input_content_conflict', 'Existing durable bytes conflict with this input name.');
    }
  }
  return { target, created };
}

function createOperationLimiter(maxConcurrentOperations) {
  let active = 0;
  const waiting = [];

  async function enter() {
    if (active < maxConcurrentOperations) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }

  function leave() {
    const next = waiting.shift();
    if (next) {
      // Transfer the active slot directly. Decrementing first would let a newly
      // arriving operation steal it before the queued waiter resumes.
      next();
    } else {
      active -= 1;
    }
  }

  return async function limited(operation) {
    await enter();
    try {
      return await operation();
    } finally {
      leave();
    }
  };
}

function createFileDurableInputManifestStore(directory, options = {}) {
  const root = cleanString(directory);
  if (!root) throw stagingError('durable_input_manifest_directory_required', 'A manifest directory is required.');
  const fsImpl = options.fs || fs.promises;
  const filename = (assetId) => path.join(root, `${canonicalAssetId(assetId)}.json`);
  return {
    async load(assetId) {
      try {
        const manifest = JSON.parse(await fsImpl.readFile(filename(assetId), 'utf8'));
        return validateManifest(manifest);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) {
          throw stagingError('durable_input_manifest_corrupt', 'The durable input manifest is not valid JSON.');
        }
        throw error;
      }
    },
    async save(manifest) {
      validateManifest(manifest);
      await atomicWriteFile(filename(manifest.assetId), `${JSON.stringify(manifest, null, 2)}\n`, { fs: fsImpl });
    },
  };
}

function createDurableInputStager(options = {}) {
  const assetDirectory = cleanString(options.assetDirectory);
  const manifestStore = options.manifestStore;
  const upload = options.upload;
  const uploadFile = options.uploadFile;
  const fsImpl = options.fs || fs.promises;
  const createReadStream = options.createReadStream || fs.createReadStream;
  const maxConcurrentOperations = options.maxConcurrentOperations == null
    ? 4
    : Number(options.maxConcurrentOperations);
  if (!assetDirectory) throw stagingError('durable_input_asset_directory_required', 'A durable input asset directory is required.');
  if (!manifestStore || typeof manifestStore.load !== 'function' || typeof manifestStore.save !== 'function') {
    throw stagingError('durable_input_manifest_store_required', 'A durable input manifest store with load/save is required.');
  }
  if (upload != null && typeof upload !== 'function') {
    throw stagingError('durable_input_upload_invalid', 'The Comfy upload callback must be a function.');
  }
  if (uploadFile != null && typeof uploadFile !== 'function') {
    throw stagingError('durable_input_upload_file_invalid', 'The Comfy file-upload callback must be a function.');
  }
  if (!Number.isSafeInteger(maxConcurrentOperations) || maxConcurrentOperations < 1 || maxConcurrentOperations > 64) {
    throw stagingError(
      'durable_input_concurrency_invalid',
      'Durable input concurrency must be an integer between 1 and 64.',
    );
  }
  const classifyUploadError = typeof options.classifyUploadError === 'function'
    ? options.classifyUploadError
    : () => ({ code: 'durable_input_upload_unavailable', retryable: true });
  const limited = createOperationLimiter(maxConcurrentOperations);
  const assetTails = new Map();

  async function verifiedBytes(manifest) {
    let content;
    try {
      content = await fsImpl.readFile(path.join(assetDirectory, manifest.storedFilename));
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw stagingError('durable_input_bytes_missing', 'The durable input bytes are missing.', { cause });
      }
      throw cause;
    }
    if (content.length !== manifest.bytes || sha256(content) !== manifest.sha256) {
      throw stagingError('durable_input_bytes_changed', 'The durable input bytes no longer match their immutable manifest.');
    }
    return content;
  }

  async function verifiedFile(manifest) {
    const file = path.join(assetDirectory, manifest.storedFilename);
    let observed;
    try {
      observed = await hashFile(file, createReadStream);
    } catch (error) {
      if (error?.cause?.code === 'ENOENT') {
        throw stagingError('durable_input_bytes_missing', 'The durable input bytes are missing.', { cause: error.cause });
      }
      throw error;
    }
    if (observed.bytes !== manifest.bytes || observed.sha256 !== manifest.sha256) {
      throw stagingError('durable_input_bytes_changed', 'The durable input bytes no longer match their immutable manifest.');
    }
    return file;
  }

  function requestedManifest(request, owner, name, digest, bytes) {
    const assetId = durableInputIdentity(owner, name);
    return {
      version: MANIFEST_VERSION,
      assetId,
      profileId: owner,
      name,
      sha256: digest,
      bytes,
      storedFilename: `${assetId}.bin`,
      createdAt: Number.isFinite(Number(request?.createdAt)) ? Number(request.createdAt) : Date.now(),
    };
  }

  async function preserveNow(request) {
    const owner = profileId(request?.profileId);
    const name = logicalName(request?.name);
    const content = request?.content;
    if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
      throw stagingError('durable_input_content_required', 'Durable input content must be bytes.');
    }
    const digest = sha256(content);
    const requested = requestedManifest(request, owner, name, digest, content.length);
    const assetId = requested.assetId;
    let manifest = await manifestStore.load(assetId);
    if (manifest) {
      validateManifest(manifest);
      if (manifest.profileId !== owner) {
        throw stagingError('durable_input_profile_mismatch', 'This durable input belongs to another profile.');
      }
      if (manifest.name !== name || manifest.sha256 !== digest || manifest.bytes !== content.length) {
        throw stagingError('durable_input_content_conflict', 'This durable input name is already bound to different bytes.');
      }
      await verifiedBytes(manifest);
      return { state: 'preserved', reused: true, asset: publicManifest(manifest) };
    }
    const published = await publishImmutable(fsImpl, assetDirectory, requested.storedFilename, content);
    if (!published.created) {
      const existing = await fsImpl.readFile(published.target);
      if (existing.length !== requested.bytes || sha256(existing) !== requested.sha256) {
        throw stagingError('durable_input_content_conflict', 'Existing durable bytes conflict with this input name.');
      }
    }
    await manifestStore.save(requested);
    // atomicWriteFile returning is the manifest publication boundary. Reloading and
    // re-reading immutable bytes here only duplicates work; every later stage still
    // verifies them immediately before Comfy receives them.
    return { state: 'preserved', reused: false, asset: publicManifest(requested) };
  }

  async function preserveFileNow(request) {
    const owner = profileId(request?.profileId);
    const name = logicalName(request?.name);
    const sourceFile = cleanString(request?.filePath);
    if (!sourceFile) throw stagingError('durable_input_file_required', 'A source file path is required.');
    const observed = await hashFile(sourceFile, createReadStream);
    const requested = requestedManifest(request, owner, name, observed.sha256, observed.bytes);
    let manifest = await manifestStore.load(requested.assetId);
    if (manifest) {
      validateManifest(manifest);
      if (manifest.profileId !== owner) {
        throw stagingError('durable_input_profile_mismatch', 'This durable input belongs to another profile.');
      }
      if (manifest.name !== name || manifest.sha256 !== observed.sha256 || manifest.bytes !== observed.bytes) {
        throw stagingError('durable_input_content_conflict', 'This durable input name is already bound to different bytes.');
      }
      await verifiedFile(manifest);
      return { state: 'preserved', reused: true, asset: publicManifest(manifest) };
    }
    await publishImmutableFile(
      fsImpl,
      createReadStream,
      assetDirectory,
      requested.storedFilename,
      sourceFile,
      observed,
    );
    await manifestStore.save(requested);
    return { state: 'preserved', reused: false, asset: publicManifest(requested) };
  }

  function classifiedUploadFailure(cause, manifest) {
    const classification = classifyUploadError(cause) || {};
    const retryable = classification.retryable !== false;
    return {
      state: retryable ? 'waiting_for_comfy' : 'attention',
      asset: publicManifest(manifest),
      error: {
        code: cleanString(classification.code) || 'durable_input_upload_failed',
        message: cleanString(classification.message) || String(cause?.message || cause || 'Comfy upload failed.'),
        retryable,
      },
    };
  }

  function remoteNameResult(uploaded, manifest) {
    const uploadedName = typeof uploaded === 'string' ? uploaded : uploaded?.name;
    if (uploadedName !== manifest.name) {
      return {
        state: 'attention',
        asset: publicManifest(manifest),
        error: {
          code: 'durable_input_remote_name_mismatch',
          message: 'ComfyUI changed the durable input name; submission was stopped.',
          retryable: false,
        },
      };
    }
    return { state: 'staged', remoteName: uploadedName, asset: publicManifest(manifest) };
  }

  async function ownedManifest(request) {
    const owner = profileId(request?.profileId);
    const id = canonicalAssetId(request?.assetId);
    const manifest = await manifestStore.load(id);
    if (!manifest) throw stagingError('durable_input_not_found', 'The durable input does not exist.');
    if (manifest.profileId !== owner) {
      throw stagingError('durable_input_profile_mismatch', 'This durable input belongs to another profile.');
    }
    if (request?.name != null && logicalName(request.name) !== manifest.name) {
      throw stagingError('durable_input_name_mismatch', 'The requested Comfy name does not match the durable input manifest.');
    }
    if (request?.sha256 != null && cleanString(request.sha256).toLowerCase() !== manifest.sha256) {
      throw stagingError('durable_input_content_conflict', 'The requested content digest does not match the durable input manifest.');
    }
    return manifest;
  }

  async function stageNow(request) {
    const manifest = await ownedManifest(request);
    const content = await verifiedBytes(manifest);
    if (!upload) {
      return {
        state: 'waiting_for_comfy',
        asset: publicManifest(manifest),
        error: { code: 'durable_input_upload_unavailable', message: 'No Comfy upload transport is available.', retryable: true },
      };
    }
    let uploaded;
    try {
      uploaded = await upload(content, manifest.name, publicManifest(manifest));
    } catch (cause) {
      return classifiedUploadFailure(cause, manifest);
    }
    return remoteNameResult(uploaded, manifest);
  }

  async function stageFileNow(request) {
    const manifest = await ownedManifest(request);
    const file = await verifiedFile(manifest);
    if (!uploadFile) {
      return {
        state: 'waiting_for_comfy',
        asset: publicManifest(manifest),
        error: {
          code: 'durable_input_upload_unavailable',
          message: 'No Comfy file-upload transport is available.',
          retryable: true,
        },
      };
    }
    let uploaded;
    try {
      uploaded = await uploadFile(file, manifest.name, publicManifest(manifest));
    } catch (cause) {
      return classifiedUploadFailure(cause, manifest);
    }
    return remoteNameResult(uploaded, manifest);
  }

  function serialized(assetId, operation) {
    const previous = assetTails.get(assetId) || Promise.resolve();
    const run = previous.then(() => limited(operation), () => limited(operation));
    const settled = run.then(() => undefined, () => undefined);
    assetTails.set(assetId, settled);
    settled.then(() => {
      if (assetTails.get(assetId) === settled) assetTails.delete(assetId);
    });
    return run;
  }

  function keyed(request, identity, operation) {
    let assetId;
    try {
      assetId = identity(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return serialized(assetId, operation);
  }

  const preserveIdentity = (request) => durableInputIdentity(request?.profileId, request?.name);
  const stageIdentity = (request) => canonicalAssetId(request?.assetId);

  return {
    preserve(request) {
      return keyed(request, preserveIdentity, () => preserveNow(request));
    },
    preserveFile(request) {
      return keyed(request, preserveIdentity, () => preserveFileNow(request));
    },
    stage(request) {
      return keyed(request, stageIdentity, () => stageNow(request));
    },
    stageFile(request) {
      return keyed(request, stageIdentity, () => stageFileNow(request));
    },
    preserveAndStage(request) {
      return keyed(request, preserveIdentity, async () => {
        const preserved = await preserveNow(request);
        const staged = await stageNow({
          profileId: request.profileId,
          assetId: preserved.asset.assetId,
          name: preserved.asset.name,
          sha256: preserved.asset.sha256,
        });
        return { ...staged, preserved: preserved.reused ? 'reused' : 'created' };
      });
    },
  };
}

module.exports = {
  MANIFEST_VERSION,
  MAX_FILE_BYTES,
  createDurableInputStager,
  createFileDurableInputManifestStore,
  durableInputIdentity,
  stagingError,
  validateManifest,
};
