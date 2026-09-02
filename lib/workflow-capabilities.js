'use strict';

const WORKFLOW_CONTRACTS = Object.freeze({
  'create.krea2.element-character@1': Object.freeze({
    classes: Object.freeze({
      UNETLoader: { schemaInputs: ['unet_name', 'weight_dtype'], graphInputs: ['unet_name'] },
      CLIPLoader: { schemaInputs: ['clip_name', 'type'], graphInputs: ['clip_name', 'type'] },
      VAELoader: { schemaInputs: ['vae_name'], graphInputs: ['vae_name'] },
      LoraLoaderModelOnly: { schemaInputs: ['model', 'lora_name', 'strength_model'], graphInputs: ['model', 'lora_name'] },
      Krea2EditModelPatch: {
        schemaInputs: ['model', 'source_latent', 'source_image', 'vae', 'fit_mode', 'ref_boost'],
        graphInputs: ['model', 'source_latent', 'source_image', 'vae', 'fit_mode'],
        outputs: ['MODEL'],
      },
      Krea2EditGroundedEncode: {
        schemaInputs: ['clip', 'prompt', 'image', 'grounding_px'],
        graphInputs: ['clip', 'prompt', 'image', 'grounding_px'],
        outputs: ['CONDITIONING'],
      },
    }),
  }),
  'create.krea2.element-remix@1': Object.freeze({
    classes: Object.freeze({
      UNETLoader: { schemaInputs: ['unet_name', 'weight_dtype'], graphInputs: ['unet_name'] },
      CLIPLoader: { schemaInputs: ['clip_name', 'type'], graphInputs: ['clip_name', 'type'] },
      VAELoader: { schemaInputs: ['vae_name'], graphInputs: ['vae_name'] },
      Krea2EditRebalance: {
        schemaInputs: ['text', 'clip', 'steering', 'layer_multiplier', 'enable_step', 'image1'],
        graphInputs: ['text', 'clip', 'steering', 'layer_multiplier', 'enable_step', 'image1'],
        outputs: ['CONDITIONING'],
      },
    }),
  }),
});

function nodeInputDefinitions(definition = {}) {
  return Object.assign({}, definition.input?.required, definition.input?.optional, definition.input?.hidden);
}

function comboChoices(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  return spec[0] === 'COMBO' && Array.isArray(spec[1]?.options) ? spec[1].options.map(String) : [];
}

function validateWorkflowCapability(workflowId, graph, objectInfo) {
  const contract = WORKFLOW_CONTRACTS[workflowId];
  if (!contract) return { ok: false, workflowId, errors: [{ code: 'unknown_contract', detail: workflowId }] };
  const errors = [];
  for (const [className, requirement] of Object.entries(contract.classes)) {
    const definition = objectInfo?.[className];
    if (!definition) {
      errors.push({ code: 'missing_node', className });
      continue;
    }
    const schemaInputs = nodeInputDefinitions(definition);
    for (const input of requirement.schemaInputs || []) {
      if (!Object.hasOwn(schemaInputs, input)) errors.push({ code: 'missing_schema_input', className, input });
    }
    for (const output of requirement.outputs || []) {
      if (!(definition.output || []).includes(output)) errors.push({ code: 'missing_schema_output', className, output });
    }
    const graphNodes = Object.entries(graph || {}).filter(([, node]) => node?.class_type === className);
    if (!graphNodes.length) {
      errors.push({ code: 'missing_graph_node', className });
      continue;
    }
    for (const [nodeId, node] of graphNodes) {
      for (const input of requirement.graphInputs || []) {
        if (!Object.hasOwn(node.inputs || {}, input)) errors.push({ code: 'missing_graph_input', className, nodeId, input });
      }
      for (const [input, value] of Object.entries(node.inputs || {})) {
        const choices = comboChoices(schemaInputs[input]);
        if (choices.length && typeof value === 'string' && !choices.includes(value)) {
          errors.push({ code: 'invalid_combo_value', className, nodeId, input, value });
        }
      }
    }
  }
  return { ok: errors.length === 0, workflowId, version: 1, errors };
}

function assertWorkflowCapability(workflowId, graph, objectInfo) {
  const result = validateWorkflowCapability(workflowId, graph, objectInfo);
  if (result.ok) return result;
  const first = result.errors[0] || {};
  const location = [first.className, first.input || first.output].filter(Boolean).join('.');
  const error = new Error(`The connected ComfyUI does not match ${workflowId}${location ? ` at ${location}` : ''}. Repair this workflow in Generation Setup, then try again.`);
  error.code = 'workflow_capability_mismatch';
  error.status = 409;
  error.workflowCapability = result;
  throw error;
}

module.exports = {
  WORKFLOW_CONTRACTS,
  assertWorkflowCapability,
  comboChoices,
  nodeInputDefinitions,
  validateWorkflowCapability,
};
