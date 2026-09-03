'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMaintenanceLease } = require('../lib/maintenance-lease');

const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-maintenance-lease-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'maintenance.lock');
}

test('one durable lease serializes different maintenance operations across processes', async (t) => {
  const file = await fixture(t);
  const alive = new Set([101, 202]);
  const options = { file, processAlive: (pid) => alive.has(pid), now: () => new Date('2026-09-02T22:00:00.000Z') };
  const first = createMaintenanceLease({ ...options, pid: 101, randomUUID: () => TOKEN_A });
  const second = createMaintenanceLease({ ...options, pid: 202, randomUUID: () => TOKEN_B });

  const acquired = first.acquire({ kind: 'dependency_install', revision: 'a'.repeat(40), dirtyTrackedCount: 0 });
  assert.equal(acquired.token, TOKEN_A);
  assert.deepEqual(first.status(), { active: true, stale: false, lease: acquired });
  assert.throws(() => second.acquire({ kind: 'comfy_restart' }), {
    code: 'maintenance_busy',
    activeKind: 'dependency_install',
    activePid: 101,
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(first.release(TOKEN_A), true);
  assert.equal(first.status().active, false);
  assert.equal(second.acquire({ kind: 'comfy_restart' }).token, TOKEN_B);
});

test('an abandoned process lease is reclaimed without allowing a concurrent live owner', async (t) => {
  const file = await fixture(t);
  const alive = new Set([303]);
  const stale = createMaintenanceLease({
    file, pid: 303, processAlive: (pid) => alive.has(pid), randomUUID: () => TOKEN_A,
  });
  stale.acquire({ kind: 'app_update' });
  alive.delete(303);

  const replacement = createMaintenanceLease({
    file, pid: 404, processAlive: (pid) => alive.has(pid), randomUUID: () => TOKEN_B,
  });
  const acquired = replacement.acquire({ kind: 'deployment' });
  assert.equal(acquired.pid, 404);
  assert.equal(acquired.token, TOKEN_B);
  assert.equal(replacement.status().active, false, 'the injected process table intentionally marks PID 404 dead');
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.stale.')), false);
});

test('release is ownership checked and run always releases after a failure', async (t) => {
  const file = await fixture(t);
  const lease = createMaintenanceLease({
    file, pid: 505, processAlive: () => true, randomUUID: () => TOKEN_A,
  });
  lease.acquire({ kind: 'app_restart' });
  assert.throws(() => lease.release(TOKEN_B), { code: 'maintenance_lease_not_owned' });
  assert.equal(lease.status().active, true);
  lease.release(TOKEN_A);

  await assert.rejects(
    lease.run({ kind: 'model_maintenance', token: TOKEN_B }, async () => {
      throw Object.assign(new Error('test failure'), { code: 'expected_failure' });
    }),
    { code: 'expected_failure' },
  );
  assert.deepEqual(lease.status(), { active: false, stale: false, lease: null });
});

test('invalid or corrupt lock data fails closed with typed errors', async (t) => {
  const file = await fixture(t);
  assert.throws(() => createMaintenanceLease({}), { code: 'maintenance_file_required' });
  const lease = createMaintenanceLease({ file, pid: 606, processAlive: () => false });
  await fsp.writeFile(file, '{broken');
  assert.throws(() => lease.status(), { code: 'maintenance_lease_corrupt' });
  assert.throws(() => lease.acquire({ kind: 'not_real' }), { code: 'maintenance_kind_invalid' });
});
