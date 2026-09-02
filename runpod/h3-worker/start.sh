#!/bin/bash
set -euo pipefail

COMFY_DIR="/comfyui"
if [[ -n "${RUNPOD_VOLUME_PATH:-}" ]]; then
  VOLUME_ROOT="$RUNPOD_VOLUME_PATH"
elif [[ -d "/runpod-volume/models" ]]; then
  VOLUME_ROOT="/runpod-volume"
else
  # RunPod templates created from older Pod-backed volumes expose the volume
  # at /workspace. Detect it explicitly instead of failing every cold start.
  VOLUME_ROOT="/workspace"
fi

if [[ ! -d "$VOLUME_ROOT/models" ]]; then
  echo "H3 network volume is not mounted at $VOLUME_ROOT" >&2
  exit 1
fi

# Models remain on the network volume. Extra model paths avoids copying hundreds
# of gigabytes into each ephemeral worker.
cat > "$COMFY_DIR/extra_model_paths.yaml" <<YAML
mix_h3_volume:
  base_path: $VOLUME_ROOT
  checkpoints: models/checkpoints
  clip: models/clip
  clip_vision: models/clip_vision
  controlnet: models/controlnet
  diffusion_models: models/diffusion_models
  ipadapter: models/ipadapter
  loras: models/loras
  text_encoders: models/text_encoders
  unet: models/unet
  upscale_models: models/upscale_models
  vae: models/vae
YAML

mkdir -p "$COMFY_DIR/custom_nodes"
for source in \
  "$VOLUME_ROOT/custom_nodes/ComfyUI-GGUF" \
  "$VOLUME_ROOT/custom_nodes/ComfyUI-H3-FaceRefine" \
  "$VOLUME_ROOT/custom_nodes/Comfyui-Minimax-H3-Promptor" \
  "$VOLUME_ROOT/custom_nodes/cgem156-ComfyUI" \
  "$VOLUME_ROOT/runpod-slim/ComfyUI/custom_nodes/ComfyUI-KJNodes"; do
  if [[ -d "$source" ]]; then
    ln -sfn "$source" "$COMFY_DIR/custom_nodes/$(basename "$source")"
  fi
done

cd "$COMFY_DIR"
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --extra-model-paths-config extra_model_paths.yaml &
COMFY_PID=$!
cleanup() { kill "$COMFY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:8188/object_info >/dev/null; then
    exec python /mix-h3/handler.py
  fi
  if ! kill -0 "$COMFY_PID" 2>/dev/null; then
    echo "ComfyUI exited before becoming ready" >&2
    exit 1
  fi
  sleep 2
done

echo "ComfyUI did not become ready within six minutes" >&2
exit 1
