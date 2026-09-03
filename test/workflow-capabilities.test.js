'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertWorkflowCapability,
  validateWorkflowCapability,
} = require('../lib/workflow-capabilities');
const {
  assertVerifiedComfyRuntime,
  attestComfyEndpoint,
} = require('../lib/comfy-runtime-identity');

const fixtureDirectory = path.join(__dirname, 'fixtures', 'capabilities');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8'));
const supportedSnapshots = [
  ['current', readFixture('current-object-info.json')],
  ['previous', readFixture('previous-object-info.json')],
];

function schema(required, optional = {}, output = []) {
  return { input: { required, optional }, output };
}

function fixture() {
  return {
    UNETLoader: schema({ unet_name: [['krea2_turbo_fp8_scaled.safetensors']], weight_dtype: [['default']] }, {}, ['MODEL']),
    CLIPLoader: schema({ clip_name: [['Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors']], type: [['krea2']] }, {}, ['CLIP']),
    VAELoader: schema({ vae_name: [['qwen_image_vae.safetensors']] }, {}, ['VAE']),
    LoraLoaderModelOnly: schema({ model: ['MODEL'], lora_name: [['krea2_identity_edit_v1_2.safetensors']], strength_model: ['FLOAT'] }, {}, ['MODEL']),
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
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors', type: 'krea2' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'krea2_identity_edit_v1_2.safetensors', strength_model: 1 } },
    patch: { class_type: 'Krea2EditModelPatch', inputs: { model: ['lora', 0], source_latent: ['latent', 0], source_image: ['source', 0], vae: ['vae', 0], fit_mode: 'fit' } },
    positive: { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['clip', 0], prompt: 'person', image: ['source', 0], grounding_px: 768 } },
  };
}

function remixGraph() {
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors', type: 'krea2' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    rebalance: { class_type: 'Krea2EditRebalance', inputs: {
      text: 'at the location', clip: ['clip', 0], steering: 1, layer_multiplier: 1, enable_step: true, image1: ['source', 0],
    } },
  };
}

async function guardedSubmission({ runtime, stats, graph, objectInfo, submit }) {
  const attestation = await attestComfyEndpoint(runtime, 'http://127.0.0.1:8188', {
    fetchImpl: async () => ({ ok: true, async json() { return stats; } }),
  });
  assertVerifiedComfyRuntime(attestation);
  assertWorkflowCapability('create.krea2.element-character@1', graph, objectInfo);
  return submit();
}

test('current Character Element graph passes its exact node and model contract', () => {
  assert.equal(validateWorkflowCapability('create.krea2.element-character@1', characterGraph(), fixture()).ok, true);
});

for (const [label, objectInfo] of supportedSnapshots) {
  test(`${label} supported object_info snapshot passes Character and Location/Prop manifests`, () => {
    assert.equal(validateWorkflowCapability('create.krea2.element-character@1', characterGraph(), objectInfo).ok, true);
    assert.equal(validateWorkflowCapability('create.krea2.element-remix@1', remixGraph(), objectInfo).ok, true);
  });
}

test('node-name presence cannot hide a missing semantic identity input', () => {
  const info = fixture();
  delete info.Krea2EditModelPatch.input.optional.source_image;
  const result = validateWorkflowCapability('create.krea2.element-character@1', characterGraph(), info);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'missing_schema_input' && entry.input === 'source_image'));
  assert.throws(() => assertWorkflowCapability('create.krea2.element-character@1', characterGraph(), info), (error) => (
    error.code === 'workflow_node_schema_incompatible'
      && error.category === 'workflow_capability_mismatch'
      && error.status === 409
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

test('wrong install, missing model, and incompatible node schema are typed and never submit', async () => {
  const canonicalRuntime = { comfy: { path: '/studio/Mix-ComfyUI', modelsPath: '/studio/Mix-ComfyUI/models' } };
  const canonicalStats = {
    system: { argv: ['/studio/Mix-ComfyUI/main.py'], comfyui_version: '0.34.0' }, devices: [],
  };
  const cases = [
    {
      label: 'wrong install',
      stats: readFixture('foreign-system-stats.json'),
      info: supportedSnapshots[0][1],
      verify(error) {
        assert.equal(error.code, 'comfy_runtime_mismatch');
        assert.equal(error.status, 409);
        assert.match(error.message, /different ComfyUI installation|Generation Setup/);
      },
    },
    {
      label: 'missing model',
      stats: canonicalStats,
      info: readFixture('wrong-model-object-info.json'),
      verify(error) {
        assert.equal(error.code, 'workflow_model_unavailable');
        assert.equal(error.category, 'workflow_capability_mismatch');
        assert.equal(error.recoveryAction, 'open_generation_setup');
        assert.match(error.message, /model required|Generation Setup/);
      },
    },
    {
      label: 'incompatible node version',
      stats: canonicalStats,
      info: readFixture('incompatible-node-object-info.json'),
      verify(error) {
        assert.equal(error.code, 'workflow_node_schema_incompatible');
        assert.equal(error.category, 'workflow_capability_mismatch');
        assert.equal(error.recoveryAction, 'open_generation_setup');
        assert.match(error.message, /not a supported version|Generation Setup/);
      },
    },
  ];

  for (const scenario of cases) {
    let submissions = 0;
    await assert.rejects(
      guardedSubmission({
        runtime: canonicalRuntime,
        stats: scenario.stats,
        graph: characterGraph(),
        objectInfo: scenario.info,
        submit: async () => { submissions += 1; },
      }),
      (error) => {
        scenario.verify(error);
        return true;
      },
      scenario.label,
    );
    assert.equal(submissions, 0, `${scenario.label} reached submission`);
  }
});

test('Location and Prop remix requires image conditioning to survive schema filtering', () => {
  const graph = remixGraph();
  assert.equal(validateWorkflowCapability('create.krea2.element-remix@1', graph, fixture()).ok, true);
  delete graph.rebalance.inputs.image1;
  const result = validateWorkflowCapability('create.krea2.element-remix@1', graph, fixture());
  assert.ok(result.errors.some((entry) => entry.code === 'missing_graph_input' && entry.input === 'image1'));
});
