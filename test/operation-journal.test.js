'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const {
  JOURNAL_VERSION,
  createOperationJournal,
} = require('../lib/operation-journal');

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mix-operation-journal-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'operations.json') };
}

function idFactory(values = IDS) {
  let index = 0;
  return () => values[index++];
}

function intent(overrides = {}) {
  return {
    profileId: 'owner',
    kind: 'gen',
    workflow: 'krea2-character-element',
    graph: { source: { class_type: 'LoadImage', inputs: { image: 'hermes.jpg' } } },
    request: { prompt: '@hermes in a studio', seed: 42 },
    assets: [{
      assetId: 'asset-hermes',
      logicalName: 'hermes.jpg',
      profileId: 'owner',
      kind: 'image',
      sha256: 'a'.repeat(64),
      bytes: 170505,
    }],
    ...overrides,
  };
}

test('prepare returns only after stable UUID intent is atomically durable', async (t) => {
  const { directory, file } = await fixture(t);
  const journal = createOperationJournal(file, { idFactory: idFactory(), clock: () => 100 });
  const operation = journal.prepare(intent());
  const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));

  assert.equal(operation.id, IDS[0]);
  assert.equal(operation.state, 'prepared');
  assert.equal(operation.revision, 1);
  assert.equal(operation.ordinal, 1);
  assert.equal(persisted.version, JOURNAL_VERSION);
  assert.deepEqual(persisted.operations[0], operation);
  assert.deepEqual((await fsp.readdir(directory)).sort(), ['operations.json']);
});

test('FIFO ordinals remain monotonic across reloads and terminal records', async (t) => {
  const { file } = await fixture(t);
  const first = createOperationJournal(file, { idFactory: idFactory(IDS.slice(0, 2)), clock: () => 10 });
  const one = first.prepare(intent());
  const two = first.prepare(intent({ request: { prompt: 'second' } }));
  first.transition(one.id, 'failed', { failure: { code: 'fixture' } });

  const reloaded = createOperationJournal(file, { idFactory: idFactory(IDS.slice(2)), clock: () => 20 });
  const three = reloaded.prepare(intent({ request: { prompt: 'third' } }));
  assert.deepEqual(reloaded.entries().map(([, operation]) => operation.ordinal), [1, 2, 3]);
  assert.deepEqual(reloaded.active().map((operation) => operation.id), [two.id, three.id]);
});

test('revision checks reject stale writers and invalid state transitions without changing disk', async (t) => {
  const { file } = await fixture(t);
  const journal = createOperationJournal(file, { idFactory: idFactory(), clock: () => 50 });
  const operation = journal.prepare(intent());
  const staged = journal.transition(operation.id, 'staging', {}, { expectedRevision: 1 });
  const before = await fsp.readFile(file, 'utf8');

  assert.equal(staged.revision, 2);
  assert.throws(
    () => journal.transition(operation.id, 'staged', {}, { expectedRevision: 1 }),
    { code: 'operation_revision_conflict' },
  );
  assert.throws(
    () => journal.transition(operation.id, 'finalized', {}, { expectedRevision: 2 }),
    { code: 'operation_transition_invalid' },
  );
  assert.equal(await fsp.readFile(file, 'utf8'), before);
});

test('submission attempt is persisted before acknowledgement and correlated to the stable operation UUID', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const journal = createOperationJournal(file, { idFactory: idFactory(), clock: () => now++ });
  const operation = journal.prepare(intent());
  const staged = journal.transition(operation.id, 'staged');
  const submitting = journal.beginSubmission(operation.id, {
    expectedRevision: staged.revision,
    runtimeEpoch: 'canonical-comfy:boot-7',
  });

  const interrupted = createOperationJournal(file).get(operation.id);
  assert.equal(interrupted.state, 'submitting');
  assert.equal(interrupted.submission.attempt, 1);
  assert.equal(interrupted.submission.attemptId, IDS[1]);
  assert.equal(interrupted.submission.comfyPromptId, operation.id);
  assert.equal(interrupted.submission.runtimeEpoch, 'canonical-comfy:boot-7');
  assert.equal(interrupted.submission.acknowledgedAt, null);

  const submitted = journal.markSubmitted(operation.id, {
    attemptId: IDS[1],
    expectedRevision: submitting.revision,
  });
  assert.equal(submitted.state, 'submitted');
  assert.ok(submitted.submission.acknowledgedAt >= submitting.submission.startedAt);
  assert.throws(() => journal.markSubmitted(operation.id, { attemptId: IDS[2] }), {
    code: 'operation_attempt_conflict',
  });
});

test('asset manifests are immutable, deduplicated, and profile scoped', async (t) => {
  const { file } = await fixture(t);
  const source = intent({
    assets: [
      intent().assets[0],
      { ...intent().assets[0], logicalName: 'renamed-copy.jpg' },
    ],
  });
  const journal = createOperationJournal(file, { idFactory: idFactory() });
  const operation = journal.prepare(source);
  assert.equal(operation.assets.length, 1, 'assetId is the durable deduplication identity');
  source.assets[0].logicalName = 'mutated.jpg';
  source.graph.source.inputs.image = 'mutated.jpg';
  assert.equal(journal.get(operation.id).assets[0].logicalName, 'hermes.jpg');
  assert.equal(journal.get(operation.id).graph.source.inputs.image, 'hermes.jpg');

  assert.throws(() => journal.prepare(intent({
    assets: [{ logicalName: 'private.jpg', profileId: 'other' }],
  })), { code: 'operation_asset_profile_mismatch' });
});

test('cancellation tombstone is durable, idempotent, and retained in cancelled state', async (t) => {
  const { file } = await fixture(t);
  let now = 500;
  const journal = createOperationJournal(file, { idFactory: idFactory(), clock: () => now++ });
  const operation = journal.prepare(intent());
  const requested = journal.requestCancellation(operation.id, { reason: 'No longer needed' });
  assert.equal(requested.state, 'cancel_requested');
  assert.deepEqual(requested.cancellation, { requestedAt: 502, reason: 'No longer needed' });
  assert.deepEqual(journal.requestCancellation(operation.id), requested, 'repeat request does not advance revision');

  const reloaded = createOperationJournal(file);
  const cancelling = reloaded.transition(operation.id, 'cancelling');
  const cancelled = reloaded.transition(operation.id, 'cancelled', {}, { expectedRevision: cancelling.revision });
  assert.deepEqual(cancelled.cancellation, requested.cancellation);
  assert.deepEqual(createOperationJournal(file).active(), []);
});

test('legacy prompt journal migrates without losing correlation, request, graph, assets, or cancellation', async (t) => {
  const { file } = await fixture(t);
  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    jobs: [
      {
        id: 'legacy-prompt-id',
        job: {
          kind: 'gen', profileId: 'owner', enqueuedAt: 123,
          params: { mode: 'edit', editEngine: 'krea2ref', prompt: '@hermes' },
          graph: { source: { class_type: 'LoadImage', inputs: { image: 'hermes.jpg' } } },
          refImageNames: ['hermes.jpg'], elementInputNames: ['hermes.jpg'],
        },
      },
      {
        id: IDS[4],
        job: {
          kind: 'loraHunt', profileId: 'owner', cancelRequested: true, cancelMessage: 'Stop',
          params: { mode: 't2i' }, graph: { save: { class_type: 'SaveImage', inputs: {} } },
        },
      },
    ],
  }));

  const journal = createOperationJournal(file, { idFactory: idFactory([IDS[0]]), clock: () => 999 });
  const [migrated, cancelled] = journal.entries().map(([, operation]) => operation);
  assert.equal(migrated.id, IDS[0]);
  assert.equal(migrated.legacyPromptId, 'legacy-prompt-id');
  assert.equal(migrated.submission.comfyPromptId, 'legacy-prompt-id');
  assert.equal(migrated.workflow, 'edit:krea2ref');
  assert.equal(migrated.request.prompt, '@hermes');
  assert.equal(migrated.assets.length, 1);
  assert.equal(cancelled.id, IDS[4], 'canonical legacy Comfy UUID remains the stable ID');
  assert.equal(cancelled.state, 'cancel_requested');
  assert.equal(cancelled.cancellation.reason, 'Stop');
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).version, JOURNAL_VERSION);
});

test('failed atomic replacement does not publish the operation in memory', async (t) => {
  const { file } = await fixture(t);
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); };
      return Reflect.get(target, property);
    },
  });
  const journal = createOperationJournal(file, { fs: failingFs, idFactory: idFactory() });
  assert.throws(() => journal.prepare(intent()), { code: 'operation_journal_write_failed' });
  assert.deepEqual(journal.entries(), []);
  await assert.rejects(fsp.access(file));
});

test('corrupt or unsupported journals fail closed instead of appearing empty', async (t) => {
  const { file } = await fixture(t);
  await fsp.writeFile(file, '{bad');
  assert.throws(() => createOperationJournal(file), { code: 'operation_journal_corrupt' });
  await fsp.writeFile(file, JSON.stringify({ version: 99, operations: [] }));
  assert.throws(() => createOperationJournal(file), { code: 'operation_journal_unsupported' });
});
