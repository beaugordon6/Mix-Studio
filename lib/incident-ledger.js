'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INCIDENT_SCHEMA_VERSION = 1;
const SUPPORT_BUNDLE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 2_000;
const MAX_LINE_BYTES = 32 * 1024;

const INCIDENT_PHASES = Object.freeze([
  'request',
  'readiness',
  'input_staging',
  'submission',
  'execution',
  'finalization',
  'recovery',
  'maintenance',
  'provider',
]);

const RECOVERY_OUTCOMES = Object.freeze([
  'not_attempted',
  'pending',
  'retrying',
  'recovered',
  'attention_required',
  'failed',
]);

const SEVERITIES = Object.freeze(['info', 'warning', 'blocking']);
const SAFE_CONTEXT_FIELDS = Object.freeze(new Set([
  'availabilityState',
  'dependencyId',
  'durationMs',
  'httpStatus',
  'jobState',
  'method',
  'nodeType',
  'provider',
  'queuePending',
  'queueRunning',
  'retryCount',
  'route',
  'workflow',
]));

function cleanToken(value, fallback = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{1,95}$/.test(text) ? text : fallback;
}

function cleanIdentifier(value, maxLength = 128) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text.slice(0, maxLength) : '';
}

function cleanOpaqueIdentifier(value) {
  const text = String(value || '').trim();
  if (/^[a-f0-9]{16,128}$/i.test(text)) return text;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(text)) return text;
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) return text;
  return '';
}

function finiteInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function validDate(value, fallback = Date.now()) {
  const candidate = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? fallback);
  return Number.isFinite(candidate.getTime()) ? candidate : new Date(fallback);
}

function endpointSummary(value) {
  const text = String(value || '').trim();
  if (!text) return {};
  try {
    const parsed = new URL(text);
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
    return {
      endpointKind: local ? 'loopback' : 'remote',
      endpointPort: finiteInteger(parsed.port || (parsed.protocol === 'https:' ? 443 : 80), 1, 65535),
      ...(local ? {} : {
        endpointHostHash: crypto.createHash('sha256').update(parsed.hostname.toLowerCase()).digest('hex').slice(0, 16),
      }),
    };
  } catch {
    return {};
  }
}

/**
 * Reduce runtime identity to opaque IDs and compatibility facts. Local paths,
 * process argv, URLs, usernames, tokens, and hardware labels are intentionally
 * not part of the returned schema.
 */
function sanitizeRuntimeFingerprint(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const expected = source.expected && typeof source.expected === 'object' ? source.expected : {};
  const observed = source.observed && typeof source.observed === 'object' ? source.observed : {};
  const match = source.match && typeof source.match === 'object' ? source.match : {};
  const value = {
    schemaVersion: finiteInteger(source.schemaVersion || observed.schemaVersion || expected.schemaVersion, 1, 100) || 1,
    installId: cleanOpaqueIdentifier(source.installId || expected.installId) || null,
    instanceId: cleanOpaqueIdentifier(source.instanceId || observed.instanceId) || null,
    processId: finiteInteger(source.processId || source.pid || observed.pid, 1, 0x7fffffff),
    comfyVersion: cleanIdentifier(source.comfyVersion || observed.comfyVersion, 64) || null,
    pythonVersion: cleanIdentifier(source.pythonVersion || observed.pythonVersion, 64) || null,
    pytorchVersion: cleanIdentifier(source.pytorchVersion || observed.pytorchVersion, 64) || null,
    matchStatus: cleanToken(source.matchStatus || match.status) || null,
    matchCode: cleanToken(source.matchCode || match.code) || null,
    mismatches: Array.isArray(source.mismatches || match.mismatches)
      ? [...new Set((source.mismatches || match.mismatches).map((entry) => cleanToken(entry)).filter(Boolean))].slice(0, 12)
      : [],
    ...endpointSummary(source.endpoint || source.url || observed.url),
  };
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function sanitizeContext(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const result = {};
  for (const key of SAFE_CONTEXT_FIELDS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (['durationMs', 'httpStatus', 'queuePending', 'queueRunning', 'retryCount'].includes(key)) {
      const number = finiteInteger(value, 0, 0x7fffffff);
      if (number !== null) result[key] = number;
      continue;
    }
    const text = key === 'route'
      ? String(value || '').split('?')[0].slice(0, 160)
      : cleanIdentifier(value, 96);
    if (text) result[key] = text;
  }
  return result;
}

function sanitizeError(error = {}) {
  if (!error || typeof error !== 'object') return null;
  const value = {
    name: cleanIdentifier(error.name, 64) || null,
    code: cleanToken(error.code) || null,
    status: finiteInteger(error.status || error.statusCode, 100, 599),
    retryable: typeof error.retryable === 'boolean' ? error.retryable : null,
  };
  const sanitized = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
  return Object.keys(sanitized).length ? sanitized : null;
}

function incidentPhaseForCode(value, route = '') {
  const code = cleanToken(value, 'unclassified_server_error');
  const pathname = String(route || '').split('?')[0].toLowerCase();
  if (/(?:dependency|capability|compatib|model|node|install)/.test(code)) return 'readiness';
  if (/(?:input|upload|asset|reference|element)/.test(code)) return 'input_staging';
  if (/(?:finaliz|gallery|catalog|output)/.test(code)) return 'finalization';
  if (/(?:recovery|recover|reconcile|runtime|connection|unreachable|supervisor|comfy_start|queue_reorder)/.test(code)) return 'recovery';
  if (/(?:provider|cloud|runpod|r2_|capacity|prompt_ai)/.test(code)) return 'provider';
  if (/(?:execution|sampler|decode|encode)/.test(code)) return 'execution';
  if (/(?:restart|update|setup|maintenance)/.test(code)
    || /\/api\/(?:update|restart|setup|dependencies)/.test(pathname)) return 'maintenance';
  if (/(?:prompt|submission|submit)/.test(code) || /\/api\/(?:generate|animate|upscale|composite)/.test(pathname)) {
    return 'submission';
  }
  return 'request';
}

function normalizeIncident(source, options = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw Object.assign(new TypeError('Incident must be an object.'), { code: 'incident_invalid' });
  }
  const phase = cleanToken(source.phase);
  const code = cleanToken(source.code);
  const recoveryOutcome = cleanToken(source.recoveryOutcome || 'not_attempted');
  const severity = cleanToken(source.severity || 'blocking');
  if (!INCIDENT_PHASES.includes(phase)) {
    throw Object.assign(new TypeError(`Unknown incident phase: ${String(source.phase || '')}.`), { code: 'incident_phase_invalid' });
  }
  if (!code) {
    throw Object.assign(new TypeError('Incident code must be a stable snake_case identifier.'), { code: 'incident_code_invalid' });
  }
  if (!RECOVERY_OUTCOMES.includes(recoveryOutcome)) {
    throw Object.assign(new TypeError(`Unknown recovery outcome: ${String(source.recoveryOutcome || '')}.`), { code: 'incident_recovery_outcome_invalid' });
  }
  if (!SEVERITIES.includes(severity)) {
    throw Object.assign(new TypeError(`Unknown incident severity: ${String(source.severity || '')}.`), { code: 'incident_severity_invalid' });
  }
  const now = validDate(options.now);
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const generatedId = () => cleanOpaqueIdentifier(randomUUID()) || crypto.randomUUID();
  const incident = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    id: cleanOpaqueIdentifier(source.id) || generatedId(),
    occurredAt: now.toISOString(),
    phase,
    code,
    severity,
    correlationId: cleanOpaqueIdentifier(source.correlationId) || generatedId(),
    recoveryOutcome,
    runtimeFingerprint: sanitizeRuntimeFingerprint(source.runtimeFingerprint),
    context: sanitizeContext(source.context),
    error: sanitizeError(source.error),
  };
  return Object.fromEntries(Object.entries(incident).filter(([, value]) => value !== null));
}

function parseLedger(text) {
  const entries = [];
  let discardedLines = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      discardedLines += 1;
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (value?.schemaVersion !== INCIDENT_SCHEMA_VERSION || !INCIDENT_PHASES.includes(value.phase)
        || !cleanToken(value.code) || !RECOVERY_OUTCOMES.includes(value.recoveryOutcome)) {
        discardedLines += 1;
      } else {
        entries.push(value);
      }
    } catch {
      discardedLines += 1;
    }
  }
  return { entries, discardedLines };
}

function readLedger(file) {
  try {
    return parseLedger(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], discardedLines: 0 };
    const wrapped = new Error(`The local incident ledger could not be read: ${error.message}`);
    wrapped.code = 'incident_ledger_read_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

function atomicWriteLedger(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    const body = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '';
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* ACL-backed platforms may not support chmod. */ }
    try {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* Windows and some filesystems do not permit directory fsync. */ }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    const wrapped = new Error(`The local incident ledger could not be saved: ${error.message}`);
    wrapped.code = 'incident_ledger_write_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

function incidentSummary(entries) {
  const byCode = {};
  const byPhase = {};
  const byRecoveryOutcome = {};
  for (const entry of entries) {
    byCode[entry.code] = (byCode[entry.code] || 0) + 1;
    byPhase[entry.phase] = (byPhase[entry.phase] || 0) + 1;
    byRecoveryOutcome[entry.recoveryOutcome] = (byRecoveryOutcome[entry.recoveryOutcome] || 0) + 1;
  }
  return { total: entries.length, byCode, byPhase, byRecoveryOutcome };
}

function supportBundle(entries, options = {}) {
  const now = validDate(options.now);
  const safeEntries = entries.map((entry) => normalizeIncident(entry, {
    now: validDate(entry.occurredAt, now),
    randomUUID: () => cleanOpaqueIdentifier(entry.id) || crypto.randomUUID(),
  }));
  return {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    privacy: {
      promptsExcluded: true,
      imageContentsExcluded: true,
      mediaExcluded: true,
      localPathsExcluded: true,
      credentialsExcluded: true,
    },
    app: {
      version: cleanIdentifier(options.appVersion, 64) || null,
      platform: cleanIdentifier(options.platform || process.platform, 32) || null,
      nodeVersion: cleanIdentifier(options.nodeVersion || process.version, 32) || null,
    },
    runtimeFingerprint: sanitizeRuntimeFingerprint(options.runtimeFingerprint),
    diagnostics: sanitizeContext(options.diagnostics),
    summary: incidentSummary(safeEntries),
    incidents: safeEntries,
  };
}

function createIncidentLedger(options = {}) {
  const file = path.resolve(String(options.file || ''));
  const maxEntries = finiteInteger(options.maxEntries || DEFAULT_MAX_ENTRIES, 1, 100_000) || DEFAULT_MAX_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomUUID = options.randomUUID || crypto.randomUUID;

  return Object.freeze({
    file,
    record(source) {
      const incident = normalizeIncident(source, { now: now(), randomUUID });
      const current = readLedger(file).entries;
      current.push(incident);
      atomicWriteLedger(file, current.slice(-maxEntries));
      return incident;
    },
    list(query = {}) {
      const parsed = readLedger(file);
      const limit = finiteInteger(query.limit || maxEntries, 1, maxEntries) || maxEntries;
      return {
        entries: parsed.entries.slice(-limit),
        discardedLines: parsed.discardedLines,
      };
    },
    exportSupportBundle(bundleOptions = {}) {
      const parsed = readLedger(file);
      return supportBundle(parsed.entries.slice(-maxEntries), {
        ...bundleOptions,
        now: now(),
      });
    },
  });
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  INCIDENT_PHASES,
  INCIDENT_SCHEMA_VERSION,
  RECOVERY_OUTCOMES,
  SEVERITIES,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  createIncidentLedger,
  incidentPhaseForCode,
  incidentSummary,
  normalizeIncident,
  parseLedger,
  sanitizeContext,
  sanitizeRuntimeFingerprint,
  supportBundle,
};
