'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attentionQueueRows,
  offlineQueueSnapshot,
  preservedQueueRows,
} = require('../lib/queue-recovery-view');

test('offline queue preserves profile-owned attention jobs without exposing another profile', () => {
  const jobs = new Map([
    ['owned', {
      kind: 'gen', profileId: 'owner', enqueuedAt: 10,
      recoveryError: { attentionRequired: true, code: 'element_asset_missing', message: 'Replace @hermes image.' },
    }],
    ['foreign', {
      kind: 'gen', profileId: 'other',
      recoveryError: { attentionRequired: true, code: 'element_asset_missing', message: 'Private foreign detail.' },
    }],
    ['retrying', { kind: 'gen', profileId: 'owner' }],
  ]);
  const attention = attentionQueueRows(jobs, {
    profileId: 'owner', now: 100, labelFor: () => 'Image generation', durationFor: () => 90,
  });
  const response = offlineQueueSnapshot({
    preservedRows: attention,
    error: new Error('ComfyUI is offline'),
    activeDownloads: [{ id: 'download' }],
  });

  assert.equal(response.ok, true);
  assert.equal(response.error, 'ComfyUI is offline');
  assert.deepEqual(response.running, []);
  assert.equal(response.pending.length, 1);
  assert.equal(response.pending[0].jobId, 'owned');
  assert.equal(response.pending[0].attentionRequired, true);
  assert.equal(response.pending[0].code, 'element_asset_missing');
  assert.equal(JSON.stringify(response).includes('Private foreign detail.'), false);
  assert.deepEqual(response.downloads, [{ id: 'download' }]);
});

test('offline queue retains ordinary durable jobs, cloud work, and stable order without duplicates', () => {
  const jobs = new Map([
    ['local-1', { kind: 'gen', profileId: 'owner', enqueuedAt: 1 }],
    ['local-2', { kind: 'edit', profileId: 'owner', enqueuedAt: 2, requeueing: true }],
    ['cloud-dupe', { kind: 'video', profileId: 'owner', provider: 'runpod' }],
    ['foreign', { kind: 'gen', profileId: 'other' }],
  ]);
  const preserved = preservedQueueRows(jobs, {
    profileId: 'owner', now: 100, labelFor: (job) => job.kind, durationFor: () => 10,
  });
  assert.deepEqual(preserved.map((row) => row.jobId), ['local-1', 'local-2']);
  assert.ok(preserved.every((row) => row.waitingForComfy));

  const cloudRows = [
    { jobId: 'run', remoteStatus: 'RUNNING' },
    { jobId: 'wait', remoteStatus: 'IN_QUEUE' },
    { jobId: 'done', remoteStatus: 'COMPLETED' },
  ];
  const response = offlineQueueSnapshot({ cloudRows, preservedRows: preserved, error: 'disconnected' });
  assert.deepEqual(response.running.map((row) => row.jobId), ['run']);
  assert.deepEqual(response.pending.map((row) => row.jobId), ['wait', 'local-1', 'local-2']);
  assert.equal(response.ok, true);

  const empty = offlineQueueSnapshot({ error: 'disconnected' });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.pending, []);
  assert.deepEqual(empty.downloads, []);
});

test('offline queue keeps durable cancellation visible until Comfy confirms it', () => {
  const rows = preservedQueueRows(new Map([
    ['cancel-me', {
      kind: 'gen', profileId: 'owner', enqueuedAt: 10,
      cancelRequested: true, submissionState: 'cancel_requested',
    }],
  ]), {
    profileId: 'owner', now: 20,
    thumbnailFor: () => null, labelFor: () => 'Cancelled portrait', durationFor: () => 10,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cancelling, true);
  assert.equal(rows[0].waitingForComfy, false);
  assert.equal(rows[0].cancellable, true);
});
