'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  INCIDENT_PHASES,
  RECOVERY_OUTCOMES,
  createIncidentLedger,
  incidentPhaseForCode,
  normalizeIncident,
  parseLedger,
  sanitizeRuntimeFingerprint,
  supportBundle,
} = require('../lib/incident-ledger');

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const INSTALL_ID = 'a'.repeat(64);
const INSTANCE_ID = 'b'.repeat(64);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-incident-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('incident records require typed phases, codes, severity, and recovery outcomes', () => {
  assert.ok(INCIDENT_PHASES.includes('input_staging'));
  assert.ok(RECOVERY_OUTCOMES.includes('recovered'));
  assert.throws(
    () => normalizeIncident({ phase: 'somewhere', code: 'failed' }),
    { code: 'incident_phase_invalid' },
  );
  assert.throws(
    () => normalizeIncident({ phase: 'submission', code: 'User facing prose!' }),
    { code: 'incident_code_invalid' },
  );
  assert.throws(
    () => normalizeIncident({ phase: 'submission', code: 'comfy_offline', recoveryOutcome: 'maybe' }),
    { code: 'incident_recovery_outcome_invalid' },
  );
  assert.throws(
    () => normalizeIncident({ phase: 'submission', code: 'comfy_offline', severity: 'urgent' }),
    { code: 'incident_severity_invalid' },
  );
});

test('known error families map to stable incident phases', () => {
  assert.equal(incidentPhaseForCode('workflow_capability_mismatch'), 'readiness');
  assert.equal(incidentPhaseForCode('comfy_input_asset_missing'), 'input_staging');
  assert.equal(incidentPhaseForCode('gallery_finalization_conflict'), 'finalization');
  assert.equal(incidentPhaseForCode('comfy_connection_failed'), 'recovery');
  assert.equal(incidentPhaseForCode('runpod_capacity_unavailable'), 'provider');
  assert.equal(incidentPhaseForCode('sampler_execution_failed'), 'execution');
  assert.equal(incidentPhaseForCode('unknown', '/api/restart-comfy'), 'maintenance');
  assert.equal(incidentPhaseForCode('unknown', '/api/generate'), 'submission');
  assert.equal(incidentPhaseForCode('unknown', '/api/me'), 'request');
});

test('normalization keeps diagnostics but cannot retain prompts, image contents, messages, paths, or credentials', () => {
  const incident = normalizeIncident({
    phase: 'input_staging',
    code: 'comfy_input_asset_missing',
    severity: 'blocking',
    correlationId: CORRELATION_ID,
    recoveryOutcome: 'attention_required',
    prompt: 'PRIVATE PROMPT ROOT',
    image: Buffer.from('PRIVATE IMAGE ROOT'),
    context: {
      route: '/api/generate?prompt=PRIVATE_QUERY',
      method: 'POST',
      workflow: 'character_element',
      httpStatus: 409,
      retryCount: 2,
      prompt: 'PRIVATE PROMPT CONTEXT',
      imageData: 'PRIVATE IMAGE CONTEXT',
      filename: 'private-person-name.jpg',
      token: 'secret-token',
    },
    error: {
      name: 'Error',
      code: 'comfy_input_asset_missing',
      status: 409,
      retryable: true,
      message: 'PRIVATE PROMPT ERROR',
      stack: '/Users/private/Mix/server.js',
    },
    runtimeFingerprint: {
      installId: INSTALL_ID,
      instanceId: INSTANCE_ID,
      url: 'http://user:password@127.0.0.1:8197/input?token=secret',
      sourcePath: '/Users/private/Mix-ComfyUI',
      inputPath: '/Users/private/Mix-ComfyUI/input',
      argv: ['main.py', '--token', 'secret-token'],
      comfyVersion: '0.34.0',
    },
  }, {
    now: new Date('2026-09-02T20:00:00.000Z'),
    randomUUID: () => INCIDENT_ID,
  });

  assert.equal(incident.id, INCIDENT_ID);
  assert.equal(incident.correlationId, CORRELATION_ID);
  assert.deepEqual(incident.context, {
    httpStatus: 409,
    method: 'POST',
    retryCount: 2,
    route: '/api/generate',
    workflow: 'character_element',
  });
  assert.deepEqual(incident.error, {
    name: 'Error',
    code: 'comfy_input_asset_missing',
    status: 409,
    retryable: true,
  });
  assert.deepEqual(incident.runtimeFingerprint, {
    schemaVersion: 1,
    installId: INSTALL_ID,
    instanceId: INSTANCE_ID,
    comfyVersion: '0.34.0',
    mismatches: [],
    endpointKind: 'loopback',
    endpointPort: 8197,
  });
  const serialized = JSON.stringify(incident);
  for (const privateValue of ['PRIVATE', '/Users/private', 'secret-token', 'password', 'private-person-name.jpg']) {
    assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('runtime fingerprints hash a remote host and never export its URL or local paths', () => {
  const fingerprint = sanitizeRuntimeFingerprint({
    expected: { installId: INSTALL_ID, sourcePath: '/private/source' },
    observed: {
      instanceId: INSTANCE_ID,
      url: 'https://user:secret@generation.private.example:9443/api?token=private',
      pythonVersion: '3.13.2',
      argv: ['--input-directory', '/private/input'],
    },
    match: { status: 'remote', code: 'comfy_runtime_remote', mismatches: [] },
  });
  assert.equal(fingerprint.installId, INSTALL_ID);
  assert.equal(fingerprint.instanceId, INSTANCE_ID);
  assert.equal(fingerprint.endpointKind, 'remote');
  assert.equal(fingerprint.endpointPort, 9443);
  assert.match(fingerprint.endpointHostHash, /^[a-f0-9]{16}$/);
  const serialized = JSON.stringify(fingerprint);
  assert.doesNotMatch(serialized, /generation\.private|user|secret|\/private/);
});

test('the file ledger is private, bounded, reloadable, and tolerant of a corrupt line', (t) => {
  const directory = temporaryDirectory(t);
  const file = path.join(directory, 'incidents.jsonl');
  let sequence = 0;
  const ledger = createIncidentLedger({
    file,
    maxEntries: 2,
    now: () => new Date(`2026-09-02T20:00:0${sequence}.000Z`),
    randomUUID: () => `${String(++sequence).padStart(8, '0')}-1111-4111-8111-111111111111`,
  });
  ledger.record({ phase: 'request', code: 'first_failure', recoveryOutcome: 'failed' });
  ledger.record({ phase: 'submission', code: 'second_failure', recoveryOutcome: 'retrying' });
  ledger.record({ phase: 'recovery', code: 'third_recovered', severity: 'info', recoveryOutcome: 'recovered' });

  assert.deepEqual(ledger.list().entries.map((entry) => entry.code), ['second_failure', 'third_recovered']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.appendFileSync(file, '{not-json}\n');
  const reloaded = createIncidentLedger({ file, maxEntries: 2 });
  assert.equal(reloaded.list().discardedLines, 1);
  assert.deepEqual(reloaded.list().entries.map((entry) => entry.code), ['second_failure', 'third_recovered']);
});

test('support bundles summarize recovery and remain content-free by construction', () => {
  const source = [{
    phase: 'recovery', code: 'comfy_port_changed', severity: 'warning', recoveryOutcome: 'recovered',
    correlationId: INCIDENT_ID, prompt: 'PRIVATE PROMPT', imageData: 'PRIVATE IMAGE',
    context: { availabilityState: 'connected', retryCount: 1, prompt: 'PRIVATE CONTEXT' },
  }, {
    phase: 'submission', code: 'comfy_connection_failed', severity: 'blocking', recoveryOutcome: 'retrying',
    correlationId: CORRELATION_ID, error: { code: 'comfy_connection_failed', message: 'PRIVATE ERROR' },
  }];
  const bundle = supportBundle(source, {
    now: new Date('2026-09-02T20:10:00.000Z'),
    appVersion: '2.4.0',
    runtimeFingerprint: { installId: INSTALL_ID, url: 'http://127.0.0.1:8197/private' },
    diagnostics: {
      availabilityState: 'connected', queuePending: 3, queueRunning: 1,
      prompt: 'PRIVATE DIAGNOSTIC', image: 'PRIVATE IMAGE DIAGNOSTIC',
    },
  });

  assert.deepEqual(bundle.privacy, {
    promptsExcluded: true,
    imageContentsExcluded: true,
    mediaExcluded: true,
    localPathsExcluded: true,
    credentialsExcluded: true,
  });
  assert.deepEqual(bundle.summary, {
    total: 2,
    byCode: { comfy_port_changed: 1, comfy_connection_failed: 1 },
    byPhase: { recovery: 1, submission: 1 },
    byRecoveryOutcome: { recovered: 1, retrying: 1 },
  });
  assert.deepEqual(bundle.diagnostics, {
    availabilityState: 'connected', queuePending: 3, queueRunning: 1,
  });
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /PRIVATE|\/private/);
});

test('a schema-shaped line with an invalid timestamp cannot block a support export', () => {
  const bundle = supportBundle([{
    schemaVersion: 1,
    id: INCIDENT_ID,
    occurredAt: 'not-a-date',
    phase: 'request',
    code: 'request_failed',
    severity: 'blocking',
    correlationId: CORRELATION_ID,
    recoveryOutcome: 'failed',
  }], { now: new Date('2026-09-02T21:00:00.000Z') });
  assert.equal(bundle.incidents[0].occurredAt, '2026-09-02T21:00:00.000Z');
});

test('oversized and schema-invalid ledger lines are discarded from support exports', () => {
  const oversized = JSON.stringify({ prompt: 'x'.repeat(40 * 1024) });
  const valid = normalizeIncident({ phase: 'execution', code: 'sampler_failed', recoveryOutcome: 'failed' });
  const parsed = parseLedger(`${oversized}\n${JSON.stringify({ phase: 'unknown' })}\n${JSON.stringify(valid)}\n`);
  assert.equal(parsed.discardedLines, 2);
  assert.deepEqual(parsed.entries, [valid]);
});
