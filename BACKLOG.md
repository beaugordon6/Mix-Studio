# Mix Studio development backlog

This is the shared source of truth for planned and active development work. Permanent item IDs are never reused. Active work stays grouped by priority; verified work moves to the completed archive.

Allowed statuses are `Ready`, `Claimed`, `Blocked`, and `Completed`. Follow the claim and completion protocol in `AGENTS.md` before changing the repository.

## High priority

### MIX-006 — Durable generation queue and Comfy reconnect recovery

- Status: Ready
- Priority: High
- Claimed by: —
- Claimed at: —
- Completed at: —
- Summary: Make Mix Studio the durable source of truth for generation intent so queued work survives Mix restarts, ComfyUI restarts, port changes, browser reloads, and temporary disconnects without duplicate generations.
- Requirements:
  - Add an atomic, profile-scoped queue journal under `data/` with stable Mix job IDs, exact normalized request/graph data, input references, timestamps, state, retry metadata, and current Comfy prompt ID.
  - Write the durable job before submitting it to ComfyUI, then persist every lifecycle transition through completion, cancellation, or a terminal error.
  - Restore non-terminal jobs into the server queue on boot and expose them even while ComfyUI is unavailable; an offline queue response must never look authoritatively empty.
  - Reconcile against both ComfyUI `/queue` and `/history` after reconnect before deciding whether to adopt, finalize, retry, or resubmit a job.
  - Use stable idempotency markers and a fresh-instance/reconnect epoch so recovery cannot submit the same generation twice when completion status is temporarily ambiguous.
  - Automatically rediscover the same local Comfy installation when its Desktop port changes, update the active endpoint, and reconnect transports without requiring a Mix restart.
  - Add a bounded health supervisor with explicit `connected`, `degraded`, `reconnecting`, and `attention required` states; never clear or fail durable jobs solely because Comfy is unreachable.
  - Recover completed outputs from Comfy history/output metadata when Mix was offline during completion.
  - Preserve queue order, profile ownership, sequential-edit/chunk relationships, cancellation intent, and gallery finalization across recovery.
  - Show preserved jobs in the Queue as **Waiting for ComfyUI** or **Recovering** instead of removing them; keep the original prompt, seed, thumbnail, and position visible.
  - Block automatic Mix or Comfy restarts while an unjournaled or ambiguous job exists; restart only after durable state is flushed and the queue has been reconciled.
- Acceptance:
  - [ ] Killing and restarting Mix with pending and running test jobs restores every job in the same order.
  - [ ] Killing and restarting ComfyUI preserves pending work in Mix and safely resubmits it after reconnect without duplicates.
  - [ ] A Comfy Desktop port change is detected and adopted automatically for the same installation.
  - [ ] Browser reload, SSE reconnect, and an offline `/api/queue` response never erase preserved job cards.
  - [ ] A job completed while Mix is unavailable is finalized into the correct profile gallery after recovery.
  - [ ] Repeated reconnects and ambiguous network failures produce at most one gallery result per durable job.
  - [ ] Cancellation during a disconnect remains durable and prevents later resubmission.
  - [ ] Tests cover crash points before submission, after submission, while running, after Comfy completion, and during gallery finalization.
  - [ ] Recovery tests use throwaway data and fake Comfy endpoints; no destructive test touches live `data/` or a live queue.
  - [ ] Queue, route, lifecycle, profile-isolation, migration, and browser reconciliation suites pass.
- Dependencies:
  - Reuse the current Comfy endpoint discovery and installation-correlation logic rather than adopting any arbitrary local Comfy server.
  - Preserve existing Smart-run durability while extending equivalent guarantees to ordinary image, edit, video, upscale, and composite jobs.
- Verification: Partial milestone verified 2026-09-02: an atomic ordinary-image job journal restored and finalized two completed Comfy jobs after separate Mix restarts; missing durable image jobs now resubmit after Comfy is reachable and confirms they are absent from both queue and history. `node --test` — 1,285 passed, 0 failed, 1 skipped. The broader fault-injection matrix remains pending: Mix crash × Comfy running, Comfy crash × Mix running, both restart, port drift, reconnect during finalization, and non-image workflow families.
- Notes: SEV2 incident on 2026-09-02 involved two distinct installations: successful jobs embedded models from `/Users/beaugordon/Studio/Mix-ComfyUI`, while Mix was later configured to the Comfy Desktop source at `/Users/beaugordon/ComfyUI-Installs/ComfyUI/ComfyUI` on `127.0.0.1:8188`. The live Comfy queue/history and Mix boot-scoped `jobs` Map were empty, so vanished pending jobs had no durable recovery source. Do not silently adopt a sole loopback endpoint unless it is correlated to the configured installation. The first recovery milestone covers ordinary image and Strength Hunt jobs; video, upscale, composite, pre-submit crash closure, stable Mix job IDs, and full cancellation idempotency remain in this backlog item.

### MIX-013 — Reliability spine and blocking-error SLO

- Status: Claimed
- Priority: High
- Claimed by: `codex/runpod-h3-worker` — reliability spine implementation
- Claimed at: 2026-09-02T19:54:57Z
- Completed at: —
- Summary: Reduce Mix Studio to no more than one user-blocking incident per week by making runtime identity, workflow readiness, error recovery, and release verification measurable and consistent.
- Requirements:
  - Define one immutable runtime fingerprint from `install.json` (Comfy source/models paths, Python, PID, port, input namespace, core/node versions) and reject a reachable but foreign listener instead of silently adopting it.
  - Replace broad feature readiness with versioned per-workflow capability manifests that verify exact nodes, models, and compatible schemas before generation or installation success is reported.
  - Complete MIX-006's stable, durable operation lifecycle before every external side effect, including generation, edit, video, upscale, composite, cloud submission, cancellation, and gallery finalization.
  - Treat Mix-managed inputs as authoritative and Comfy inputs as a staging cache; record an input manifest and restore profile-owned bytes before first submission, retry, reorder, or restart recovery.
  - Add a privacy-safe local incident ledger with typed phases/codes, correlation IDs, recovery outcome, runtime fingerprint, and a user-exportable support bundle; never record prompt or image contents by default.
  - Put optional/cloud providers behind bounded timeouts, circuit breakers, and explicit capacity states so their failures cannot degrade core local Create/Edit.
  - Serialize installs, restarts, updates, and deployments with a maintenance lease; refuse production restart from unrelated dirty changes and use isolated worktrees for concurrent tasks.
  - Replace critical source-regex checks with fake-Comfy/provider behavioral tests covering disconnects, crashes, port/install drift, stale inputs, ambiguous submission, cancellation, and finalization.
- Acceptance:
  - [ ] Fifty randomized fake-Comfy outage runs lose and duplicate zero jobs and preserve order, cancellation, and profile isolation.
  - [ ] Switching to a fresh correlated input namespace automatically restores every declared durable asset before `/prompt`; foreign-profile assets never leave Mix storage.
  - [ ] Current and previous supported capability snapshots pass; wrong-install, wrong-model, and wrong-node-version fixtures fail before submission with an actionable typed error.
  - [ ] No core route returns an unclassified generic 500 for a known dependency, connection, validation, capacity, or asset failure.
  - [ ] Clean-tree unit/integration suites and Chromium/WebKit critical journeys pass against isolated data and fake services; a bounded real-process smoke passes without touching the live gallery.
  - [ ] For four consecutive production weeks: at most one blocking incident per week, zero lost/duplicate/cross-profile/destructive incidents, at least 99.5% durable acceptance, at least 99% completion, and at least 90% transient auto-recovery.
- Dependencies:
  - Finish the remaining workflow families and idempotency guarantees in MIX-006.
  - Preserve the canonical source-install repair in MIX-012 and repository coordination protocol in MIX-003.
- Verification: First reliability-spine milestone verified 2026-09-02: focused runtime identity, workflow contract, offline queue, Element staging, dependency, compatibility, cancellation, and recovery tests passed 112/112. A read-only live attestation identified canonical ComfyUI 0.34.0 as the configured source/models/input installation, and the production Character Element graph passed its versioned contract against the live `/object_info` without submitting work. Milestone 1's exact staged patch passed `node --check server.js`, `node --check public/app.js`, and the clean full `node --test` suite (1,306 passed, 0 failed, 1 skipped). Milestone 2's stable-ID reconciliation, journal migration, and operation-journal tests passed 29/29 focused; its exact staged patch passed syntax checks and the clean full suite (1,326 passed, 0 failed, 1 skipped) in an isolated checkout.
- Notes: Created from the 2026-09-02 cross-task incident review. Recurring clusters were installation/port/input-namespace drift, pre-submit durability gaps, dependency success checked against the wrong installation, toast-only failures, shared-worktree deployment contamination, cloud capacity ambiguity, and insufficient behavioral fault tests. Provider capacity counts as blocking when Mix allows an attempt that cannot run. Milestone 1 adds stable install and per-process instance fingerprints, rejects a foreign source/input/models runtime before every Comfy write, keys the node-schema cache to the live instance, adds exact Character and Location/Prop Element contracts, includes shared CLIP/VAE readiness and Krea core gating, and keeps all profile-owned durable jobs visible when Comfy is offline. Milestone 2 journals ordinary Create/Edit/Elements and Strength Hunt intents before Element staging or `/prompt`, uses one caller-supplied canonical UUID end to end, and requires authoritative absence from both Comfy queue and history before a same-ID retry; Comfy does not deduplicate duplicate IDs. The next P0 is durable cancellation and idempotent gallery finalization, followed by extending this lifecycle to video, upscale, composite, and cloud submissions.

### MIX-001 — Automatic Krea 2 face repair

- Status: Blocked
- Priority: High
- Claimed by: `main` — face repair implementation task
- Claimed at: 2026-09-02T15:42:58Z
- Completed at: —
- Summary: Add a one-click face repair pass that allocates Krea 2 resolution specifically to undersized faces and eyes.
- Requirements:
  - Add a one-click **Fix faces** action.
  - Process the displayed version, preferring the upscale when one exists.
  - Detect and repair the two largest eligible faces automatically.
  - Refine Krea 2 face crops at 1024px with denoise `0.40`.
  - Save a new gallery version linked to its source without modifying the source.
  - Manage Impact Pack, Impact Subpack, and face-detector dependencies through Generation Setup.
- Acceptance:
  - [ ] Eyes and facial detail visibly improve without materially changing identity.
  - [ ] Repaired regions have no rectangular seams or obvious pasted-on color shifts.
  - [x] A zero-face result does not create an unchanged duplicate.
  - [x] Results and source lookups remain profile-isolated.
  - [x] Missing dependencies lead to a recoverable setup flow.
  - [x] Automated graph, route, lifecycle, metadata, and UI tests pass.
- Verification: `node --check server.js` passed; `node --check public/app.js` passed; `node --test test/face-fix-workflows.test.js test/dependency-manager.test.js` passed (55/55); `node --test` passed (1,296 passed, 0 failed, 1 skipped) on 2026-09-02.
- Notes: Use the approved automatic, displayed-version, new-linked-version design. Implemented a non-destructive Krea 2 crop-detailer pass using pinned Impact Pack and Impact Subpack revisions, `face_yolov8m.pt`, a 0.35% minimum face-area filter, the two largest eligible faces, 1024px crops, denoise 0.40, and feathered compositing. Mix exposes Fix faces in desktop and focused-image actions, prefers an upscale, saves a linked gallery version, suppresses zero-face duplicates, and routes missing dependencies into Generation Setup. Blocked on final visual acceptance because Mix and both known local ComfyUI endpoints were offline at 2026-09-02T15:57:05Z; resume by starting the services, installing the Face Repair component through Generation Setup, and comparing a representative portrait for identity, eyes, seams, and color.

### MIX-002 — Upscale tile progress and ETA

- Status: Ready
- Priority: High
- Claimed by: —
- Claimed at: —
- Completed at: —
- Summary: Replace the generic upscale waiting state with phase-aware progress, queue context, and an approximate completion estimate.
- Requirements:
  - For Ultimate SD, display active tile, total tiles, step progress, elapsed time, and estimated remaining time.
  - Distinguish queued, model loading, tile sampling, decoding, saving, and stalled states.
  - For SeedVR2, display encode, DiT, decode, and post-processing phases.
  - Preserve progress across reloads and browser reconnection.
  - Show the selected engine and an expected-performance warning before large Apple MPS jobs.
  - Display how many jobs are waiting behind the active job.
  - Do not show a frozen generic `Upscaling…` message while measurable progress exists.
  - Base ETA on observed time per completed tile or phase and label it approximate until enough progress exists.
- Acceptance:
  - [ ] A six-tile Ultimate SD job visibly advances from tile 1 through tile 6.
  - [ ] ETA updates without dropping to zero between tiles.
  - [ ] Reloading Mix restores the current stage.
  - [ ] SeedVR2 displays meaningful phase progress.
  - [ ] Queue backlog is visible.
  - [ ] Errors replace progress immediately.
  - [ ] Unit and UI tests cover progress resets, reconnects, and completion.
- Verification: —
- Notes: Initial diagnosis showed Ultimate SD taking roughly 4.5 minutes per 768px tile on Apple MPS, making tile-level feedback essential.

## Medium priority

### MIX-010 — Project asset library and watched-folder ingest

- Status: Ready
- Priority: Medium
- Claimed by: —
- Claimed at: —
- Completed at: —
- Summary: Make Mix Studio the visual source of truth for long-form AI productions by importing external media from a project folder and keeping reusable prompts, provenance, and production organization attached to each asset.
- Requirements:
  - Add profile-scoped projects with a title, optional local interchange-folder path, and stable project ID; existing gallery behavior must remain compatible for users who do not create projects.
  - Allow a project to organize media by production role (`character`, `location`, `prop`, `shot`, `video`, `audio`, `other`) and user-defined collections without duplicating the underlying file.
  - Extend cataloged assets with an editable display name, prompt, negative prompt, source application/model, production role, status, tags, notes, parent/reference relationships, creation date, and original external filename.
  - Add a safe import flow for images, video, and audio from a configured local project inbox; imported files must be copied into Mix Studio's managed storage before cataloging, never edited or deleted in the external folder.
  - Deduplicate imports by content hash rather than filename, record import outcomes, and tolerate partial writes by waiting for file size/mtime to stabilize before ingest.
  - Provide an owner-controlled watched-folder option with clear running, paused, error, and last-scan states; recursive watching and two-way filesystem synchronization are out of MVP scope.
  - Expose prompt copy/edit, source/provenance, tags, role, status, and project filters directly from the visual asset library.
  - Preserve full-resolution originals and embedded metadata where present; generate previews without modifying originals.
  - Support export of a portable project manifest containing asset metadata and relative filenames so a project can be backed up and reconstructed independently of Notion.
  - Keep Notion as the writing and planning system; do not require Notion availability for media ingest, browsing, prompt reuse, or generation.
- Acceptance:
  - [ ] Creating a project and selecting a local inbox allows stable image, video, and audio files to appear once in that project's Mix Studio library.
  - [ ] Re-copying or renaming identical media does not create a duplicate asset.
  - [ ] An imported asset can be classified, tagged, renamed, given a prompt and provenance, and found by each of those fields.
  - [ ] The prompt can be copied or used to prefill an appropriate Mix Studio generation form from the asset card.
  - [ ] Imported originals remain intact if the inbox file changes or is removed, and Mix Studio never deletes from the external folder.
  - [ ] The watcher reports inaccessible folders and interrupted copies without creating corrupt catalog entries.
  - [ ] Project filters clearly separate references from generated shots and distinguish still images, video, and audio.
  - [ ] A project manifest export contains every asset's stable ID, relative managed filename, prompt, provenance, role, status, tags, relationships, and hash.
  - [ ] Profile isolation, locked-folder behavior, deletion safeguards, migrations, ingest deduplication, and UI flows have automated coverage; `node --test` passes.
- Dependencies:
  - Reuse the durable `uploadedAssets` storage and `/api/upload` catalog path where practical, while migrating it without breaking existing references or Elements.
  - Local folder access is a desktop-host capability and must be restricted to an explicitly configured directory rather than accepting arbitrary browser-supplied paths.
- Verification: Not started.
- Notes: Product exploration on 2026-09-02 found that Mix Studio already catalogs durable profile-scoped uploads with image/video/audio previews, search, sorting, Comfy reuse, and in-use deletion protection. Current uploaded-asset records contain only ID, profile, managed name, label, kind, size, audio flag, and creation time; they lack projects, prompts, provenance, roles, tags, statuses, relationships, content hashes, and external-folder ingest. Recommended MVP is one-way copy from a single non-recursive project `Inbox` into Mix-managed storage plus manual metadata editing; two-way sync, automatic Notion mirroring, recursive folder semantics, and AI auto-classification should be deferred until the ingest/catalog model proves useful.

## Low priority

No items yet.

## Claimed

### MIX-004 — Visual Elements library and prompt references

- Status: Claimed
- Priority: Medium
- Claimed by: `main` — correct Character, Location, and Prop conditioning
- Claimed at: 2026-09-02T12:42:58Z
- Completed at: —
- Summary: Add a reusable, profile-scoped Elements library for named character, location, and prop image references that can be inserted into prompts with `@handles`.
- Requirements:
  - Preserve the native prompt textarea and render recognized handles as accessible linked chips beneath it.
  - Create an Element by uploading one image and assigning a unique `@handle` plus character, location, or prop type.
  - Add a single **Save as Element** action to existing gallery images; copy the source into durable input storage first.
  - Add a profile-scoped Elements collection to Library with browse/search, view, rename, type change, replace-image, and deletion flows.
  - Resolve known handles in prompt order and enforce each engine's reference capacity with a clear pre-generation error rather than silently dropping images.
  - Allow a generated gallery image to be copied into durable input storage before saving it to an Element, so later gallery deletion cannot break the Element.
  - Resolve known handles at generation time while leaving unknown handles and anonymous uploaded references unchanged.
  - Treat Element images as appearance references on an empty output canvas so the selected aspect ratio and prompt control framing instead of inheriting the reference crop.
  - Apply type-aware fidelity instructions for character appearance, location architecture/layout, and prop shape/materials/details.
  - Give every active Element chip a one-tap remove action that removes its `@mention` without deleting the saved Element.
  - Include Elements in profile adoption, deletion, asset-usage, and safe-deletion logic.
- Acceptance:
  - [ ] Character, location, and prop Elements can be created, edited, browsed, and deleted without crossing profile boundaries.
  - [ ] Typing or pasting a known `@handle` produces a linked chip that opens the Element.
  - [ ] An active Element can be removed from the next generation directly from its chip without deleting it from the library.
  - [ ] Unknown handles remain authored text and are never silently removed or substituted.
  - [ ] Generation preserves prompt order, uses only profile-owned assets, and blocks with a clear capacity message rather than silently omitting a reference.
  - [ ] Deleting a gallery result does not break an Element created from that result.
  - [ ] The UI reuses Mix Studio's sheets, cards, pickers, spacing, typography, focus behavior, responsive layouts, and reduced-motion conventions.
  - [ ] Server, profile lifecycle, generation, asset-safety, accessibility, and static UI tests pass.
  - [ ] Browser smoke checks pass against duplicate development data without submitting a generation or mutating live user data.
- Dependencies:
  - Complete or preserve the repository coordination guarantees tracked by MIX-003.
  - Reuse the existing upload catalog, shared source picker, profile ownership checks, and Krea/H3 reference limits.
- Verification: Implementation, profile lifecycle, upload safety, prompt resolution, dependency readiness, syntax, and full-suite checks passed on 2026-09-02 (`node --test`: 1,296 passed, 0 failed, 1 skipped). Real user acceptance testing failed the Character Element quality bar: the stock Krea 2 identity route did not preserve Hermes closely enough, censored requested anatomy, and produced unwanted framing. HomoFidelis INT8 plus the identity LoRA was too slow on Apple MPS to be usable. The downloaded HomoFidelis BF16 candidate remains quarantined in the model staging directory, uninstalled and unselected, until a controlled identity/quality/speed comparison is approved and completed.
- Notes: Source plan: `docs/superpowers/plans/elements.md`. The low-friction management UI is implemented: one image, prefilled/editable handle, remembered type, inline prompt tokens with one-tap removal, always-available edit controls, and Save as Element from the gallery. Character generation remains incomplete and must not be marked shipped until one workflow proves acceptable identity fidelity, independent composition, uncensored prompt adherence, and practical runtime. Location and prop Elements currently use Conditioning Rebalance but still require end-to-end visual acceptance. `comfyui-krea2edit` is pinned to v1.2.5-era commit `86f886d`; installed SDXL IP-Adapter weights are not compatible with Krea2. Multi-image Elements, bulk import/merge, shared reference-tray redesign, and overflow visualization remain out of scope. Dependency regression reproduced and fixed 2026-09-02: Elements was newly configured to require the rank-reduced `krea2_identity_edit_v1_2_r64.safetensors` even though canonical ComfyUI already exposed the recommended full `krea2_identity_edit_v1_2.safetensors`; setup could finish and immediately ask to install again. Elements now reuses the installed full v1.2 LoRA and migrates the transient r64-only setting without another download. Focused dependency/Elements tests passed 67/67; after the authorized Mix-only restart, live `/api/meta` reported both the configured HomoFidelis Element UNet and full v1.2 identity LoRA as `ok: true`. A second root cause was confirmed after `@hermes` failed `LoadImage` validation: Mix retained the profile-owned bytes but treated the old Comfy filename as portable across input namespaces. Element submission, legacy restart recovery, and queue reorder now restore the exact durable bytes/name to the active Comfy endpoint before `/prompt`, with typed profile-safe failures and attention state for irrecoverably missing assets. Focused staging/recovery checks passed 20/20; the working-tree suite excluding one unrelated in-progress RunPod deployment test passed 1,310/1,310 with one skip.

### MIX-009 — Native M5 acceleration for INT8 ConvRot

- Status: Ready
- Priority: High
- Claimed by: —
- Claimed at: —
- Completed at: —
- Summary: Replace HomoFidelis Krea 2's CPU `_int_mm` fallback with a verified native Metal INT8 kernel on the M5 Max while retaining safe fallback behavior.
- Requirements:
  - Pin and audit the third-party Apple Silicon acceleration source before installation.
  - Enable only the required INT8 ConvRot patch, avoiding unrelated global runtime patches.
  - Install into the active Comfy Desktop source and its Python environment without changing Mix's selected model.
  - Restart only while both queues are empty and verify the native kernel's build, warmup, and numerical self-check.
  - Benchmark the same HomoFidelis prompt, seed, resolution, and eight-step graph against the fallback baseline without losing Mix queue/gallery tracking.
- Acceptance:
  - [ ] Active Comfy startup identifies the pinned extension and M5 native INT8 capability.
  - [ ] The native INT8 kernel builds and passes its numerical self-check.
  - [ ] A tracked HomoFidelis generation completes without `_int_mm` CPU fallback.
  - [ ] Benchmark records end-to-end and sampling time plus output-equivalence observations.
  - [ ] Removing or disabling the extension cleanly restores the existing safe fallback.
- Verification: Operational repair verified 2026-09-02. Startup detected Apple M5 Max, Metal compile support, matrix units, and `ninja`; native INT8 self-check passed. A 512×512 eight-step run completed in 49.7s end-to-end with 17.9s sampling. A warm 992×736 eight-step run completed in 98.6s end-to-end with roughly 43s sampling. `node --test` — 1,285 passed, 0 failed, 1 skipped.
- Notes: Candidate audited and installed at commit `74734a108eb1640c24e131ee088b995ff962c47f` (release v1.3.2). Only `int8_linear_kernel_mps`, `fused_norm_mps`, and `rope_fast_mps` are enabled; unrelated patches including the downloader-capable optional MLX path remain disabled. The operational performance issue is resolved. Formal completion still requires the exact fallback/native same-prompt output-equivalence record and a documented disable/restore exercise.

### MIX-008 — RunPod Serverless MiniMax H3 generation

- Status: Claimed
- Priority: High
- Claimed by: `main` — RunPod Serverless H3 implementation
- Claimed at: 2026-09-02T10:51:01Z
- Completed at: —
- Summary: Run every existing MiniMax H3 workflow on autoscaling RunPod Serverless workers, transfer assets through temporary Cloudflare R2 objects, and preserve Mix Studio's queue and gallery experience.
- Requirements:
  - Route H3 jobs to a durable RunPod client while keeping every other engine on the connected local ComfyUI.
  - Scale from zero to at most three one-GPU workers and refuse unsafe endpoint settings that could leave paid workers active or exceed the cost ceiling.
  - Preserve Frames, Reference, Replace, Turbo, Long Context, LoRAs, audio, post-processing, cancellation, progress, profile isolation, and gallery finalization.
  - Package a pinned H3 ComfyUI worker that downloads signed R2 inputs, runs one logical video per worker, publishes verified outputs, and requests worker refresh after every job.
  - Persist remote job identity and lifecycle transitions atomically so Mix restarts never duplicate or lose an accepted render.
  - Delete temporary R2 objects after local finalization, with bounded retention for recoverable failures and lifecycle cleanup as a backstop.
  - Keep RunPod and R2 credentials private, redacted, and owner-configurable.
- Acceptance:
  - [ ] A single short real H3 job wakes a worker from zero, appears in Mix Studio, saves a playable gallery video, and returns the endpoint to zero workers.
  - [ ] Three H3 jobs run concurrently while a fourth remains queued under the hard three-worker limit.
  - [ ] Jobs completing out of order finalize into the correct profile and source item.
  - [ ] Restart recovery, cancellation, corrupt output, provider timeout, and interrupted cleanup paths are idempotent and recoverable.
  - [ ] Unsafe endpoint configuration, missing credentials, incompatible worker manifests, and missing models block before paid generation starts.
  - [ ] Temporary input and output objects are deleted after success or cancellation, with no credentials exposed through APIs or logs.
  - [ ] Local image and non-H3 video workflows remain unchanged.
  - [ ] Focused fake-provider tests, worker tests, syntax checks, and the complete `node --test` suite pass without touching live gallery data.
- Verification: R2 live write/read/checksum/delete probe passed against the private `mix-studios` bucket on 2026-09-02; the probe object was deleted. Live RunPod smoke tests still require a configured Serverless endpoint.
- Notes: This is the focused cloud-H3 MVP approved on 2026-09-02. It deliberately does not implement the broader local Comfy durability work tracked by MIX-006. The earlier completed MIX-007 ID is preserved, so this work uses MIX-008. Cloudflare credentials were imported from the owner's local credential receipt into gitignored `data/runpod-h3.json` with mode `0600`; the broader Cloudflare Account API token was deliberately not stored because R2's S3 credentials are sufficient. SaladCloud was evaluated as an emergency alternative on 2026-09-02. It supports Docker, RTX 5090, lawful adult workloads, managed queues, parallel replicas, and scale-to-zero, but it has no mountable persistent volumes, caps compressed images at 35 GB and ephemeral storage at 50 GB, and documents multi-minute to 40-minute distributed cold starts. The minimum H3 Frames stack is about 42 GB before Comfy/runtime overhead, so it cannot be baked into one Salad image and would need large per-node downloads. Salad's interruptible nodes and four-attempt queue limit are also a poor match for long H3 renders. Recommendation: keep RunPod for the MVP and move/copy the minimal model stack to a better-stocked RunPod region; revisit Salad after a measured H3-specific image/cache proof of concept.

## Blocked

No items currently blocked.

## Completed archive

Completed items are moved here in completion-date order. Keep their requirements, checked acceptance criteria, and verification record intact.

### MIX-011 — Repair one-click Klein 9B setup installation

- Status: Completed
- Priority: High
- Claimed by: `Fix Klein model download` — Generation Setup installer repair and model installation
- Claimed at: 2026-09-02T14:12:19Z
- Completed at: 2026-09-02T15:17:29Z
- Summary: Make the highlighted current-workflow Install action reliably start the Klein 9B dependency installation and give immediate, visible feedback when setup cannot start.
- Requirements:
  - Reproduce and isolate the no-response Install action from the edit generation setup flow.
  - Preserve the existing curated Klein 9B FP8 model, text encoder, VAE, consistency LoRA, and GGUF-node installation plan.
  - Prevent double submission while the install request is starting and surface any blocking/error state inside the setup dialog, not only as a transient toast.
  - Install the missing Klein 9B dependencies into the configured ComfyUI model root after verifying the target installation and idle queues.
- Acceptance:
  - [x] Clicking the highlighted Klein 9B Install action sends exactly one install request with `klein9`.
  - [x] The button immediately changes to a starting/working state and setup displays progress or an actionable error.
  - [x] Focused setup/dependency tests and the full `node --test` suite pass.
  - [x] The configured ComfyUI installation reports all Klein 9B models and required nodes after restart/reload.
- Verification: `node --check server.js`; `node --check public/app.js`; `node --test test/dependency-manager.test.js` — 51 passed, 0 failed; `node --test` — 1,292 passed, 0 failed, 1 skipped. Live `/object_info` check reported the Klein 9B UNet, Qwen 3 8B encoder, consistency LoRA, FLUX2 VAE, and GGUF loader, all without requiring a restart.
- Notes: Root cause: a synchronous install rejection, including the busy-queue guard visible in the supplied screenshot, cleared the in-dialog starting state and exposed the failure only through a transient toast. The repaired flow retains the error and requested component in the setup operation panel. The owner-provided Hugging Face read token was imported from Downloads without logging its value; `data/settings.json` was restricted to mode `0600`. The live installer downloaded and validated `flux-2-klein-9b-fp8.safetensors` (9,433,061,528 bytes), `qwen_3_8b_fp8mixed.safetensors` (8,664,848,742 bytes), `f2k_9B_lcs_consist_20260415.safetensors` (348,167,344 bytes), and `flux2-vae.safetensors` (336,213,556 bytes). A second bug was fixed in `ensureUv`: Comfy Desktop stores the real macOS executable in `standalone-env/bin/uv`, while the old helper returned nonexistent `.venv/bin/uv.exe` after installation and unnecessarily fell back to HTTP.

### MIX-007 — Guard Apple MPS fallback for INT8 ConvRot

- Status: Completed
- Priority: High
- Claimed by: `main` — MPS runtime incident
- Claimed at: 2026-09-02T10:36:11Z
- Completed at: 2026-09-02T10:42:44Z
- Summary: Ensure Comfy Desktop launched on macOS inherits PyTorch CPU fallback before Mix submits an INT8 ConvRot graph, and make the failure recoverable if an already-running process lacks it.
- Requirements:
  - Publish `PYTORCH_ENABLE_MPS_FALLBACK=1` into the macOS GUI launch environment from the standard Mix launcher before starting the server.
  - Preserve an explicit user override while defaulting the fallback on.
  - Keep direct Mix-managed Comfy Python launches on the same fallback policy.
  - Recognize the unsupported `_int_mm` KSampler failure and return an actionable restart message instead of an opaque backend exception.
  - Never restart Comfy while either Mix or Comfy has queued work.
- Acceptance:
  - [x] Starting Mix from `start.command` primes the launch environment used by subsequently opened Comfy Desktop instances.
  - [x] The launcher and direct-Python paths default the fallback to `1` and preserve an explicit value.
  - [x] An `_int_mm` MPS execution failure tells the user to restart the idle Comfy runtime after Mix has primed the fallback.
  - [x] Focused launcher/runtime tests and the full test suite pass.
- Verification: `node --check server.js`; `node --test test/comfy-start.test.js test/backlog-protocol.test.js` — 16 passed; `node --test` — 1,272 passed, 0 failed, 1 skipped; isolated `torch._int_mm` in the active Comfy venv returned `mps:0 [[2, 2], [2, 2]]` with the expected CPU-fallback warning. Live Mix and Comfy queues were both empty before restart; Mix returned healthy on port 3300 afterward.
- Notes: Reproduced on 2026-09-02 with prompt `25b78769-d22e-4e5f-ae22-212e1b364bc5`: HomoFidelis INT8 loaded successfully and failed at KSampler because the active Comfy Desktop Python process lacked `PYTORCH_ENABLE_MPS_FALLBACK`. Immediate repair restarted the idle instance with the variable present; CPU fallback is expected to be slower than native MPS.

### MIX-003 — Repository backlog and Codex coordination protocol

- Status: Completed
- Priority: High
- Claimed by: `main` — backlog implementation task
- Claimed at: 2026-09-02T01:11:25Z
- Completed at: 2026-09-02T01:13:26Z
- Summary: Establish this versioned backlog and require every Codex development task to add, claim, update, verify, and complete its work item.
- Requirements:
  - Add the backlog workflow to `AGENTS.md`.
  - Preserve completed work in an archive.
  - Add a test that protects the backlog and coordination instructions.
- Acceptance:
  - [x] `BACKLOG.md` contains the defined statuses, priorities, item fields, and initial feature items.
  - [x] `AGENTS.md` requires backlog consultation, duplicate checks, claims, handoffs, verification, and abandoned-claim cleanup.
  - [x] A repository test detects removal of the backlog or mandatory protocol.
  - [x] Required repository checks pass.
- Verification: `node --test test/backlog-protocol.test.js`; `node --check server.js`; `node --check public/app.js`; `node --test` — 1,270 passed, 0 failed, 1 skipped.
- Notes: Bootstrap item for the process it introduced. A concurrent item addition was preserved and its ID collision resolved before completion.

### MIX-005 — Isolate model-discovery fixture from host Desktop settings

- Status: Completed
- Priority: High
- Claimed by: `main` — backlog implementation task
- Claimed at: 2026-09-02T01:12:56Z
- Completed at: 2026-09-02T01:13:26Z
- Summary: Prevent the isolated model-discovery fixture from inheriting real Comfy Desktop model directories from the developer machine.
- Requirements:
  - Give the fixture an explicit temporary home, environment, and platform.
  - Preserve the production discovery behavior.
- Acceptance:
  - [x] The focused model-discovery suite passes on a Mac with populated Comfy Desktop shared models.
  - [x] The complete repository test suite passes.
- Verification: `node --test test/model-discovery.test.js test/backlog-protocol.test.js`; `node --test` — focused suites passed 11/11 and full suite passed 1,270 with 0 failures and 1 skip.
- Notes: Discovered while verifying MIX-003. The prior fixture implicitly read the host user's Desktop settings. Renumbered from MIX-004 after a concurrent task added the permanent Visual Elements MIX-004 item.
