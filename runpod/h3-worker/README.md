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
