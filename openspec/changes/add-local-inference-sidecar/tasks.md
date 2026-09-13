## 1. Approval, threat model, and native provenance gates

- [x] 1.1 Obtain actual approval of this complete OpenSpec before implementation,
  including public-only/80–443 reference retrieval, optional macOS 13.3 runtime
  floor, guardian/socket ownership, and narrowly promoted native dependencies;
  verify a recorded user approval identifies this change and distinguishes it
  from roadmap approval and redistribution/release authorization.
- [x] 1.2 After approval, record a focused threat-to-test table covering
  compromised webview, loopback cross-talk/port reuse, arbitrary paths/commands,
  stale processes, oversized input/output/context, response smuggling, logs,
  crash/update recovery, and artifact tampering; verify every threat maps to a
  spec scenario and E1–E8, and run the canonical challenge if the estimated
  cohesive implementation exceeds 20 files or 1,000 handwritten changed lines.
- [ ] 1.3 Record exact locked versions, crate source/checksums and licenses for
  native dependency promotions, and the three b10809 asset URLs/digests/sizes
  plus pinned MIT, LLVM OpenMP, BoringSSL, and complete embedded/UI/dependency
  notices; verify every component is accounted for or explicitly blocked.
  Unknown/incompatible binary licensing must stop real-runtime package execution,
  acceptance, and redistribution; fake-process implementation may proceed under
  its separate approval. Static inspection/download alone is not clearance.

## 2. Typed correlated boundary and bounded drafts

- [x] 2.1 Write failing TypeScript contract/client tests, then add task-specific
  request/result unions and the provider client; verify compile-time rejection
  of writing-coach/quiz cross-pairs, wrong output shapes, and dual correlation,
  plus exact correlation validation for both languages and both identity axes.
- [x] 2.2 Write failing Rust boundary tests, then add closed native request/result
  types and side-effect-free capability checks; verify malformed/unknown fields,
  UUID/snapshot bounds, empty/duplicate sources, safe integer/UTF-16 boundaries,
  all capability reasons, and the production empty model resolver without child
  startup or network access.
- [x] 2.3 Write failing response fixtures, then implement bounded duplicate-key
  and typed draft validation; verify exactly-one-JSON parsing, 32-level depth,
  byte/string/count limits, five/ten-question quiz results, canonical quiz
  tuple/provenance, source identity and
  surrogate-safe ranges, no partial results, and static error-only diagnostics.

## 3. Real fake executable and verified native transport

- [ ] 3.1 Add the test executable and independent protocol fixtures before
  connecting production code; verify it binds `127.0.0.1:0`, reads only the
  expected generated key, implements health/models/tokenize/completion, and
  deterministically exercises success, delay, loading, malformed output, crash,
  and canary output without weights or upstream compilation.
- [ ] 3.2 Write failing native process tests, then add fixed artifact resolution,
  cleared environment, null output handles, and exact launch switches; verify
  injected paths/arguments/environment and symlink/reparse escapes cannot select
  an artifact, OS/architecture incompatibility is recoverable, `--ctx-size 4096`,
  `--parallel 1`, `--no-context-shift`, and disabled UI/tools/MCP/offline/logging
  settings reach the fake unchanged.
- [ ] 3.3 Write failing real-socket ownership tests on each platform, then add
  child listener discovery and ESTABLISHED reverse-four-tuple ownership proof;
  verify a competing listener, reused address, child exit, denied introspection,
  and wrong owner receive no key or body bytes, while the exact unreaped child's
  established stream succeeds (E2).
- [ ] 3.4 Add the HTTP/1 proxy over that same verified stream with failing tests
  first; verify no automatic reconnect/proxy/redirect/pooling, fixed endpoints,
  health versus authenticated endpoint behavior, bounded headers/body/deadlines,
  the single 120-second admission-to-terminal budget (startup capped within it),
  2,047-token prompt rejection before generation, exact token-array submission,
  no source truncation, and correlated task-specific results through the fake
  (E1/E3/E6).

## 4. Owned lifetime, concurrent cancellation, and application exits

- [ ] 4.1 Write failing Windows lifetime tests, then create the child atomically
  in a kill-on-close job using `PROC_THREAD_ATTRIBUTE_JOB_LIST`; verify atomic
  creation failure leaves no child, job/process handles are not inherited, and
  forced parent exit during launch and generation cleans up within five seconds
  while an unrelated sentinel survives (E5).
- [ ] 4.2 Write failing macOS lifetime tests, then add the fixed pre-Tauri guardian
  mode and sole-writer lifeline; verify descriptor/control validation, EOF before
  spawn and during startup/generation, no writer inherited into helper/sidecar,
  exact unreaped child termination/wait, helper exit, and the five-second bound
  with sentinel survival (E5).
- [ ] 4.3 Write failing concurrent IPC tests, then implement single-owner state
  transitions and the bounded cancellation/deduplication table; verify cancel
  before run/admission, during startup/read, terminal races, foreign IDs,
  duplicate calls, 32-record saturation, 120-second expiry with injected time,
  no live-record eviction, one terminal result, and fresh-secret restart only
  after a later explicit request (E4).
- [ ] 4.4 Write failing lifecycle integration tests, then attach idempotent
  shutdown preparation to existing safe-close/updater paths and native exit;
  verify cleanup precedes Windows install and other relaunch, true quit cleans
  up, macOS hide/reopen remains unchanged, failed update/quit resumes idle,
  persistence safe points retain their ordering, and no broad name/port/PID-file
  cleanup is added (E5).

## 5. Close webview network and private-file escape paths

- [ ] 5.1 Write failing reference transport tests, then add the native public
  GET-only boundary using a controlled resolver/connector; verify URL/port/body
  bounds, credential/header/method rejection, all public-address exclusions,
  IPv4-mapped IPv6/numeric forms, mixed DNS answers, DNS rebinding, local interface
  addresses, each redirect hop, proxy environment, decompressed byte limits,
  and total timeout without reaching the loopback trap (E7).
- [x] 5.2 Migrate only the existing autofill transport and remove the generic
  HTTP plugin grant/registration after failing compatibility tests; verify
  DOI preference, ISBN/author handling, public HTTP(S) HTML metadata, timeout and
  existing error categories remain equivalent, and private/intranet/nonstandard
  port references return the documented recoverable failure (E7).
- [ ] 5.3 Register the narrow runtime/reference commands and preserve the
  `.tesina-native` deny boundary; verify actual platform-webview attempts to use
  generic HTTP, direct sidecar fetch, arbitrary commands/paths, and private FS
  APIs are denied, while backup namespace and ordinary persistence contracts
  still pass (E7).
- [ ] 5.4 Add canary tests through real process output and malformed response
  paths; verify source/generated strings, key, model/paper paths, and raw native
  errors never appear in captured app logs or error payloads, and production
  sidecar stdout/stderr are neither forwarded nor retained (E6).

## 6. Cross-platform proof app and native artifact preparation

- [ ] 6.1 Build a non-shipping proof flavor that imports the actual TypeScript
  client in each platform webview, invokes registered native commands, and
  launches the fake through production lifecycle/proxy code; verify E1/E2/E4/E5/E6
  on macOS and Windows including five/ten quiz counts without mocking the
  transport, and record SHA, OS/CPU,
  webview, fixture version, process identities, elapsed cleanup, and outcomes.
- [ ] 6.2 After the license gate is cleared for the selected payload, add pinned
  archive preparation and proof-only native resource directories; verify all
  three digest/size pins, malicious archive/traversal/link rejection, member
  inventory, complete server dylib/DLL closure, notices, architecture selection,
  and the observed macOS 13.3 floor (E8).
- [ ] 6.3 Add a narrowly path-filtered, weight-free artifact verification job and
  fixed packaged version/help smoke; verify only runtime/native/manifest/proof
  paths trigger downloads, unrelated docs/UI do not, no job builds llama.cpp or
  downloads weights, normal installers have no runtime/proof selector, and both
  platform proof bundles resolve the pinned resources correctly (E8).

## 7. Final evidence, scope, and implementation handoff

- [ ] 7.1 Run the final applicable repository gates once on the completed diff:
  `deno task check`, `deno task test`, relevant format/lint, locked Rust
  check/tests, full platform E1–E8 proof and package smoke, and strict OpenSpec
  validation; verify exact-head results and separate code failures from platform
  or licensing blockers instead of treating a missing run as success.
- [ ] 7.2 Record acceptance against all eight canonical LT-05 task groups and
  every spec requirement, preserving separate source/static/fake-IPC/package/
  physical-platform/model evidence; verify no model install/consent, live AI UI,
  production rubric, semantic-grounding claim, pure-package change, essay
  persistence mutation, broad permission, or unrelated refactor entered the diff.
- [ ] 7.3 Only at the authorized implementation PR boundary, apply synchronized
  per-change versions and the single CHANGELOG release note, and obtain the
  repository review/approval required for external actions; verify the actual
  target/diff and report unresolved gates. Do not mark LT-05 complete, archive,
  commit, push, merge, publish, release, or redistribute from proposal readiness
  alone.
