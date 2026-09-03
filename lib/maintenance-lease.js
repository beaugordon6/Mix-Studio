'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEASE_SCHEMA_VERSION = 1;
const MAINTENANCE_KINDS = Object.freeze([
  'app_update',
  'app_restart',
  'comfy_restart',
  'comfy_setup',
  'dependency_install',
  'deployment',
  'model_maintenance',
]);

function leaseError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function validToken(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(text) ? text : '';
}

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!MAINTENANCE_KINDS.includes(kind)) {
    throw leaseError('maintenance_kind_invalid', `Unsupported maintenance operation: ${kind || 'missing'}.`);
  }
  return kind;
}

function normalizePid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) {
    throw leaseError('maintenance_pid_invalid', 'A valid maintenance process ID is required.');
  }
  return pid;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw leaseError('maintenance_lease_corrupt', 'The maintenance lock is unreadable and needs attention.');
  }
  const token = validToken(value.token);
  const pid = normalizePid(value.pid);
  const kind = normalizeKind(value.kind);
  const startedAt = String(value.startedAt || '');
  if (!token || !Number.isFinite(Date.parse(startedAt))) {
    throw leaseError('maintenance_lease_corrupt', 'The maintenance lock is invalid and needs attention.');
  }
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    token,
    pid,
    kind,
    startedAt: new Date(startedAt).toISOString(),
    revision: /^[a-f0-9]{7,64}$/i.test(String(value.revision || '')) ? String(value.revision) : null,
    dirtyTrackedCount: Number.isSafeInteger(value.dirtyTrackedCount) && value.dirtyTrackedCount >= 0
      ? value.dirtyTrackedCount
      : 0,
  };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function durableWriteNew(file, record, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fsImpl.openSync(file, 'wx', 0o600);
  try {
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    try { fsImpl.closeSync(descriptor); } catch { /* best effort */ }
    try { fsImpl.unlinkSync(file); } catch { /* best effort */ }
    throw error;
  } finally {
    try { fsImpl.closeSync(descriptor); } catch { /* already closed after a write failure */ }
  }
  try { fsImpl.chmodSync(file, 0o600); } catch { /* ACL-backed platforms may not support chmod. */ }
  try {
    const directory = fsImpl.openSync(path.dirname(file), 'r');
    try { fsImpl.fsyncSync(directory); } finally { fsImpl.closeSync(directory); }
  } catch { /* Windows and some filesystems do not permit directory fsync. */ }
}

function createMaintenanceLease(options = {}) {
  if (!String(options.file || '').trim()) {
    throw leaseError('maintenance_file_required', 'A maintenance lock file is required.');
  }
  const file = path.resolve(String(options.file));
  const pid = normalizePid(options.pid || process.pid);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const processAlive = options.processAlive || defaultProcessAlive;
  const fsImpl = options.fs || fs;

  function read() {
    try {
      return normalizeRecord(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code?.startsWith?.('maintenance_')) throw error;
      throw leaseError('maintenance_lease_corrupt', 'The maintenance lock is unreadable and needs attention.', { cause: error });
    }
  }

  function status() {
    const record = read();
    if (!record) return { active: false, stale: false, lease: null };
    const active = processAlive(record.pid) === true;
    return { active, stale: !active, lease: record };
  }

  function moveStale(record) {
    const suffix = validToken(randomUUID()) || crypto.randomUUID();
    const quarantine = `${file}.stale.${record.pid}.${suffix}`;
    try {
      fsImpl.renameSync(file, quarantine);
      return quarantine;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw leaseError('maintenance_lease_reclaim_failed', 'Mix Studio could not safely reclaim an abandoned maintenance lock.', { cause: error });
    }
  }

  function acquire(source = {}) {
    const kind = normalizeKind(source.kind);
    const token = validToken(source.token || randomUUID());
    if (!token) throw leaseError('maintenance_token_invalid', 'A canonical maintenance token is required.');
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw leaseError('maintenance_clock_invalid', 'The maintenance clock returned an invalid time.');
    }
    const revision = /^[a-f0-9]{7,64}$/i.test(String(source.revision || '')) ? String(source.revision) : null;
    const dirtyTrackedCount = Number.isSafeInteger(source.dirtyTrackedCount) && source.dirtyTrackedCount >= 0
      ? source.dirtyTrackedCount
      : 0;
    const record = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      token,
      pid,
      kind,
      startedAt: timestamp.toISOString(),
      revision,
      dirtyTrackedCount,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        durableWriteNew(file, record, fsImpl);
        return record;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const current = status();
        if (current.active) {
          throw leaseError('maintenance_busy', `Mix Studio is already running ${current.lease.kind.replaceAll('_', ' ')}.`, {
            activeKind: current.lease.kind,
            activePid: current.lease.pid,
            startedAt: current.lease.startedAt,
          });
        }
        const quarantined = moveStale(current.lease);
        if (quarantined) {
          try { fsImpl.unlinkSync(quarantined); } catch { /* stale evidence is safe to leave for later cleanup. */ }
        }
      }
    }
    throw leaseError('maintenance_lease_race', 'Another maintenance operation repeatedly claimed the lock. Try again.');
  }

  function release(tokenValue) {
    const token = validToken(tokenValue);
    if (!token) throw leaseError('maintenance_token_invalid', 'A canonical maintenance token is required.');
    const current = read();
    if (!current) return false;
    if (current.token !== token || current.pid !== pid) {
      throw leaseError('maintenance_lease_not_owned', 'This process does not own the active maintenance lock.');
    }
    const released = `${file}.released.${pid}.${token}`;
    try {
      fsImpl.renameSync(file, released);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw leaseError('maintenance_lease_release_failed', 'Mix Studio could not safely release its maintenance lock.', { cause: error });
    }
    const moved = normalizeRecord(JSON.parse(fsImpl.readFileSync(released, 'utf8')));
    if (moved.token !== token || moved.pid !== pid) {
      try { fsImpl.renameSync(released, file); } catch { /* Preserve the unexpected lease for diagnosis. */ }
      throw leaseError('maintenance_lease_not_owned', 'The maintenance lock changed before it could be released.');
    }
    fsImpl.unlinkSync(released);
    return true;
  }

  async function run(source, work) {
    if (typeof work !== 'function') throw leaseError('maintenance_work_invalid', 'Maintenance work must be a function.');
    const lease = acquire(source);
    try {
      return await work(lease);
    } finally {
      release(lease.token);
    }
  }

  return Object.freeze({ file, acquire, release, run, status });
}

module.exports = {
  LEASE_SCHEMA_VERSION,
  MAINTENANCE_KINDS,
  createMaintenanceLease,
  normalizeRecord,
};
