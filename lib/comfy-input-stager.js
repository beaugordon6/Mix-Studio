'use strict';

const fs = require('fs');
const fsp = fs.promises;
const { inputAssetPath } = require('./input-assets');

function stagingError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = options.status || 409;
  error.recoverable = options.recoverable !== false;
  if (options.assetName) error.assetName = options.assetName;
  if (options.reason) error.reason = options.reason;
  if (options.cause) error.cause = options.cause;
  return error;
}

function requestedNames(names) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(names) ? names : []) {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function requireElementAsset(name, profileId, uploadedAssets) {
  const matches = (Array.isArray(uploadedAssets) ? uploadedAssets : [])
    .filter((asset) => asset && asset.name === name);
  const owned = matches.find((asset) => asset.profileId === profileId);
  let reason = '';
  if (!owned) reason = matches.length ? 'wrong_profile' : 'not_cataloged';
  else if (owned.deletedAt) reason = 'deleted';
  else if (owned.kind !== 'image') reason = 'not_image';
  if (reason) {
    throw stagingError(
      'element_asset_unavailable',
      'This Element reference is unavailable. Edit the Element and choose its image again.',
      { assetName: name, reason },
    );
  }
  return owned;
}

/**
 * Restore profile-owned Element images from Mix's durable input store to the
 * currently connected ComfyUI input directory before submitting a graph.
 *
 * uploadFile receives (durablePath, requestedName) and must resolve to the
 * exact stored ComfyUI name. Keeping the logical name stable means existing
 * Elements and queued generation metadata do not need to be rewritten.
 */
async function stageElementInputs({
  names,
  profileId,
  uploadedAssets,
  inputDirectory,
  uploadFile,
} = {}) {
  if (!profileId || !inputDirectory || typeof uploadFile !== 'function') {
    throw stagingError(
      'comfy_input_stage_invalid',
      'Mix Studio could not prepare this Element because its input staging configuration is incomplete.',
      { recoverable: false, status: 500 },
    );
  }

  const staged = [];
  for (const name of requestedNames(names)) {
    requireElementAsset(name, profileId, uploadedAssets);
    const durablePath = inputAssetPath(inputDirectory, name);
    try {
      await fsp.access(durablePath, fs.constants.R_OK);
    } catch (cause) {
      throw stagingError(
        'element_asset_missing',
        'This Element image is missing from Mix Studio storage. Edit the Element and choose its image again.',
        { assetName: name, reason: 'durable_file_unreadable', cause },
      );
    }

    let uploadedName;
    try {
      uploadedName = await uploadFile(durablePath, name);
    } catch (cause) {
      throw stagingError(
        'comfy_input_stage_failed',
        'Mix Studio could not restore this Element image to ComfyUI. Check the ComfyUI connection and try again.',
        { assetName: name, status: 502, cause },
      );
    }
    if (uploadedName !== name) {
      throw stagingError(
        'comfy_input_name_changed',
        'ComfyUI stored this Element image under a different name. Try again before generating.',
        { assetName: name, reason: 'name_changed', status: 502 },
      );
    }
    staged.push(name);
  }
  return staged;
}

module.exports = {
  requestedNames,
  stageElementInputs,
};
