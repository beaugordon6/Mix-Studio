'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const backlogPath = path.join(root, 'BACKLOG.md');
const agentsPath = path.join(root, 'AGENTS.md');

test('repository keeps the shared Mix Studio backlog and initial work items', () => {
  assert.equal(fs.existsSync(backlogPath), true, 'BACKLOG.md must remain version controlled');
  const backlog = fs.readFileSync(backlogPath, 'utf8');

  for (const status of ['Ready', 'Claimed', 'Blocked', 'Completed']) {
    assert.match(backlog, new RegExp(`\\b${status}\\b`));
  }
  for (const field of ['Priority:', 'Claimed by:', 'Claimed at:', 'Completed at:', 'Summary:', 'Requirements:', 'Acceptance:', 'Verification:', 'Notes:']) {
    assert.match(backlog, new RegExp(field));
  }
  assert.match(backlog, /MIX-001 — Automatic Krea 2 face repair/);
  assert.match(backlog, /MIX-002 — Upscale tile progress and ETA/);
  assert.match(backlog, /## Completed archive/);

  const ids = [...backlog.matchAll(/^### (MIX-\d{3}) —/gm)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'backlog item IDs must be unique and permanent');
});

test('agent handbook requires backlog claiming, handoff, and verified completion', () => {
  const agents = fs.readFileSync(agentsPath, 'utf8');

  assert.match(agents, /Backlog coordination — mandatory for every Codex task/);
  assert.match(agents, /must read it before making changes/);
  assert.match(agents, /before adding a duplicate/);
  assert.match(agents, /Before implementation, move the item to \*\*Claimed\*\*/);
  assert.match(agents, /Coordinate a handoff/);
  assert.match(agents, /Mark work \*\*Completed\*\* only after every acceptance criterion passes/);
  assert.match(agents, /record the exact verification commands and results/);
  assert.match(agents, /Never leave an abandoned claim/);
  assert.match(agents, /Claims older than 24 hours are not automatically available/);
  assert.match(agents, /Read-only questions and diagnostics must still consult the backlog/);
});
