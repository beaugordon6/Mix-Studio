'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { elementConditioningMode, groundElementPrompt, handleIsValid, normalizeElement, resolvePromptElements, replaceElementHandles } = require('../lib/elements');

test('normalizes an element and keeps only safe visual assets', () => {
  const element = normalizeElement({ handle: '@Prop_Horns', type: 'prop', assetNames: ['horns.png', 'horns.png'] }, 'p1');
  assert.equal(element.handle, 'prop_horns');
  assert.deepEqual(element.assetNames, ['horns.png']);
});

test('handles cannot end in punctuation that makes prompt removal ambiguous', () => {
  assert.equal(handleIsValid('hero-'), false);
  assert.equal(handleIsValid('hero_'), false);
  assert.equal(handleIsValid('hero-2'), true);
});

test('resolves known @handles in prompt order without leaking another profile', () => {
  const found = resolvePromptElements('@horns beside @skin and @horns', [
    { profileId: 'p1', handle: 'horns', label: 'Horns', assetNames: ['h.png'] },
    { profileId: 'p1', handle: 'skin', label: 'Skin', assetNames: ['s.png', 'detail.png'] },
    { profileId: 'p2', handle: 'secret', label: 'Secret', assetNames: ['no.png'] },
  ], 'p1', 2);
  assert.deepEqual(found.referenceNames, ['h.png', 's.png']);
  assert.deepEqual(found.overflowNames, ['detail.png']);
  assert.equal(replaceElementHandles('@horns @missing', found.elements), 'Horns @missing');
});

test('Element types choose their architecture-native conditioning in Create and Edit', () => {
  assert.equal(elementConditioningMode([{ type: 'character' }], 't2i'), 'identity');
  assert.equal(elementConditioningMode([{ type: 'location' }], 't2i'), 'remix');
  assert.equal(elementConditioningMode([{ type: 'prop' }], 't2i'), 'remix');
  assert.equal(elementConditioningMode([{ type: 'character' }], 'edit'), 'identity');
  assert.equal(elementConditioningMode([{ type: 'location' }], 'edit'), 'remix');
  assert.equal(elementConditioningMode([{ type: 'prop' }], 'edit'), 'remix');
});

test('grounds character, location, and prop Elements with type-specific preservation instructions', () => {
  assert.match(groundElementPrompt('Show @hero at dusk', [{ handle: 'hero', label: 'Hero', type: 'character' }]), /Preserve their face, hair, body proportions/);
  assert.match(groundElementPrompt('@cabin at dusk', [{ handle: 'cabin', label: 'Cabin', type: 'location' }]), /Preserve its recognizable architecture, layout/);
  assert.match(groundElementPrompt('Hero holds @sword', [{ handle: 'sword', label: 'Sword', type: 'prop' }]), /Preserve its recognizable shape, proportions, materials/);
  assert.match(groundElementPrompt('Full body view of @hero', [{ handle: 'hero', label: 'Hero', type: 'character' }]), /complete subject from head to toe, including both feet/);
  assert.doesNotMatch(groundElementPrompt('Close portrait of @hero', [{ handle: 'hero', label: 'Hero', type: 'character' }]), /complete subject from head to toe/);
});
