'use strict';

const DEFAULTS = Object.freeze({
  maxLaunchAttempts: 2,
  readinessChecksPerAttempt: 20,
  readinessIntervalMs: 1000,
  backoffMs: [1000, 5000],
  maxRecoveriesPerWindow: 2,
  recoveryWindowMs: 10 * 60 * 1000,
  maxLaunchFailuresPerWindow: 2,
  launchCooldownMs: 60 * 1000,
});

function cleanUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    if (['0.0.0.0', '::', '[::]'].includes(parsed.hostname)) parsed.hostname = '127.0.0.1';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isLoopback(value) {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]']
      .includes(new URL(String(value || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function diagnostic(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = Number(details.status) || 503;
  error.details = Object.assign({}, details);
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matchStatus(attestation) {
  return String(attestation?.match?.status || attestation?.status || '').toLowerCase();
}

function discoveredCandidates(value) {
  const source = Array.isArray(value) ? value
    : (Array.isArray(value?.matches) ? value.matches
      : (Array.isArray(value?.candidates) ? value.candidates : (value?.url ? [value] : [])));
  return source.map((entry) => ({
    url: cleanUrl(typeof entry === 'string' ? entry : entry?.url),
    evidence: typeof entry === 'object' && entry ? clone(entry) : null,
  })).filter((entry) => entry.url);
}

function createComfyAvailabilitySupervisor(options = {}) {
  const required = ['probe', 'discover', 'attest', 'adopt', 'startStatus', 'start', 'wait', 'reconcile'];
  for (const name of required) {
    if (typeof options[name] !== 'function') {
      throw diagnostic('comfy_supervisor_configuration_invalid', `Comfy availability supervisor needs a ${name} callback.`, {
        callback: name,
        status: 500,
      });
    }
  }
  const getRuntime = typeof options.getRuntime === 'function' ? options.getRuntime : () => options.runtime || {};
  const getConfiguredUrl = typeof options.getConfiguredUrl === 'function'
    ? options.getConfiguredUrl
    : () => getRuntime()?.comfy?.url || '';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onState = typeof options.onState === 'function' ? options.onState : () => {};
  const maxLaunchAttempts = Math.max(1, Number(options.maxLaunchAttempts) || DEFAULTS.maxLaunchAttempts);
  const readinessChecksPerAttempt = Math.max(1,
    Number(options.readinessChecksPerAttempt) || DEFAULTS.readinessChecksPerAttempt);
  const readinessIntervalMs = Math.max(0,
    Number.isFinite(Number(options.readinessIntervalMs))
      ? Number(options.readinessIntervalMs) : DEFAULTS.readinessIntervalMs);
  const backoff = Array.isArray(options.backoffMs) && options.backoffMs.length
    ? options.backoffMs.map((value) => Math.max(0, Number(value) || 0))
    : DEFAULTS.backoffMs;
  const maxRecoveriesPerWindow = Math.max(1,
    Number(options.maxRecoveriesPerWindow) || DEFAULTS.maxRecoveriesPerWindow);
  const recoveryWindowMs = Math.max(1000,
    Number(options.recoveryWindowMs) || DEFAULTS.recoveryWindowMs);
  const maxLaunchFailuresPerWindow = Math.max(1,
    Number(options.maxLaunchFailuresPerWindow) || DEFAULTS.maxLaunchFailuresPerWindow);
  const launchCooldownMs = Math.max(1000,
    Number(options.launchCooldownMs) || DEFAULTS.launchCooldownMs);
  let revision = 0;
  let inFlight = null;
  let successfulRecoveries = [];
  let launchAttempts = [];
  let launchFailures = [];
  let nextAllowedAt = 0;
  let state = Object.freeze({
    status: 'idle',
    code: 'comfy_supervisor_idle',
    message: 'ComfyUI availability has not been checked.',
    reason: '',
    url: '',
    attempt: 0,
    launched: false,
    details: {},
    revision,
    updatedAt: now(),
  });

  function publish(status, patch = {}) {
    revision += 1;
    state = Object.freeze(Object.assign({}, state, patch, {
      status,
      revision,
      updatedAt: now(),
      details: Object.freeze(clone(patch.details || {})),
    }));
    // Observability must never be able to break recovery itself.
    try { onState(clone(state)); } catch {}
    return state;
  }

  function fail(code, message, details = {}) {
    const error = diagnostic(code, message, details);
    publish('attention', {
      code,
      message,
      url: cleanUrl(details.url),
      attempt: Number(details.attempt) || 0,
      details: Object.assign({}, details, { status: undefined }),
    });
    throw error;
  }

  function pruneLaunchHistory(timestamp = now()) {
    const cutoff = timestamp - recoveryWindowMs;
    launchAttempts = launchAttempts.filter((entry) => entry >= cutoff);
    launchFailures = launchFailures.filter((entry) => entry >= cutoff);
    if (nextAllowedAt <= timestamp) nextAllowedAt = 0;
    return timestamp;
  }

  function launchGuardDetails(timestamp = now()) {
    pruneLaunchHistory(timestamp);
    return {
      launchAttempts: launchAttempts.length,
      launchFailures: launchFailures.length,
      maxLaunchFailuresPerWindow,
      windowMs: recoveryWindowMs,
      nextAllowedAt: nextAllowedAt || null,
      retryAfterMs: nextAllowedAt ? Math.max(0, nextAllowedAt - timestamp) : 0,
    };
  }

  function recordLaunchAttempt(timestamp = now()) {
    pruneLaunchHistory(timestamp);
    launchAttempts.push(timestamp);
  }

  function recordLaunchFailure(timestamp = now()) {
    pruneLaunchHistory(timestamp);
    launchFailures.push(timestamp);
    nextAllowedAt = Math.max(nextAllowedAt, timestamp + launchCooldownMs);
  }

  function enforceLaunchGuard(url) {
    const timestamp = pruneLaunchHistory();
    if (launchFailures.length >= maxLaunchFailuresPerWindow) {
      nextAllowedAt = Math.max(nextAllowedAt, launchFailures[0] + recoveryWindowMs);
      fail('comfy_start_failure_circuit_open',
        'ComfyUI failed to start repeatedly. Mix Studio preserved the queue and paused automatic launch attempts.', {
          url,
          ...launchGuardDetails(timestamp),
          status: 503,
        });
    }
    if (nextAllowedAt > timestamp) {
      fail('comfy_start_cooldown',
        'ComfyUI did not start. Mix Studio preserved the queue and will wait before another automatic launch attempt.', {
          url,
          ...launchGuardDetails(timestamp),
          status: 503,
        });
    }
  }

  async function inspect(reason) {
    const runtime = getRuntime() || {};
    const configuredUrl = cleanUrl(getConfiguredUrl());
    if (!configuredUrl) {
      return { runtime, configuredUrl, verified: [], foreign: [], unverifiable: [], reachable: [] };
    }
    const remote = !isLoopback(configuredUrl);
    let found = [];
    if (!remote) {
      publish('discovering', {
        code: 'comfy_supervisor_discovering',
        message: 'Looking for the configured ComfyUI installation.',
        reason,
        url: configuredUrl,
      });
      try { found = discoveredCandidates(await options.discover({ runtime, configuredUrl, reason })); }
      catch { found = []; }
    }
    const candidates = [];
    const seen = new Set();
    for (const candidate of [{ url: configuredUrl, evidence: { source: 'configured' } }, ...found]) {
      if (!candidate.url || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
    const verified = [];
    const foreign = [];
    const unverifiable = [];
    const reachable = [];
    for (const candidate of candidates) {
      let available = false;
      try {
        const result = await options.probe(candidate.url, { runtime, configuredUrl, reason, evidence: candidate.evidence });
        available = result === true || result?.ok === true || result?.available === true;
      } catch { available = false; }
      if (!available) continue;
      reachable.push(candidate);
      let attestation;
      try {
        attestation = await options.attest(candidate.url, { runtime, configuredUrl, reason, evidence: candidate.evidence });
      } catch (error) {
        const status = matchStatus(error?.attestation);
        if (status === 'foreign') foreign.push({ ...candidate, attestation: error.attestation });
        else unverifiable.push({ ...candidate, error: String(error?.code || error?.message || error) });
        continue;
      }
      const status = matchStatus(attestation);
      if (status === 'verified' || (remote && candidate.url === configuredUrl && status === 'remote')) {
        verified.push({ ...candidate, attestation });
      } else if (status === 'foreign') foreign.push({ ...candidate, attestation });
      else unverifiable.push({ ...candidate, attestation });
    }
    return { runtime, configuredUrl, remote, verified, foreign, unverifiable, reachable };
  }

  async function connectInspected(inspection, context) {
    if (inspection.verified.length > 1) {
      fail('comfy_multiple_verified_instances',
        'More than one running ComfyUI matches the configured installation. Stop the extra instance before continuing.', {
          urls: inspection.verified.map((entry) => entry.url),
          attempt: context.attempt,
          status: 409,
        });
    }
    if (inspection.verified.length !== 1) return null;
    const selected = inspection.verified[0];
    if (selected.url !== inspection.configuredUrl) {
      // Attestation above is a hard precondition for endpoint adoption.
      try {
        await options.adopt(selected.url, {
          runtime: inspection.runtime,
          previousUrl: inspection.configuredUrl,
          attestation: selected.attestation,
          reason: context.reason,
        });
      } catch (error) {
        fail('comfy_adopt_failed', 'The verified ComfyUI endpoint could not be saved.', {
          url: selected.url,
          previousUrl: inspection.configuredUrl,
          cause: String(error?.message || error),
          attempt: context.attempt,
          status: 503,
        });
      }
    }
    publish('reconciling', {
      code: 'comfy_supervisor_reconciling',
      message: 'ComfyUI is connected. Reconciling preserved work.',
      reason: context.reason,
      url: selected.url,
      attempt: context.attempt,
      launched: context.launched,
      details: {},
    });
    try {
      await options.reconcile({
        runtime: inspection.runtime,
        url: selected.url,
        attestation: selected.attestation,
        reason: context.reason,
        launched: context.launched,
      });
    } catch (error) {
      fail('comfy_reconcile_failed', 'ComfyUI reconnected, but preserved work could not be reconciled.', {
        url: selected.url,
        cause: String(error?.message || error),
        attempt: context.attempt,
        status: 503,
      });
    }
    publish('connected', {
      code: context.launched ? 'comfy_supervisor_recovered' : 'comfy_supervisor_connected',
      message: context.launched ? 'ComfyUI restarted and reconnected.' : 'ComfyUI is connected.',
      reason: context.reason,
      url: selected.url,
      attempt: context.attempt,
      launched: context.launched,
      details: {},
    });
    if (context.launched) {
      const cutoff = now() - recoveryWindowMs;
      successfulRecoveries = successfulRecoveries.filter((timestamp) => timestamp >= cutoff);
      successfulRecoveries.push(now());
    }
    // Any verified healthy connection breaks a failed-launch streak, including
    // a service the user started manually while automatic recovery was paused.
    launchFailures = [];
    nextAllowedAt = 0;
    return Object.freeze({
      ok: true,
      url: selected.url,
      attestation: selected.attestation,
      launched: context.launched,
      attempt: context.attempt,
    });
  }

  function configuredForeign(inspection) {
    return inspection.foreign.find((entry) => entry.url === inspection.configuredUrl) || null;
  }

  function configuredUnverifiable(inspection) {
    return inspection.unverifiable.find((entry) => entry.url === inspection.configuredUrl) || null;
  }

  function rejectConfiguredCollision(inspection, attempt = 0) {
    const foreign = configuredForeign(inspection);
    if (foreign) {
      fail('comfy_runtime_mismatch',
        'The configured address is occupied by a different ComfyUI installation. Mix Studio did not adopt or start anything.', {
          url: inspection.configuredUrl,
          attempt,
          mismatches: foreign.attestation?.match?.mismatches || [],
          status: 409,
        });
    }
    const unverifiable = configuredUnverifiable(inspection);
    if (unverifiable) {
      fail('comfy_runtime_unverifiable',
        'The configured address is occupied, but Mix Studio could not verify which ComfyUI installation is running.', {
          url: inspection.configuredUrl,
          attempt,
          attestation: unverifiable.attestation || null,
          cause: unverifiable.error || '',
          status: 409,
        });
    }
  }

  function launchPolicy(inspection) {
    if (inspection.remote) return { allowed: false, code: 'comfy_remote_unreachable' };
    const status = options.startStatus(inspection.runtime) || {};
    if (status.requiresUserAction || status.kind === 'desktop') {
      return { allowed: false, code: 'comfy_desktop_user_action_required', status };
    }
    if (!status.canStart || !['python', 'service'].includes(String(status.kind || ''))) {
      return { allowed: false, code: 'comfy_start_unavailable', status };
    }
    return { allowed: true, status };
  }

  function exitSignal(started) {
    const promise = started?.exited || started?.exit;
    if (!promise || typeof promise.then !== 'function') return null;
    return Promise.resolve(promise).then(
      (value) => ({ type: 'exit', value: value || {} }),
      (error) => ({ type: 'exit', value: { error: String(error?.message || error) } }),
    );
  }

  async function run(reason) {
    publish('checking', {
      code: 'comfy_supervisor_checking',
      message: 'Checking ComfyUI availability.',
      reason,
      url: cleanUrl(getConfiguredUrl()),
      attempt: 0,
      launched: false,
      details: {},
    });
    let inspection = await inspect(reason);
    let connected = await connectInspected(inspection, { reason, attempt: 0, launched: false });
    if (connected) return connected;
    rejectConfiguredCollision(inspection);
    const policy = launchPolicy(inspection);
    if (!policy.allowed) {
      const messages = {
        comfy_remote_unreachable: 'The configured remote ComfyUI is unavailable. Mix Studio will not start a local replacement.',
        comfy_desktop_user_action_required: 'This ComfyUI is managed by Comfy Desktop and requires user action to start.',
        comfy_start_unavailable: 'The configured ComfyUI cannot be started automatically.',
      };
      fail(policy.code, messages[policy.code], {
        url: inspection.configuredUrl,
        kind: policy.status?.kind || '',
        reason: policy.status?.reason || '',
        status: policy.code === 'comfy_remote_unreachable' ? 503 : 409,
      });
    }

    const recoveryCutoff = now() - recoveryWindowMs;
    successfulRecoveries = successfulRecoveries.filter((timestamp) => timestamp >= recoveryCutoff);
    if (successfulRecoveries.length >= maxRecoveriesPerWindow) {
      fail('comfy_recovery_circuit_open',
        'ComfyUI stopped repeatedly after recovery. Mix Studio preserved the queue and stopped restarting it automatically.', {
          url: inspection.configuredUrl,
          recoveries: successfulRecoveries.length,
          windowMs: recoveryWindowMs,
          status: 503,
      });
    }
    enforceLaunchGuard(inspection.configuredUrl);

    let lastExit = null;
    for (let attempt = 1; attempt <= maxLaunchAttempts; attempt += 1) {
      lastExit = null;
      recordLaunchAttempt();
      publish('starting', {
        code: 'comfy_supervisor_starting',
        message: 'Starting the configured ComfyUI installation.',
        reason,
        url: inspection.configuredUrl,
        attempt,
        launched: true,
        details: { kind: policy.status.kind },
      });
      let started;
      try {
        started = await options.start({
          runtime: inspection.runtime,
          configuredUrl: inspection.configuredUrl,
          launch: policy.status,
          attempt,
          reason,
        });
      } catch (error) {
        lastExit = { error: String(error?.message || error), code: error?.code || '' };
      }
      const exited = exitSignal(started);
      let earlyExit = !!lastExit;
      for (let check = 1; !earlyExit && check <= readinessChecksPerAttempt; check += 1) {
        publish('waiting', {
          code: 'comfy_supervisor_waiting',
          message: 'Waiting for the configured ComfyUI installation to become ready.',
          reason,
          url: inspection.configuredUrl,
          attempt,
          launched: true,
          details: { check, checks: readinessChecksPerAttempt },
        });
        const waited = exited
          ? await Promise.race([
            exited,
            Promise.resolve(options.wait(readinessIntervalMs, { attempt, check, reason })).then(() => ({ type: 'wait' })),
          ])
          : (await options.wait(readinessIntervalMs, { attempt, check, reason }), { type: 'wait' });
        if (waited.type === 'exit') {
          lastExit = clone(waited.value || {});
          earlyExit = true;
          break;
        }
        inspection = await inspect(reason);
        connected = await connectInspected(inspection, { reason, attempt, launched: true });
        if (connected) return connected;
        rejectConfiguredCollision(inspection, attempt);
      }
      recordLaunchFailure();
      if (attempt < maxLaunchAttempts) {
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
        publish('backoff', {
          code: earlyExit ? 'comfy_start_early_exit' : 'comfy_start_timeout',
          message: earlyExit
            ? 'ComfyUI exited before it became ready. Mix Studio will retry after a short delay.'
            : 'ComfyUI did not become ready yet. Mix Studio will retry after a short delay.',
          reason,
          url: inspection.configuredUrl,
          attempt,
          launched: true,
          details: earlyExit ? { exit: lastExit, delayMs: delay } : { delayMs: delay },
        });
        await options.wait(delay, { attempt, backoff: true, reason });
        inspection = await inspect(reason);
        connected = await connectInspected(inspection, { reason, attempt, launched: true });
        if (connected) return connected;
      } else if (earlyExit) {
        fail('comfy_start_early_exit',
          'The configured ComfyUI exited before it became ready.', {
            url: inspection.configuredUrl,
            attempt,
            exit: lastExit,
            ...launchGuardDetails(),
            status: 503,
          });
      }
    }
    fail('comfy_start_timeout',
      'The configured ComfyUI did not become ready after bounded startup attempts.', {
        url: inspection.configuredUrl,
        attempt: maxLaunchAttempts,
        ...launchGuardDetails(),
        status: 503,
      });
  }

  function ensure(reason = 'availability_check') {
    if (inFlight) return inFlight;
    inFlight = run(String(reason || 'availability_check'))
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return Object.freeze({
    ensure,
    getState: () => clone(state),
    isRunning: () => inFlight !== null,
  });
}

module.exports = {
  DEFAULTS,
  cleanUrl,
  createComfyAvailabilitySupervisor,
  diagnostic,
  discoveredCandidates,
  isLoopback,
};
