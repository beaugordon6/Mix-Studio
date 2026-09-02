'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertWorkflowCapability,
  validateWorkflowCapability,
} = require('../lib/workflow-capabilities');

function schema(required, optional = {}, output = []) {
  return { input: { required, optional }, output };
}

function fixture() {
  return {
    UNETLoader: schema({ unet_name: [['element.safetensors']], weight_dtype: [['default']] }, {}, ['MODEL']),
    CLIPLoader: schema({ clip_name: [['clip.safetensors']], type: [['krea2']] }, {}, ['CLIP']),
    VAELoader: schema({ vae_name: [['vae.safetensors']] }, {}, ['VAE']),
    LoraLoaderModelOnly: schema({ model: ['MODEL'], lora_name: [['identity.safetensors']], strength_model: ['FLOAT'] }, {}, ['MODEL']),
    Krea2EditModelPatch: schema({ model: ['MODEL'], source_latent: ['LATENT'] }, {
      source_image: ['IMAGE'], vae: ['VAE'], fit_mode: [['fit', 'crop (legacy)']], ref_boost: ['FLOAT'],
    }, ['MODEL']),
    Krea2EditGroundedEncode: schema({ clip: ['CLIP'], prompt: ['STRING'] }, {
      image: ['IMAGE'], grounding_px: ['INT'],
    }, ['CONDITIONING']),
    Krea2EditRebalance: schema({
      text: ['STRING'], clip: ['CLIP'], steering: ['FLOAT'], layer_multiplier: ['FLOAT'], enable_step: ['BOOLEAN'],
    }, { image1: ['IMAGE'] }, ['CONDITIONING']),
  };
}

function characterGraph() {
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'element.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'krea2' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'identity.safetensors', strength_model: 1 } },
    patch: { class_type: 'Krea2EditModelPatch', inputs: { model: ['lora', 0], source_latent: ['latent', 0], source_image: ['source', 0], vae: ['vae', 0], fit_mode: 'fit' } },
    positive: { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['clip', 0], prompt: 'person', image: ['source', 0], grounding_px: 768 } },
  };
}

test('current Character Element graph passes its exact node and model contract', () => {
  assert.equal(validateWorkflowCapability('create.krea2.element-character@1', characterGraph(), fixture()).ok, true);
});

test('node-name presence cannot hide a missing semantic identity input', () => {
  const info = fixture();
  delete info.Krea2EditModelPatch.input.optional.source_image;
  const result = validateWorkflowCapability('create.krea2.element-character@1', characterGraph(), info);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'missing_schema_input' && entry.input === 'source_image'));
  assert.throws(() => assertWorkflowCapability('create.krea2.element-character@1', characterGraph(), info), (error) => (
    error.code === 'workflow_capability_mismatch' && error.status === 409
  ));
});

test('wrong registered model and CLIP type fail before prompt submission', () => {
  const graph = characterGraph();
  graph.unet.inputs.unet_name = 'wrong.safetensors';
  graph.clip.inputs.type = 'stable_diffusion';
  const result = validateWorkflowCapability('create.krea2.element-character@1', graph, fixture());
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter((entry) => entry.code === 'invalid_combo_value').length, 2);
});

test('Location and Prop remix requires image conditioning to survive schema filtering', () => {
  const graph = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'element.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'krea2' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
    rebalance: { class_type: 'Krea2EditRebalance', inputs: {
      text: 'at the location', clip: ['clip', 0], steering: 1, layer_multiplier: 1, enable_step: true, image1: ['source', 0],
    } },
  };
  assert.equal(validateWorkflowCapability('create.krea2.element-remix@1', graph, fixture()).ok, true);
  delete graph.rebalance.inputs.image1;
  const result = validateWorkflowCapability('create.krea2.element-remix@1', graph, fixture());
  assert.ok(result.errors.some((entry) => entry.code === 'missing_graph_input' && entry.input === 'image1'));
});
