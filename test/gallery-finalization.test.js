'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareAssetIdentity,
  createGalleryFinalizationManifest,
  deterministicGalleryIdentity,
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
} = require('../lib/gallery-finalization');

const OPERATION_ID = '10101010-2020-4030-8040-505050505050';
const CONTENT = Buffer.from('stable generated pixels');
const OUTPUT = { outputIndex: 0, kind: 'image', role: 'output', extension: '.png', sha256: hashAsset(CONTENT), bytes: CONTENT.length };

function manifest(outputs = [OUTPUT]) {
  return createGalleryFinalizationManifest({
    operationId: OPERATION_ID,
    profileId: 'owner',
    workflow: 'create:krea2-elements',
    createdAt: 1234,
    outputs,
  });
}

function expectedAsset(value, outputIndex = 0) {
  const output = value.outputs.find((entry) => entry.outputIndex === outputIndex);
  return { assetId: output.assetId, filename: output.filename, sha256: output.sha256, bytes: output.bytes };
}

test('identities and filenames are deterministic, index-scoped, and path-safe', () => {
  const one = deterministicGalleryIdentity(OPERATION_ID, 0, { kind: 'image', extension: '.png' });
  const again = deterministicGalleryIdentity(OPERATION_ID, 0, { kind: 'image', extension: '.png' });
  const next = deterministicGalleryIdentity(OPERATION_ID, 1, { kind: 'image', extension: '.png' });
  assert.deepEqual(one, again);
  assert.notEqual(one.itemId, next.itemId);
  assert.notEqual(one.mediaId, next.mediaId);
  assert.notEqual(one.filename, next.filename);
  assert.match(one.filename, /^[0-9a-f]{24}\.png$/);
  assert.doesNotMatch(one.filename, /[\\/]/);
  assert.throws(
    () => deterministicGalleryIdentity(OPERATION_ID, 0, { role: '../escape' }),
    { code: 'finalization_token_invalid' },
  );
});

test('manifest creation requires verified content identity and survives JSON resume', () => {
  const first = manifest();
  const resumed = JSON.parse(JSON.stringify(first));
  assert.deepEqual(validateManifest(resumed), first);
  assert.equal(first.phase, 'prepared');
  assert.equal(first.outputs[0].sha256, hashAsset(CONTENT));
  assert.throws(
    () => manifest([{ ...OUTPUT, sha256: 'unknown' }]),
    { code: 'finalization_hash_invalid' },
  );
});

test('an absent asset is written, while an exact prior write is safely reused', () => {
  const initial = manifest();
  assert.equal(planAssetWrite(initial, 0, { exists: false }).action, 'write');
  const written = markAssetReady(initial, 0, expectedAsset(initial), 'written');
  assert.equal(written.phase, 'assets_written');
  assert.equal(planAssetWrite(written, 0, { exists: true, ...expectedAsset(written) }).action, 'reuse');
  assert.equal(planAssetWrite(written, 0, { exists: false }).action, 'write');

  const resumed = manifest();
  const plan = planAssetWrite(resumed, 0, { exists: true, ...expectedAsset(resumed) });
  assert.equal(plan.action, 'reuse');
  const reused = markAssetReady(resumed, 0, plan.asset, 'reused');
  assert.equal(reused.outputs[0].assetState, 'reused');
  assert.equal(reused.phase, 'assets_written');
});

test('same filename with different content is a conflict, never an overwrite', () => {
  const initial = manifest();
  const observed = { ...expectedAsset(initial), sha256: hashAsset(Buffer.from('other pixels')) };
  const plan = planAssetWrite(initial, 0, { exists: true, ...observed });
  assert.equal(plan.action, 'conflict');
  assert.deepEqual(plan.mismatches, ['sha256']);
  const attention = markAssetReady(initial, 0, observed, 'reused');
  assert.equal(attention.phase, 'attention');
  assert.deepEqual(attention.conflict.mismatches, ['sha256']);
});

test('asset identity requires filename, hash, size, and deterministic asset id', () => {
  const initial = manifest();
  assert.deepEqual(compareAssetIdentity(expectedAsset(initial), expectedAsset(initial)), { ok: true, mismatches: [] });
  assert.deepEqual(
    compareAssetIdentity(expectedAsset(initial), { ...expectedAsset(initial), filename: 'wrong.png', bytes: CONTENT.length + 1 }),
    { ok: false, mismatches: ['filename', 'bytes'] },
  );
});

test('item and history upserts insert once and then reuse exact records', () => {
  let state = markAssetReady(manifest(), 0, expectedAsset(manifest()), 'written');
  const item = galleryItemRecord(state, 0, { prompt: 'Hermes on grey', createdAt: 1234 });
  assert.equal(planItemUpsert(state, 0, [], item).action, 'insert');
  assert.equal(planItemUpsert(state, 0, [item], item).action, 'reuse');

  state = markItemUpserted(state, 0);
  assert.equal(state.phase, 'catalog_upserted');
  const history = galleryHistoryRecord(state, 0, { kind: 'gen', label: 'Create: Hermes' });
  assert.equal(planHistoryUpsert(state, 0, [], history).action, 'insert');
  assert.equal(planHistoryUpsert(state, 0, [history], history).action, 'reuse');
  state = markHistoryUpserted(state, 0);
  assert.equal(state.phase, 'history_upserted');

  assert.equal(markHistoryUpserted(state, 0).phase, 'history_upserted');
  assert.equal(markItemUpserted(state, 0).phase, 'history_upserted');
  state = markFinalizationComplete(state);
  assert.equal(state.phase, 'complete');
  assert.equal(markFinalizationComplete(state).phase, 'complete');
});

test('logical duplicates with mismatched identity stop for attention', () => {
  let state = markAssetReady(manifest(), 0, expectedAsset(manifest()), 'written');
  const item = galleryItemRecord(state, 0, { prompt: 'expected' });
  const collision = { ...item, profileId: 'someone-else' };
  assert.deepEqual(
    planItemUpsert(state, 0, [collision], item),
    { action: 'conflict', reason: 'item_identity_mismatch', recordId: item.id },
  );

  state = markItemUpserted(state, 0);
  const history = galleryHistoryRecord(state, 0, { kind: 'gen' });
  const historyCollision = { ...history, finalization: { ...history.finalization, sha256: '0'.repeat(64) } };
  assert.deepEqual(
    planHistoryUpsert(state, 0, [historyCollision], history),
    { action: 'conflict', reason: 'history_identity_mismatch', recordId: history.id },
  );
});

test('upsert planners reject caller records that do not carry the manifest identity', () => {
  let state = markAssetReady(manifest(), 0, expectedAsset(manifest()), 'written');
  const item = galleryItemRecord(state, 0, {});
  assert.deepEqual(
    planItemUpsert(state, 0, [], { ...item, file: 'unrelated.png' }),
    { action: 'conflict', reason: 'item_candidate_identity_mismatch', recordId: item.id },
  );
  state = markItemUpserted(state, 0);
  const history = galleryHistoryRecord(state, 0, {});
  assert.deepEqual(
    planHistoryUpsert(state, 0, [], { ...history, itemId: 'unrelated' }),
    { action: 'conflict', reason: 'history_candidate_identity_mismatch', recordId: history.id },
  );
});

test('phase ordering blocks catalog/history before prerequisites', () => {
  const initial = manifest();
  const item = galleryItemRecord(initial, 0, {});
  assert.deepEqual(planItemUpsert(initial, 0, [], item), { action: 'blocked', reason: 'asset_not_ready' });
  assert.throws(() => markItemUpserted(initial, 0), { code: 'finalization_phase_invalid' });
  assert.deepEqual(planHistoryUpsert(initial, 0, [], {}), { action: 'blocked', reason: 'item_not_upserted' });
  assert.throws(() => markHistoryUpserted(initial, 0), { code: 'finalization_phase_invalid' });
  assert.throws(() => markFinalizationComplete(initial), { code: 'finalization_phase_invalid' });
});

test('cancellation suppresses all remaining side effects, including on resume', () => {
  const cancelled = requestFinalizationCancellation(manifest());
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.lateCancellation, false);
  assert.deepEqual(planAssetWrite(cancelled, 0, { exists: false }), { action: 'suppress', reason: 'cancel_requested' });
  assert.deepEqual(planItemUpsert(cancelled, 0, [], {}), { action: 'suppress', reason: 'cancel_requested' });
  const resumed = JSON.parse(JSON.stringify(cancelled));
  assert.equal(markAssetReady(resumed, 0, expectedAsset(resumed)).outputs[0].assetState, 'pending');
  assert.deepEqual(requestFinalizationCancellation(resumed), cancelled);

  const preparedCancelled = createGalleryFinalizationManifest({
    operationId: OPERATION_ID,
    profileId: 'owner',
    workflow: 'create:krea2-elements',
    outputs: [OUTPUT],
    cancelRequested: true,
  });
  assert.equal(preparedCancelled.phase, 'cancelled');
  assert.equal(planAssetWrite(preparedCancelled, 0, { exists: false }).action, 'suppress');
});

test('late cancellation records partial visibility and suppresses history', () => {
  let state = markAssetReady(manifest(), 0, expectedAsset(manifest()), 'written');
  state = markItemUpserted(state, 0);
  state = requestFinalizationCancellation(state);
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.lateCancellation, true);
  assert.deepEqual(planHistoryUpsert(state, 0, [], {}), { action: 'suppress', reason: 'cancel_requested' });
  assert.equal(markHistoryUpserted(state, 0).outputs[0].historyState, 'pending');
});

test('multi-output finalization stays at the earliest incomplete resume phase', () => {
  const other = Buffer.from('second output');
  let state = manifest([
    OUTPUT,
    { ...OUTPUT, outputIndex: 1, sha256: hashAsset(other), bytes: other.length },
  ]);
  state = markAssetReady(state, 0, expectedAsset(state, 0));
  assert.equal(state.phase, 'prepared');
  state = markAssetReady(state, 1, expectedAsset(state, 1));
  assert.equal(state.phase, 'assets_written');
  state = markItemUpserted(state, 0);
  assert.equal(state.phase, 'assets_written');
  state = markItemUpserted(state, 1);
  assert.equal(state.phase, 'catalog_upserted');
});
