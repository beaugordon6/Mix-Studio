'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Elements are available beside the prompt with a one-screen editor', () => {
  assert.match(html, /id="promptElementList"/);
  assert.match(html, /id="elementForm"/);
  assert.match(html, /data-element-type="character"/);
  assert.match(app, /function renderPromptElements\(\)/);
  assert.match(app, /Save as Element/);
  assert.match(css, /\.prompt-element-chip\.is-mentioned/);
  assert.match(css, /\.element-image-picker img[^}]*object-fit:\s*contain/);
});

test('Element APIs are profile scoped and generation resolves known handles', () => {
  assert.match(server, /route === '\/api\/elements'/);
  assert.match(server, /entry\.profileId === req\.profile\.id/);
  assert.match(server, /resolvePromptElements\(p\.prompt, db\.elements, req\.profile\.id/);
  assert.match(server, /p\.authoredPrompt = p\.prompt/);
  assert.match(server, /prompt: job\.params\.authoredPrompt \|\| job\.params\.prompt/);
});

test('interrupted Comfy jobs are reconciled instead of remaining stuck', () => {
  assert.match(server, /missingFromComfyAt/);
  assert.match(server, /requeueMissingDurableJob/);
  assert.match(server, /Recovering generation after ComfyUI restart/);
  assert.match(app, /jobRequeued/);
});
