'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createGalleryFinalizationManifest,
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
} = require('../../lib/gallery-finalization');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

function injectedCrash(point) {
  const error = new Error(`Injected finalization crash: ${point}`);
  error.code = 'injected_finalization_crash';
  error.point = point;
  return error;
}

function outputFiles(history) {
  const files = [];
  for (const output of Object.values(history?.outputs || {})) {
    for (const image of Array.isArray(output?.images) ? output.images : []) files.push(image);
  }
  return files;
}

class GalleryFinalizationHarness {
  constructor(options) {
    this.root = options.root;
    this.comfyUrl = options.comfyUrl;
    this.promptId = options.promptId;
    this.operationId = options.operationId;
    this.download = options.download;
    this.manifestFile = path.join(this.root, 'finalizations', `${this.operationId}.json`);
    this.dbFile = path.join(this.root, 'db.json');
    this.imagesDirectory = path.join(this.root, 'images');
  }

  static async prepare(options) {
    const harness = new GalleryFinalizationHarness(options);
    fs.mkdirSync(harness.imagesDirectory, { recursive: true });
    atomicJson(harness.dbFile, { items: [], history: [] });
    const outputs = [];
    for (let index = 0; index < options.contents.length; index += 1) {
      const content = options.contents[index];
      outputs.push({
        outputIndex: index,
        kind: 'image',
        role: 'output',
        extension: '.png',
        sha256: hashAsset(content),
        bytes: content.length,
      });
    }
    atomicJson(harness.manifestFile, createGalleryFinalizationManifest({
      operationId: options.operationId,
      profileId: options.profileId,
      workflow: options.workflow,
      outputs,
      createdAt: options.createdAt || 1,
    }));
    return harness;
  }

  manifest() {
    return readJson(this.manifestFile, null);
  }

  db() {
    return readJson(this.dbFile, { items: [], history: [] });
  }

  requestCancellation() {
    const cancelled = requestFinalizationCancellation(this.manifest());
    atomicJson(this.manifestFile, cancelled);
    return cancelled;
  }

  _crash(point, selectedPoint) {
    if (point === selectedPoint) throw injectedCrash(point);
  }

  _assetObservation(output) {
    const file = path.join(this.imagesDirectory, output.filename);
    try {
      const content = fs.readFileSync(file);
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

  async resume(options = {}) {
    const crashAt = options.crashAt || '';
    let manifest = this.manifest();
    if (manifest.completed || manifest.cancelRequested) return manifest;

    const response = await fetch(`${this.comfyUrl}/history/${encodeURIComponent(this.promptId)}`);
    if (!response.ok) throw new Error(`Fake Comfy history returned ${response.status}`);
    const history = (await response.json())[this.promptId];
    if (!history?.status?.completed) throw new Error('The fake Comfy prompt is not complete.');
    const remoteFiles = outputFiles(history);
    if (remoteFiles.length !== manifest.outputs.length) throw new Error('Fake Comfy output count does not match the manifest.');

    for (let position = 0; position < manifest.outputs.length; position += 1) {
      const output = manifest.outputs[position];
      const observation = this._assetObservation(output);
      const plan = planAssetWrite(manifest, output.outputIndex, observation);
      if (plan.action === 'write') {
        const content = await this.download(remoteFiles[position]);
        if (hashAsset(content) !== output.sha256 || content.length !== output.bytes) {
          throw new Error('Downloaded output does not match the durable manifest.');
        }
        const destination = path.join(this.imagesDirectory, output.filename);
        const temporary = `${destination}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, content);
        fs.renameSync(temporary, destination);
        this._crash('after_asset_write', crashAt);
        manifest = markAssetReady(manifest, output.outputIndex, this._assetObservation(output), 'written');
        atomicJson(this.manifestFile, manifest);
      } else if (plan.action === 'reuse') {
        manifest = markAssetReady(manifest, output.outputIndex, observation, 'reused');
        atomicJson(this.manifestFile, manifest);
      } else if (plan.action !== 'suppress') {
        throw new Error(`Asset finalization stopped: ${plan.reason || plan.action}`);
      }
    }

    for (const output of manifest.outputs) {
      const db = this.db();
      const candidate = galleryItemRecord(manifest, output.outputIndex, {
        mode: 't2i', prompt: 'fixture prompt', createdAt: 1,
      });
      const plan = planItemUpsert(manifest, output.outputIndex, db.items, candidate);
      if (plan.action === 'insert') {
        db.items.push(plan.record);
        atomicJson(this.dbFile, db);
        this._crash('after_item_upsert', crashAt);
      } else if (plan.action !== 'reuse' && plan.action !== 'suppress') {
        throw new Error(`Item finalization stopped: ${plan.reason || plan.action}`);
      }
      if (plan.action !== 'suppress') {
        manifest = markItemUpserted(manifest, output.outputIndex);
        atomicJson(this.manifestFile, manifest);
      }
    }

    for (const output of manifest.outputs) {
      const db = this.db();
      const candidate = galleryHistoryRecord(manifest, output.outputIndex, {
        kind: 'gen', label: 'Create: fixture prompt', ts: 1,
      });
      const plan = planHistoryUpsert(manifest, output.outputIndex, db.history, candidate);
      if (plan.action === 'insert') {
        db.history.push(plan.record);
        atomicJson(this.dbFile, db);
        this._crash('after_history_upsert', crashAt);
      } else if (plan.action !== 'reuse' && plan.action !== 'suppress') {
        throw new Error(`History finalization stopped: ${plan.reason || plan.action}`);
      }
      if (plan.action !== 'suppress') {
        manifest = markHistoryUpserted(manifest, output.outputIndex);
        atomicJson(this.manifestFile, manifest);
      }
    }

    manifest = markFinalizationComplete(manifest);
    atomicJson(this.manifestFile, manifest);
    return manifest;
  }
}

module.exports = { GalleryFinalizationHarness };
