# Mix Studio MiniMax H3 worker

This image extends RunPod's pinned ComfyUI Serverless base. Attach the existing
`serfboy-models` network volume. RunPod mounts it at `/runpod-volume`; the startup
script registers its model directories without copying weights and links only
the H3-related custom nodes into ComfyUI.

Required endpoint settings: zero minimum workers, three maximum workers, one GPU
per worker, request-count scaler value 1, five-second idle timeout, FlashBoot,
and a two-hour execution timeout. Configure the private `MIX_R2_*` variables in
RunPod; never put them in the image or repository.

The handler accepts API-format workflows plus R2 input object descriptors and
returns R2 output descriptors. It never returns video bytes in RunPod JSON and
always requests a fresh worker after a job.

## Regional deployment

`scripts/deploy-h3-endpoint.js` is dry-run by default. It selects three stocked
regions that support RunPod's S3 network-volume API. The exact files to copy are
pinned in `scripts/h3-regional-inventory.json`; downloading replacements from
Hugging Face is explicitly forbidden.

Each selected region needs its own populated volume. The dedicated endpoint
starts at `workersMin: 0`, `workersMax: 1`. Promote it to three only after a
readiness probe, real render, gallery finalization, cleanup, and return to zero.

```sh
node scripts/deploy-h3-endpoint.js
node scripts/deploy-h3-endpoint.js --region US-KS-2 --volume-id VOL1 --region EU-CZ-1 --volume-id VOL2 --region US-GA-2 --volume-id VOL3 --apply
node scripts/deploy-h3-endpoint.js --endpoint-id ENDPOINT --promote
node scripts/deploy-h3-endpoint.js --endpoint-id ENDPOINT --promote --apply
```
