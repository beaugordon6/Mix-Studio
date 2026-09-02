'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  assert.match(app, /function removePromptElement\(handle\)/);
  assert.match(app, /function makePromptElementToken\(element, authoredHandle\)/);
  assert.match(app, /function insertPromptElement\(element, preferredRange = null\)/);
  assert.match(app, /insertPromptElement\(element\)/);
  assert.match(app, /remove\.dataset\.removePromptElement = element\.handle/);
  assert.match(app, /el\.classList\.contains\('prompt-element-token'\)/);
  assert.match(app, /\[data-remove-prompt-element\]/);
  assert.match(app, /openElementEditor\(\{ element, trigger: edit \}\)/);
  assert.match(app, /state\.view !== 'video' \|\| h3ReferenceModeActive\(\)/);
  assert.match(app, /new RegExp\(pattern, 'g'\)/);
  assert.match(app, /function caseInsensitivePromptPattern\(value\)/);
  assert.match(app, /Type a different @name/);
  assert.match(app, /Remove all \$\{element\.handle\} mentions from prompt/);
  assert.match(app, /if \(promptMentionsElement\(element\.handle\)\) return removePromptElement\(element\.handle\)/);
  assert.match(app, /button\.disabled = !!elementMode/);
  assert.match(app, /activeElements\.find\(\(element\) => element\.type === 'character'\) \|\| activeElements\[0\]/);
  assert.match(app, /HomoFidelis Krea 2/);
  assert.match(app, /models\?\.krea2Elements\?\.unet/);
  assert.match(app, /Save as Element/);
  assert.match(app, /function refreshElementsUi\(\{ forceComposer = false \} = \{\}\)/);
  assert.match(app, /refreshElementsUi\(\{ forceComposer: true \}\)/);
  assert.match(css, /\.prompt-element-chip\.is-mentioned/);
  assert.match(css, /\.prompt-element-remove/);
  assert.match(css, /\.prompt-element-edit/);
  assert.match(css, /\.prompt-element-token/);
  assert.match(css, /\.element-image-picker img[^}]*object-fit:\s*contain/);
  assert.match(css, /\.krea-model-switch\.is-element-model:disabled/);
});

test('Element APIs are profile scoped and generation resolves known handles', () => {
  assert.match(server, /route === '\/api\/elements'/);
  assert.match(server, /entry\.profileId === req\.profile\.id/);
  assert.match(server, /resolvePromptElements\(p\.prompt, db\.elements, req\.profile\.id/);
  assert.match(server, /if \(p\.mode !== 'edit' && p\.elementIdentityMode\) return buildEditKrea2Identity\(p, refNames\)/);
  assert.match(server, /if \(p\.mode !== 'edit' && p\.elementReferenceMode\) return buildEditKrea2Remix\(p, refNames\)/);
  assert.match(server, /p\.elementIdentityMode = elementMode === 'identity'/);
  assert.match(server, /p\.editEngine = elementMode === 'identity' \? 'krea2ref' : 'krea2remix'/);
  assert.match(server, /elementsUsed: Array\.isArray\(job\.params\.elementsUsed\)/);
  assert.match(server, /elementModel: job\.params\.elementModel \|\| undefined/);
  assert.match(server, /p\.elementModel = elementMode === 'identity' \? settings\.krea2ElementUnet : settings\.unet/);
  assert.match(server, /p\.editAspectOverride = true/);
  assert.match(server, /groundElementPrompt\(p\.prompt, promptElements\.elements\)/);
  assert.match(server, /p\.authoredPrompt = p\.prompt/);
  assert.match(server, /prompt: job\.params\.authoredPrompt \|\| job\.params\.prompt/);
  assert.match(server, /inputAssetPath\(INPUTS, name\)/);
});

test('active Element removal deletes the handle from the authored prompt and persists it', () => {
  const source = app.slice(app.indexOf('function removePromptElement(handle)'), app.indexOf('function renderPromptElements()'));
  let prompt = 'Portrait of @hermes-full-body in @cabin.';
  let saved = false;
  const context = {
    promptDraft: () => prompt,
    setPromptDraft: (value) => { prompt = value; },
    state: { view: 'create', prompts: {} },
    saveForm: () => { saved = true; },
    $: () => ({ focus() {} }),
  };
  vm.runInNewContext(`${source}; globalThis.remove = removePromptElement;`, context);
  context.remove('@hermes-full-body');
  assert.equal(prompt, 'Portrait of in @cabin.');
  assert.equal(context.state.prompts.create, prompt);
  assert.equal(saved, true);
});

test('interrupted Comfy jobs are reconciled instead of remaining stuck', () => {
  assert.match(server, /missingFromComfyAt/);
  assert.match(server, /requeueMissingDurableJob/);
  assert.match(server, /Recovering generation after ComfyUI restart/);
  assert.match(app, /jobRequeued/);
});
