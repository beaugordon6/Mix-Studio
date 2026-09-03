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

const MODEL_INPUTS = new Set(['unet_name', 'clip_name', 'vae_name', 'lora_name', 'model_name']);

function capabilityFailureCode(failure = {}) {
  if (failure.code === 'unknown_contract') return 'workflow_contract_unknown';
  if (['missing_node', 'missing_graph_node'].includes(failure.code)) return 'workflow_node_missing';
  if (failure.code === 'invalid_combo_value' && MODEL_INPUTS.has(failure.input)) {
    return 'workflow_model_unavailable';
  }
  return 'workflow_node_schema_incompatible';
}

function capabilityFailureMessage(workflowId, failure = {}) {
  const location = [failure.className, failure.input || failure.output].filter(Boolean).join('.');
  const suffix = location ? ` (${location})` : '';
  if (failure.code === 'invalid_combo_value' && MODEL_INPUTS.has(failure.input)) {
    return `A model required by ${workflowId} is not registered in the connected ComfyUI${suffix}. Open Generation Setup, repair this workflow, then try again.`;
  }
  if (failure.code === 'missing_node') {
    return `The connected ComfyUI is missing a node required by ${workflowId}${suffix}. Open Generation Setup, repair this workflow, then try again.`;
  }
  if (['missing_schema_input', 'missing_schema_output'].includes(failure.code)) {
    return `An installed ComfyUI node is not a supported version for ${workflowId}${suffix}. Open Generation Setup, update or repair this workflow, then try again.`;
  }
  return `The connected ComfyUI does not match ${workflowId}${suffix}. Open Generation Setup, repair this workflow, then try again.`;
}

function assertWorkflowCapability(workflowId, graph, objectInfo) {
  const result = validateWorkflowCapability(workflowId, graph, objectInfo);
  if (result.ok) return result;
  const first = result.errors[0] || {};
  const error = new Error(capabilityFailureMessage(workflowId, first));
  error.code = capabilityFailureCode(first);
  error.category = 'workflow_capability_mismatch';
  error.status = 409;
  error.recoveryAction = 'open_generation_setup';
  error.workflowCapability = result;
  throw error;
}

module.exports = {
  WORKFLOW_CONTRACTS,
  assertWorkflowCapability,
  capabilityFailureCode,
  capabilityFailureMessage,
  comboChoices,
  nodeInputDefinitions,
  validateWorkflowCapability,
};
