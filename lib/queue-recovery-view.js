'use strict';

function attentionQueueRows(jobs, options = {}) {
  const profileId = String(options.profileId || '');
  const now = Number(options.now) || Date.now();
  const thumbnailFor = options.thumbnailFor || (() => null);
  const labelFor = options.labelFor || (() => 'Preserved generation');
  const durationFor = options.durationFor || (() => 0);
  return [...(jobs || new Map()).entries()]
    .filter(([, job]) => job?.profileId === profileId && job?.recoveryError?.attentionRequired)
    .map(([jobId, job]) => ({
      jobId,
      kind: job.kind,
      itemId: job.itemId || null,
      thumbnail: thumbnailFor(job),
      label: labelFor(job),
      queuedAt: job.enqueuedAt || now,
      startedAt: null,
      elapsedMs: durationFor(job, now),
      durationMs: durationFor(job, now),
      owned: true,
      cancellable: true,
      reorderable: false,
      attentionRequired: true,
      error: String(job.recoveryError.message || 'This preserved generation needs attention.'),
      code: String(job.recoveryError.code || 'recovery_attention_required'),
    }));
}

function preservedQueueRows(jobs, options = {}) {
  const profileId = String(options.profileId || '');
  const now = Number(options.now) || Date.now();
  const thumbnailFor = options.thumbnailFor || (() => null);
  const labelFor = options.labelFor || (() => 'Preserved generation');
  const durationFor = options.durationFor || (() => 0);
  return [...(jobs || new Map()).entries()]
    .filter(([, job]) => job?.profileId === profileId && job?.provider !== 'runpod')
    .map(([jobId, job]) => {
      const attentionRequired = job?.recoveryError?.attentionRequired === true;
      const cancelling = job?.cancelRequested === true;
      return {
        jobId,
        kind: job.kind,
        itemId: job.itemId || null,
        thumbnail: thumbnailFor(job),
        label: labelFor(job),
        queuedAt: job.enqueuedAt || now,
        startedAt: null,
        elapsedMs: durationFor(job, now),
        durationMs: durationFor(job, now),
        owned: true,
        cancellable: true,
        reorderable: false,
        waitingForComfy: !attentionRequired && !cancelling,
        cancelling,
        attentionRequired,
        error: attentionRequired ? String(job.recoveryError.message || 'This preserved generation needs attention.') : undefined,
        code: attentionRequired ? String(job.recoveryError.code || 'recovery_attention_required') : undefined,
      };
    });
}

function offlineQueueSnapshot(options = {}) {
  const cloudRows = Array.isArray(options.cloudRows) ? options.cloudRows : [];
  const preservedRows = Array.isArray(options.preservedRows) ? options.preservedRows : [];
  const running = cloudRows.filter((row) => ['IN_PROGRESS', 'RUNNING'].includes(row.remoteStatus));
  const visibleIds = new Set(running.map((row) => row.jobId));
  const pending = cloudRows
    .filter((row) => !['IN_PROGRESS', 'RUNNING', 'COMPLETED'].includes(row.remoteStatus))
    .concat(preservedRows)
    .filter((row) => {
      if (!row?.jobId || visibleIds.has(row.jobId)) return false;
      visibleIds.add(row.jobId);
      return true;
    });
  return {
    ok: running.length > 0 || pending.length > 0,
    error: String(options.error?.message || options.error || 'ComfyUI is unavailable.'),
    preparing: [],
    running,
    pending,
    upcoming: [],
    finalizing: [],
    downloads: Array.isArray(options.activeDownloads) ? options.activeDownloads : [],
  };
}

module.exports = {
  attentionQueueRows,
  offlineQueueSnapshot,
  preservedQueueRows,
};
