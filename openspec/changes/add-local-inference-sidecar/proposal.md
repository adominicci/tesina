## Why

Tesina needs a contained, testable runtime boundary before optional local-model
installation or generation can be introduced. LT-05 establishes that boundary
with a fake executable so process failures, untrusted responses, and webview
access cannot expose student text or disrupt deterministic writing tools.

## What Changes

- Add a hidden, typed local-inference provider for `writingCoach` and
  `groundedQuiz`, preserving task-specific request/result pairing and the caller's
  request ID plus document revision or immutable source-snapshot identity on
  success and failure.
- Give Rust sole ownership of an on-demand `llama-server` child, its fixed
  executable/model selection, ephemeral loopback address, per-process secret,
  bounded transport, cancellation, shutdown, and recovery. Missing installation,
  unsupported hardware, busy, cancellation, malformed output, out-of-memory,
  startup failure, and crash remain recoverable states.
- Close the existing general-purpose HTTP-plugin route around CSP. Move its sole
  reference-autofill consumer behind a bounded native metadata-fetch command
  that preserves DOI, ISBN, and public HTTP(S) URL lookup while rejecting
  non-public destinations, including DNS aliases and redirects. This deliberately
  removes private/intranet, loopback, and nonstandard-port URL lookup previously
  permitted by the wildcard plugin grant and requires approval with this
  proposal. The bounded
  public GET accepts a user-selected reference URL; inference commands expose no
  sidecar address/endpoint, secret, executable/model path, request headers, or
  arbitrary process control.
- Reuse the existing webview-denied `.tesina-native` namespace for any private
  runtime artifacts, with isolated local-inference ownership. Keep student and
  generated text, credentials, and private paths out of logs and errors.
- Prove the production Rust boundary against a deterministic fake executable on
  macOS and Windows: authenticated transport, correlation, bounds, cancellation,
  startup/port collision, normal quit, updater exit/restart, child crash, and
  application-process death. Preserve macOS window-hide behavior separately
  from actual application shutdown.
- Add narrowly path-filtered packaging verification for exact prebuilt runtime
  artifacts, recording target, version/commit, source URL, license/notices, and
  checksums before approval. Keep ordinary PR CI free of weights, upstream
  compilation, and live inference. Default installers must remain releasable
  while real runtime/platform capability evidence is pending.
- Propose macOS 13.3 as the minimum for this optional runtime, because both
  pinned macOS binaries and their server libraries declare that deployment
  target. Tesina's macOS 12 editing/export support remains unchanged; macOS 12
  reports unsupported hardware/runtime compatibility. This optional-feature
  floor is a material approval decision, not a claim that all platform gates
  have passed.
- Keep the runtime dormant in normal product use. This change adds no model
  downloader, enabled model registry entry, consent/settings UI, learning UI,
  live generation, task rubrics/prompts, semantic grounding validator, or essay
  persistence changes. Those belong to the later approved LT-06–LT-09 slices.

## Capabilities

### New Capabilities

- `local-inference-sidecar`: A hidden, correlated local-inference service with
  Rust-owned child lifecycle, authenticated bounded transport, webview isolation,
  recoverable failures, privacy controls, and deterministic cross-platform and
  packaging verification.

### Modified Capabilities

None. The existing deterministic spelling, writing-coach, editor, and release
capability requirements remain intact; LT-05 does not integrate generation into
those experiences.

## Impact

- `apps/desktop/src/lib/local-ai/` owns the TypeScript contract and Tauri client;
  `apps/desktop/src-tauri/src/local_ai/` owns runtime state, native validation,
  transport, and exact child cleanup. Pure `packages/` remain unchanged.
- Tauri command registration, process/updater exit integration, Cargo metadata,
  narrowly scoped capabilities, and packaging configuration require changes.
  Parent-process death requires a verified OS-backed lifetime mechanism; a Rust
  destructor or stale PID file alone is insufficient.
- `apps/desktop/src/lib/autofill/client.ts` and its native GET transport require
  the smallest necessary migration to remove unrestricted plugin HTTP access.
  Existing reference mapping, DOI preference, errors, and bounded public-page
  retrieval remain covered by focused compatibility tests.
- Fake-sidecar fixtures, TypeScript compile-time assertions, Rust integration
  tests, and explicit native/package checks provide acceptance evidence. Exact
  runtime provenance and dependency choices belong in the design; unverified
  macOS/Windows runtime capability, packaging, and parent-death behavior must be
  reported as pending rather than inferred from fake-provider success.
- Archive integrity and selected notices are verified research; the complete
  embedded/dependency license inventory is not yet cleared. Approval to implement
  the fake/runtime boundary does not authorize redistribution; any unknown or
  incompatible bundled license stops real-runtime packaging/redistribution.
- No version bump, implementation, release, model download, or roadmap-complete
  claim is part of this proposal artifact. Implementation starts only after the
  complete OpenSpec change passes strict validation and receives approval.
