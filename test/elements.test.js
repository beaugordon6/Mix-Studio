'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeElement, resolvePromptElements, replaceElementHandles } = require('../lib/elements');

test('normalizes an element and keeps only safe visual assets', () => {
  const element = normalizeElement({ handle: '@Prop_Horns', type: 'prop', assetNames: ['horns.png', 'horns.png'] }, 'p1');
  assert.equal(element.handle, 'prop_horns');
  assert.deepEqual(element.assetNames, ['horns.png']);
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
