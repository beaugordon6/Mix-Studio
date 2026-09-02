'use strict';

const ELEMENT_TYPES = Object.freeze(['character', 'location', 'prop']);
const HANDLE_RE = /^[a-z](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const FULL_BODY_RE = /\b(?:full[- ]?(?:length|body)|head[- ]to[- ]toe|entire (?:body|figure)|both feet|feet (?:fully )?visible)\b/i;
const FULL_BODY_GROUNDING = 'Show the complete subject from head to toe, including both feet, with visible margin around the body; do not crop the head, limbs, or feet';

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function handleIsValid(value) {
  return HANDLE_RE.test(normalizeHandle(value));
}

function normalizeElement(value = {}, profileId = '') {
  const handle = normalizeHandle(value.handle);
  if (!handleIsValid(handle)) throw new Error('Handles start with a letter, end with a letter or number, and use lowercase letters, numbers, hyphens, or underscores.');
  const type = ELEMENT_TYPES.includes(value.type) ? value.type : 'prop';
  const assetNames = [...new Set((Array.isArray(value.assetNames) ? value.assetNames : [])
    .map((name) => String(name || '').trim()).filter(Boolean))].slice(0, 1);
  if (!assetNames.length) throw new Error('An element needs at least one image.');
  return {
    handle,
    type,
    label: String(value.label || handle.replace(/[-_]+/g, ' ')).trim().slice(0, 120) || handle,
    assetNames,
    profileId,
  };
}

function publicElement(element) {
  return {
    id: String(element.id || ''),
    handle: `@${normalizeHandle(element.handle)}`,
    type: ELEMENT_TYPES.includes(element.type) ? element.type : 'prop',
    label: String(element.label || normalizeHandle(element.handle)).slice(0, 120),
    assetNames: Array.isArray(element.assetNames) ? element.assetNames.slice(0, 12) : [],
    createdAt: Number(element.createdAt) || 0,
    updatedAt: Number(element.updatedAt) || 0,
  };
}

function mentionedHandles(prompt) {
  const seen = new Set();
  const result = [];
  const matches = String(prompt || '').matchAll(/(^|[^a-z0-9_-])@([a-z](?:[a-z0-9_-]{0,46}[a-z0-9])?)(?![a-z0-9_-])/gi);
  for (const match of matches) {
    const handle = normalizeHandle(match[2]);
    if (!seen.has(handle)) { seen.add(handle); result.push(handle); }
  }
  return result;
}

function resolvePromptElements(prompt, elements, profileId, maxReferences = 3) {
  const byHandle = new Map((elements || [])
    .filter((element) => element && element.profileId === profileId)
    .map((element) => [normalizeHandle(element.handle), element]));
  const mentions = mentionedHandles(prompt)
    .map((handle) => byHandle.get(handle)).filter(Boolean);
  const names = [];
  const seenNames = new Set();
  for (const element of mentions) {
    for (const name of element.assetNames || []) {
      if (!seenNames.has(name)) { seenNames.add(name); names.push(name); }
    }
  }
  const capacity = Math.max(1, Math.min(9, Math.round(Number(maxReferences) || 3)));
  return {
    elements: mentions,
    referenceNames: names.slice(0, capacity),
    overflowNames: names.slice(capacity),
  };
}

function replaceElementHandles(prompt, elements) {
  const labels = new Map((elements || []).map((element) => [normalizeHandle(element.handle), String(element.label || element.handle)]));
  return String(prompt || '').replace(/(^|[^a-z0-9_-])@([a-z](?:[a-z0-9_-]{0,46}[a-z0-9])?)(?![a-z0-9_-])/gi, (whole, prefix, raw) => {
    const label = labels.get(normalizeHandle(raw));
    return label ? `${prefix}${label}` : whole;
  });
}

function elementConditioningMode(elements, generationMode = 't2i') {
  if (generationMode === 't2i' || generationMode === 'edit') {
    if ((elements || []).some((element) => element?.type === 'character')) return 'identity';
    if ((elements || []).length) return 'remix';
  }
  return 'guide';
}

function groundElementPrompt(prompt, elements) {
  const resolved = replaceElementHandles(prompt, elements);
  const fullBodyRequested = FULL_BODY_RE.test(resolved);
  const instructions = (elements || []).map((element, index) => {
    const label = String(element.label || element.handle || 'the reference').trim();
    const picture = `Picture ${index + 1}`;
    if (element.type === 'character') {
      const framing = fullBodyRequested
        ? `. ${FULL_BODY_GROUNDING}`
        : '';
      return `Use the person in ${picture} as the exact appearance reference for ${label}. Preserve their face, hair, body proportions, skin details, and other distinctive traits${framing}`;
    }
    if (element.type === 'location') {
      return `Use the place in ${picture} as the exact visual reference for ${label}. Preserve its recognizable architecture, layout, materials, colors, and landmarks`;
    }
    return `Use the object in ${picture} as the exact visual reference for ${label}. Preserve its recognizable shape, proportions, materials, colors, and distinctive details`;
  });
  if (!instructions.length) return resolved;
  return `${instructions.join('. ')}. Follow this new composition and framing: ${resolved}`;
}

module.exports = {
  ELEMENT_TYPES,
  elementConditioningMode,
  groundElementPrompt,
  normalizeHandle,
  handleIsValid,
  normalizeElement,
  publicElement,
  mentionedHandles,
  resolvePromptElements,
  replaceElementHandles,
};
