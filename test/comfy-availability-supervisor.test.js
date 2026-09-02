'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createComfyAvailabilitySupervisor } = require('../lib/comfy-availability-supervisor');

const SAVED = 'http://127.0.0.1:8188';
const DRIFTED = 'http://127.0.0.1:8197';
const runtime = { comfy: { url: SAVED, path: '/studio/Mix-ComfyUI' } };
const verified = (url) => ({ observed: { url }, match: { status: 'verified', mismatches: [] } });
const foreign = (url) => ({ observed: { url }, match: { status: 'foreign', mismatches: ['sourcePath'] } });

function harness(overrides = {}) {
  const events = [];
  const states = [];
  const available = new Set(overrides.available || []);
  const attestations = new Map(overrides.attestations || []);
  let configuredUrl = overrides.configuredUrl || SAVED;
  let clock = Number.isFinite(overrides.clock) ? overrides.clock : 100;
  const callbacks = {
    runtime: overrides.runtime || runtime,
    getConfiguredUrl: () => configuredUrl,
    probe: async (url) => {
      events.push(`probe:${url}`);
      return available.has(url);
    },
    discover: async () => {
      events.push('discover');
      return overrides.discovered || [];
    },
    attest: async (url) => {
      events.push(`attest:${url}`);
      return attestations.get(url) || verified(url);
    },
    adopt: async (url) => {
      events.push(`adopt:${url}`);
      if (typeof overrides.adopt === 'function') await overrides.adopt(url);
      configuredUrl = url;
    },
    startStatus: () => overrides.launch || { canStart: true, kind: 'python', requiresUserAction: false },
    start: async (context) => {
      events.push(`start:${context.attempt}`);
      return typeof overrides.start === 'function' ? overrides.start(context, available, attestations) : {};
    },
    wait: async (ms, context) => {
      events.push(context.backoff ? `backoff:${ms}` : `wait:${context.attempt}:${context.check}`);
      if (typeof overrides.wait === 'function') await overrides.wait(ms, context, available, attestations);
    },
    reconcile: async (context) => {
      events.push(`reconcile:${context.url}`);
      if (typeof overrides.reconcile === 'function') await overrides.reconcile(context);
    },
    onState: (state) => {
      states.push(state);
      if (typeof overrides.onState === 'function') overrides.onState(state);
    },
    now: () => clock,
    maxLaunchAttempts: overrides.maxLaunchAttempts || 2,
    readinessChecksPerAttempt: overrides.readinessChecksPerAttempt || 2,
    readinessIntervalMs: 0,
    backoffMs: overrides.backoffMs || [5],
    maxRecoveriesPerWindow: overrides.maxRecoveriesPerWindow,
    recoveryWindowMs: overrides.recoveryWindowMs,
    maxLaunchFailuresPerWindow: overrides.maxLaunchFailuresPerWindow,
    launchCooldownMs: overrides.launchCooldownMs,
  };
  return {
    supervisor: createComfyAvailabilitySupervisor(callbacks),
    events,
    states,
    available,
    attestations,
    configuredUrl: () => configuredUrl,
    advanceClock: (ms) => { clock += ms; },
  };
}

test('a healthy configured endpoint is attested before reconciliation and never launched', async () => {
  const value = harness({ available: [SAVED], attestations: [[SAVED, verified(SAVED)]] });
  const result = await value.supervisor.ensure('boot');
  assert.equal(result.url, SAVED);
  assert.equal(result.launched, false);
  assert.ok(value.events.indexOf(`attest:${SAVED}`) < value.events.indexOf(`reconcile:${SAVED}`));
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
  assert.equal(value.supervisor.getState().status, 'connected');
});

test('port drift is adopted only after the discovered endpoint passes canonical attestation', async () => {
  const value = harness({
    available: [DRIFTED],
    discovered: [{ url: DRIFTED, source: 'process' }],
    attestations: [[DRIFTED, verified(DRIFTED)]],
  });
  const result = await value.supervisor.ensure('reconnect');
  assert.equal(result.url, DRIFTED);
  assert.equal(value.configuredUrl(), DRIFTED);
  assert.ok(value.events.indexOf(`attest:${DRIFTED}`) < value.events.indexOf(`adopt:${DRIFTED}`));
  assert.ok(value.events.indexOf(`adopt:${DRIFTED}`) < value.events.indexOf(`reconcile:${DRIFTED}`));
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
});

test('simultaneous ensure calls share one flight and launch the source once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const value = harness({
    start: async () => { await gate; },
    wait: async (ms, context, available) => {
      if (!context.backoff) available.add(SAVED);
    },
  });
  const first = value.supervisor.ensure('websocket_close');
  const second = value.supervisor.ensure('poll_failure');
  assert.equal(first, second);
  assert.equal(value.supervisor.isRunning(), true);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(value.events.filter((entry) => entry.startsWith('start:')).length, 1);
  assert.equal(value.supervisor.isRunning(), false);
});

test('a foreign listener at the configured address is typed and never adopted or launched', async () => {
  const value = harness({ available: [SAVED], attestations: [[SAVED, foreign(SAVED)]] });
  await assert.rejects(value.supervisor.ensure('upload'), (error) => (
    error.code === 'comfy_runtime_mismatch'
      && error.status === 409
      && error.details.mismatches.includes('sourcePath')
  ));
  assert.equal(value.events.some((entry) => entry.startsWith('adopt:')), false);
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
  assert.equal(value.supervisor.getState().status, 'attention');
});

test('an occupied configured address that cannot be attested is never launched into', async () => {
  const value = harness({
    available: [SAVED],
    attestations: [[SAVED, { match: { status: 'unverifiable' } }]],
  });
  await assert.rejects(value.supervisor.ensure('upload'), {
    code: 'comfy_runtime_unverifiable',
    status: 409,
  });
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
  assert.equal(value.supervisor.getState().code, 'comfy_runtime_unverifiable');
});

test('multiple verified endpoints require attention instead of arbitrary adoption', async () => {
  const value = harness({ available: [SAVED, DRIFTED], discovered: [DRIFTED] });
  await assert.rejects(value.supervisor.ensure(), (error) => (
    error.code === 'comfy_multiple_verified_instances'
      && error.details.urls.length === 2
  ));
  assert.equal(value.events.some((entry) => entry.startsWith('adopt:')), false);
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
});

test('an unavailable remote endpoint never discovers or starts a local replacement', async () => {
  const remoteRuntime = { comfy: { url: 'https://render.example.test', path: '' } };
  const value = harness({ runtime: remoteRuntime, configuredUrl: remoteRuntime.comfy.url });
  await assert.rejects(value.supervisor.ensure(), { code: 'comfy_remote_unreachable' });
  assert.equal(value.events.includes('discover'), false);
  assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
});

test('Desktop-managed and portable installations are never auto-launched', async (t) => {
  for (const launch of [
    { canStart: true, kind: 'desktop', requiresUserAction: true },
    { canStart: true, kind: 'portable', requiresUserAction: false },
  ]) {
    await t.test(launch.kind, async () => {
      const value = harness({ launch });
      const expected = launch.kind === 'desktop'
        ? 'comfy_desktop_user_action_required' : 'comfy_start_unavailable';
      await assert.rejects(value.supervisor.ensure(), { code: expected });
      assert.equal(value.events.some((entry) => entry.startsWith('start:')), false);
    });
  }
});

test('a configured source becomes connected after one bounded readiness wait', async () => {
  const value = harness({
    wait: async (ms, context, available) => {
      if (!context.backoff) available.add(SAVED);
    },
  });
  const result = await value.supervisor.ensure('boot');
  assert.equal(result.launched, true);
  assert.equal(result.attempt, 1);
  assert.deepEqual(value.events.filter((entry) => entry.startsWith('start:')), ['start:1']);
  assert.ok(value.states.some((state) => state.status === 'starting'));
  assert.ok(value.states.some((state) => state.status === 'waiting'));
  assert.equal(value.states.at(-1).status, 'connected');
});

test('reconciliation must succeed before the supervisor reports connected', async () => {
  const value = harness({
    available: [SAVED],
    reconcile: async () => { throw new Error('journal unavailable'); },
  });
  await assert.rejects(value.supervisor.ensure('boot'), (error) => (
    error.code === 'comfy_reconcile_failed'
      && error.details.cause === 'journal unavailable'
  ));
  assert.ok(value.states.some((state) => state.status === 'reconciling'));
  assert.equal(value.states.some((state) => state.status === 'connected'), false);
  assert.equal(value.supervisor.getState().status, 'attention');
});

test('adoption failures are typed and reconciliation is not attempted', async () => {
  const value = harness({
    available: [DRIFTED],
    discovered: [DRIFTED],
    adopt: async () => { throw new Error('settings read-only'); },
  });
  await assert.rejects(value.supervisor.ensure('reconnect'), (error) => (
    error.code === 'comfy_adopt_failed'
      && error.details.cause === 'settings read-only'
  ));
  assert.equal(value.events.some((entry) => entry.startsWith('reconcile:')), false);
  assert.equal(value.supervisor.getState().status, 'attention');
});

test('an explicitly configured local service is eligible for automatic start', async () => {
  const value = harness({
    launch: { canStart: true, kind: 'service', requiresUserAction: false },
    wait: async (ms, context, available) => { if (!context.backoff) available.add(SAVED); },
  });
  assert.equal((await value.supervisor.ensure()).ok, true);
  assert.deepEqual(value.events.filter((entry) => entry.startsWith('start:')), ['start:1']);
});

test('unrelated foreign listeners do not prevent starting the free canonical endpoint', async () => {
  const other = 'http://127.0.0.1:8000';
  const value = harness({
    available: [other],
    discovered: [other],
    attestations: [[other, foreign(other)]],
    wait: async (ms, context, available) => { if (!context.backoff) available.add(SAVED); },
  });
  const result = await value.supervisor.ensure();
  assert.equal(result.url, SAVED);
  assert.equal(result.launched, true);
});

test('early exits are retried with bounded backoff then surface a typed diagnostic', async () => {
  const value = harness({
    maxLaunchAttempts: 2,
    start: async ({ attempt }) => ({ exited: Promise.resolve({ code: attempt, signal: null }) }),
  });
  await assert.rejects(value.supervisor.ensure(), (error) => (
    error.code === 'comfy_start_early_exit'
      && error.details.attempt === 2
      && error.details.exit.code === 2
  ));
  assert.deepEqual(value.events.filter((entry) => entry.startsWith('start:')), ['start:1', 'start:2']);
  assert.equal(value.events.filter((entry) => entry.startsWith('backoff:')).length, 1);
  assert.ok(value.states.some((state) => state.code === 'comfy_start_early_exit' && state.status === 'backoff'));
  assert.equal(value.states.at(-1).status, 'attention');
});

test('readiness timeouts use the configured finite attempt and check budgets', async () => {
  const value = harness({ maxLaunchAttempts: 2, readinessChecksPerAttempt: 3 });
  await assert.rejects(value.supervisor.ensure(), { code: 'comfy_start_timeout' });
  assert.equal(value.events.filter((entry) => entry.startsWith('start:')).length, 2);
  assert.equal(value.events.filter((entry) => entry.startsWith('wait:')).length, 6);
  assert.equal(value.events.filter((entry) => entry.startsWith('backoff:')).length, 1);
});

test('repeated timeout-triggered ensures are cooled down and then open the failed-launch circuit', async () => {
  const value = harness({
    maxLaunchAttempts: 1,
    readinessChecksPerAttempt: 1,
    maxLaunchFailuresPerWindow: 2,
    recoveryWindowMs: 10_000,
    launchCooldownMs: 1_000,
    clock: 5_000,
  });

  await assert.rejects(value.supervisor.ensure('health_probe_failed'), (error) => (
    error.code === 'comfy_start_timeout'
      && error.details.launchAttempts === 1
      && error.details.launchFailures === 1
      && error.details.nextAllowedAt === 6_000
  ));
  await assert.rejects(value.supervisor.ensure('health_probe_failed'), (error) => (
    error.code === 'comfy_start_cooldown'
      && error.details.retryAfterMs === 1_000
  ));
  assert.deepEqual(value.events.filter((entry) => entry.startsWith('start:')), ['start:1']);

  value.advanceClock(1_000);
  await assert.rejects(value.supervisor.ensure('health_probe_failed'), (error) => (
    error.code === 'comfy_start_timeout'
      && error.details.launchAttempts === 2
      && error.details.launchFailures === 2
  ));
  await assert.rejects(value.supervisor.ensure('health_probe_failed'), (error) => (
    error.code === 'comfy_start_failure_circuit_open'
      && error.details.nextAllowedAt === 15_000
      && error.details.retryAfterMs === 9_000
  ));
  assert.deepEqual(value.events.filter((entry) => entry.startsWith('start:')), ['start:1', 'start:1']);
});

test('failed-launch circuit expires and permits one new bounded launch attempt', async () => {
  const value = harness({
    maxLaunchAttempts: 1,
    readinessChecksPerAttempt: 1,
    maxLaunchFailuresPerWindow: 1,
    recoveryWindowMs: 5_000,
    launchCooldownMs: 1_000,
    clock: 20_000,
  });

  await assert.rejects(value.supervisor.ensure('first_timeout'), { code: 'comfy_start_timeout' });
  await assert.rejects(value.supervisor.ensure('health_probe_failed'), {
    code: 'comfy_start_failure_circuit_open',
  });
  value.advanceClock(5_001);
  await assert.rejects(value.supervisor.ensure('after_window'), { code: 'comfy_start_timeout' });
  assert.equal(value.events.filter((entry) => entry.startsWith('start:')).length, 2);
});

test('a verified manual recovery clears the failed-launch streak', async () => {
  const value = harness({
    maxLaunchAttempts: 1,
    readinessChecksPerAttempt: 1,
    maxLaunchFailuresPerWindow: 1,
    recoveryWindowMs: 10_000,
    launchCooldownMs: 1_000,
    clock: 30_000,
  });

  await assert.rejects(value.supervisor.ensure('timeout'), { code: 'comfy_start_timeout' });
  value.available.add(SAVED);
  assert.equal((await value.supervisor.ensure('manual_start')).launched, false);
  value.available.delete(SAVED);
  await assert.rejects(value.supervisor.ensure('next_crash'), { code: 'comfy_start_timeout' });
  assert.equal(value.events.filter((entry) => entry.startsWith('start:')).length, 2);
});

test('repeated post-recovery deaths open the circuit before a third launch', async () => {
  const value = harness({
    maxLaunchAttempts: 1,
    maxRecoveriesPerWindow: 2,
    recoveryWindowMs: 60_000,
    wait: async (ms, context, available) => {
      if (!context.backoff) available.add(SAVED);
    },
  });
  assert.equal((await value.supervisor.ensure('first_crash')).launched, true);
  value.available.delete(SAVED);
  assert.equal((await value.supervisor.ensure('second_crash')).launched, true);
  value.available.delete(SAVED);
  await assert.rejects(value.supervisor.ensure('third_crash'), (error) => (
    error.code === 'comfy_recovery_circuit_open'
      && error.details.recoveries === 2
  ));
  assert.equal(value.events.filter((entry) => entry.startsWith('start:')).length, 2);
  assert.equal(value.supervisor.getState().status, 'attention');
});

test('unverifiable endpoints are never adopted and do not satisfy readiness', async () => {
  const value = harness({
    available: [DRIFTED],
    discovered: [DRIFTED],
    attestations: [[DRIFTED, { match: { status: 'unverifiable' } }]],
    maxLaunchAttempts: 1,
    readinessChecksPerAttempt: 1,
  });
  await assert.rejects(value.supervisor.ensure(), { code: 'comfy_start_timeout' });
  assert.equal(value.events.some((entry) => entry.startsWith('adopt:')), false);
});

test('configuration errors identify the missing injected callback', () => {
  assert.throws(() => createComfyAvailabilitySupervisor({}), (error) => (
    error.code === 'comfy_supervisor_configuration_invalid'
      && error.details.callback === 'probe'
  ));
});

test('state observers cannot interrupt availability recovery and state snapshots are detached', async () => {
  const value = harness({
    available: [SAVED],
    onState: () => { throw new Error('telemetry failed'); },
  });
  assert.equal((await value.supervisor.ensure()).ok, true);
  const snapshot = value.supervisor.getState();
  snapshot.details.changed = true;
  assert.equal(value.supervisor.getState().details.changed, undefined);
});
