# Mix Studio end-to-end testing strategy

## Outcome

Create a repeatable release gate for the workflows Nathan depends on most, with special emphasis on Visual Elements and generation durability. Automated tests must never read, mutate, cancel, or submit work through the production `data/` directory or a live ComfyUI queue.

## Method

Use a testing pyramid:

1. Keep graph construction, prompt resolution, lifecycle transitions, and recovery decisions in fast `node:test` unit and integration tests.
2. Add a small Playwright browser suite for the journeys and browser/server contracts that source-regex tests cannot prove.
3. Run visual-quality and performance benchmarks separately against an explicitly selected disposable ComfyUI environment. These are acceptance tests, not brittle pixel snapshots.

Playwright is a development-only dependency; the production server remains zero-dependency.

## Safe test architecture

- Add `MIXBOX_DATA_DIR` support and require each E2E worker to start Mix against a new temporary data directory containing synthetic profiles and tiny media fixtures.
- Start Mix and a fake ComfyUI on random loopback ports. Never use `3300`, `3307`, `8188`, `8197`, or the endpoint in live settings.
- Implement a scriptable fake Comfy service for `/system_stats`, `/object_info`, `/prompt`, `/queue`, `/history/:id`, `/view`, `/upload/image`, `/interrupt`, and WebSocket progress/error events.
- Give every test a stable Mix job ID and scenario ID in logs, screenshots, traces, and fake-Comfy requests.
- Assert the guardrail at startup: abort if the resolved data path is the repository's real `data/` directory or the Comfy URL matches a configured live endpoint.
- Store only minimal generated fixtures in the repository; create temporary outputs per test and retain traces only for failures.

Proposed layout:

```text
test/e2e/
  fixtures/mix-test.js
  support/isolated-mix.js
  support/fake-comfy.js
  specs/create.spec.js
  specs/elements.spec.js
  specs/queue-recovery.spec.js
  specs/profile-isolation.spec.js
  specs/mobile-safari.spec.js
```

## P0 browser journeys

### Baseline Create and model transparency

- Enter an explicit framing prompt, choose 704×1056, seed, eight steps, and generate with no references or Elements.
- Assert the submitted graph and saved gallery metadata preserve prompt, seed, resolution, steps, selected model, and absence of references.
- Cover ordinary Turbo/Raw plus Character, Location, and Prop Element routing; the UI must state the effective model/workflow before submission and the gallery must retain it afterward.

### Visual Elements

- Upload a portrait image, verify an uncropped `contain` preview, assign a valid handle and each type, save, search, edit, and delete.
- Type and paste a known `@handle`; verify it becomes an accessible linked token and opens the correct Element.
- Remove an active Element from both the inline token and chip control; verify the authored prompt, persisted form state, and next request contain no stale reference.
- Create with a Character Element and assert identity routing uses an empty output latent at the requested aspect ratio rather than inheriting the source crop.
- Repeat for Location and Prop and assert their distinct conditioning instructions and workflow selection.
- Verify unknown handles remain literal text, duplicate handles fail clearly, missing assets offer recovery, and reference-capacity conflicts block before submission.
- Save a gallery result as an Element, delete the source result in the disposable fixture, and prove the Element still works from its durable copy.

### Queue to gallery

- Submit multiple jobs and verify ordered queue cards, progress, completion, gallery insertion, and exact metadata.
- Reload the browser and reconnect SSE while queued, running, and finalizing; cards must remain visible and must not duplicate.
- Verify a failed job exits the active state with a useful error while neighboring jobs continue.

### Profile isolation

- Create two disposable profiles and prove Elements, uploaded assets, prompts, queue details, and gallery items cannot cross profile boundaries.
- Exercise locked-folder visibility without calling destructive profile-deletion routes.

### Responsive and Safari behavior

- Run Chromium desktop plus WebKit at iPhone dimensions for Element creation/removal, prompt editing, sheets, focus restoration, scrolling, and browser reload.
- Keep one real iPhone Safari smoke pass in the release checklist because emulated WebKit does not cover iOS process suspension and keyboard behavior completely.

## P0 durability fault matrix

The following scenarios block release of MIX-006. Each starts with disposable data and a fake Comfy scenario, then asserts zero vanished jobs, at-most-one execution, and exactly one terminal gallery/history record per stable Mix job.

| Failure point | Expected recovery |
| --- | --- |
| Before Comfy submission | Durable intent remains queued and submits once after restart. |
| Request accepted but response dropped | Reconciliation finds the correlated prompt; Mix does not resubmit blindly. |
| Pending in Comfy when Mix exits | Order and ownership restore after Mix restarts. |
| Running when Comfy disconnects | Card becomes Waiting/Reconnecting and is never removed. |
| Comfy restarts and loses its queue | Mix verifies queue and history before one bounded resubmission. |
| Comfy completes while Mix is offline | Mix finalizes the existing output once after reconnect. |
| Mix exits during output download or DB save | Finalization resumes idempotently without duplicate media or gallery rows. |
| User cancels while disconnected | Cancellation survives restart and prevents later resubmission. |
| Configured Comfy port changes | Only the same correlated installation is adopted; unrelated servers are rejected. |

Apply the same lifecycle contract to image, edit, video, upscale, composite, Strength Hunt, and sequential/chunked workflows. Implement ordinary image first, then require every workflow family to opt into the same durable adapter before claiming full coverage.

## Release gates

- Every successful generation request is durably recorded before a remote submission can be lost.
- No test scenario makes a queued or running job disappear from `/api/queue` or the browser.
- A stable Mix job produces at most one Comfy execution and exactly one gallery/history result.
- Cancellation, FIFO order, profile ownership, and sequence/chunk relationships survive restart.
- Offline queue responses include locally durable work and a truthful connection state.
- Only prompts correlated to this Mix instance are adopted during recovery.
- `node --test`, the P0 fake-Comfy browser suite, and static accessibility checks pass.
- Character, Location, and Prop receive a recorded real-hardware acceptance run before Visual Elements is marked complete.

## Execution lanes and sub-agent ownership

Work in parallel only where file ownership is clean:

1. **Harness agent:** isolated data-root support, process lifecycle fixture, fake Comfy API/WebSocket, safety guardrails, and CI command.
2. **Journey agent:** Create, Elements, profile isolation, WebKit/mobile, and accessibility specs using the shared fixture.
3. **Resilience agent:** stable job IDs, failpoints, crash/reconnect matrix, idempotency assertions, and workflow-family contract tests.
4. **Lead integrator:** owns shared contracts, reviews all diffs, resolves overlaps, runs the complete suite, and performs the controlled real-hardware acceptance pass.

The harness lands first. Journey and resilience agents then build against its public fixture API in separate file sets. The lead does not accept source-regex checks as substitutes for browser behavior or lifecycle assertions.

## Rollout

1. Land the isolated harness and one baseline Create happy path.
2. Land all P0 Elements journeys and WebKit coverage.
3. Add durable job identity and the ordinary-image failure matrix.
4. Extend the durability contract to the remaining workflow families.
5. Add nightly extended browser tests and opt-in real-Comfy quality/performance benchmarks.
6. Promote P1 flows—management edge cases, Safari interruption, and save-as-Element variants—after the P0 gate is stable.

PR CI should run the fast `node:test` suite and fake-Comfy Chromium P0 tests. Nightly CI should add WebKit, the full fault matrix, and longer ordering scenarios. Real ComfyUI runs must remain manual or explicitly scheduled, require empty queues and disposable data, and never be a side effect of ordinary CI.
