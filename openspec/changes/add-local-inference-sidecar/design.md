## Context

See `proposal.md` for the motivation and approval decisions. This design is
based on main `91e0d963ba5db447c1322c8f999b3a31f762b300` and the canonical LT-05
plan. `lib.rs` owns native registration and process state. The existing
`autofill/client.ts` is the only application consumer of the globally registered
HTTP plugin; its wildcard capability bypasses the otherwise restrictive CSP.
`backup_directory.rs` already owns private records under `.tesina-native`, and
capabilities deny the entire namespace to the webview.

`AppLayout` hides the window on macOS and exits on other platforms. The updater
already flushes persistence before Windows `install()`, which can exit inside
that call, or before relaunch elsewhere. The existing `RunEvent` callback only
handles macOS reopening. No local-model installation authority exists.

## Goals / Non-Goals

**Goals:** One state owner, a typed draft transport, verified child/socket
ownership, bounded failure handling, and a real fake-executable proof path.
Native platform differences stay behind the same observable contract.

**Non-Goals:** An extensible provider framework, model downloader/catalog,
semantic grounding evaluator, production prompts/rubrics, new learning UI,
background retries, automatic regeneration, or protection against a malicious
administrator or arbitrary software already controlling the native app process.
The data shapes below are structural transport contracts; later approved tasks
remain responsible for semantic validation and permission to display output.

## Decisions

### 1. Keep task authority and mutable state in the native runtime

Add `src/lib/local-ai/types.ts` and a small client. Add the Rust `local_ai`
module with contract/state, process/supervision, and proxy responsibilities.
`LocalInferenceProvider` retains the canonical `capability`, generic `run`, and
`cancel` signatures; commands implement those operations plus a narrow
idempotent shutdown-preparation operation used only by application lifecycle
callers. No webview operation can resume an arbitrary child or choose paths.

The native owner holds one generation, one optional active request, its exact
child/process handles, and a bounded correlation record table. No global
provider registry, per-document service, inference persistence, or shared pure
package is introduced. The only native model resolver returns no installed
entry in ordinary builds. A non-shipping proof build injects a fake executable
and synthetic model path through Rust construction, never through IPC or a
production environment switch.

Capability evaluation is side-effect-free, ordered as unsupported platform,
unsupported architecture/OS floor, sidecar absent, model not installed, then
ready/busy. `ready` means native prerequisites are available, not that a model
passed quality review. Production has no enabled model and cannot generate.
The proposed optional runtime floor is macOS 13.3; the app floor stays 12.

Alternative: an external Ollama/provider abstraction adds an endpoint/lifecycle
owner and cannot prove this task's managed-child seam. Reusing the deterministic
coach's final issue type would mix Paraglide descriptors with generated content;
reuse its `CoachCategory` and `DocLocale` types, not its analysis implementation.

### 2. Use explicit draft types and immutable correlation

The canonical `InferenceCorrelation` union remains unchanged: UUID `requestId`
plus exactly one safe integer `documentRevision` or `sourceSnapshotId`. IDs for
source/snapshot are 1–64 ASCII letters, digits, hyphens, or underscores; request
IDs are UUIDs. This makes reflected correlation bounded and non-content-bearing.
The client creates the UUID before invoking Rust. Rust owns the accepted copy
and attaches it to results; no model output supplies correlation.

| Task | Input | Structurally valid draft output |
| --- | --- | --- |
| `writingCoach` | `documentLanguage`, one `passage: {sourceId, snapshotId, text}` | `{issues: [{from, to, category, explanation, learningQuestion, source: "local-model"}]}` |
| `groundedQuiz` | `documentLanguage`, `sources: [{sourceId, snapshotId, text}]`, `questionCount: 5 \| 10` | `{questions: GroundedQuestion[]}` using the canonical four-option/provenance shape |

Ranges are source-local UTF-16 half-open intervals. When the outer correlation
uses `sourceSnapshotId`, each passage belongs to that same snapshot identity;
source IDs distinguish passages. Revision-correlated requests still include
immutable passage snapshot IDs so output validation never reads a changing
document. Writing-coach ranges identify the one passage; quiz provenance names
the matching input source and snapshot. No text normalization occurs.

Enforce the spec's 16,384 UTF-16/96 KiB input and 256 KiB output limits, four
sources, exactly five or ten requested questions, 32 issues, 2,048-unit output strings, and
one-to-four ordered spans per provenance component. Reject empty sources,
duplicate source identities, invalid ranges/surrogate boundaries, additional
task fields, and non-finite/unsafe numbers. The quiz result must contain the
requested count. These checks do not decide if a question is supported by the
text or an observation is educationally appropriate. Nothing displays these
drafts in normal builds.

The limits are conservative transport budgets, not a claim that the candidate
model accepts every maximum combination: 16,384 source units bound selected
material; 96 KiB independently bounds escaped IPC JSON; 256 KiB bounds draft
allocation even with provenance; at most ten questions and 32 issues keep arrays
finite. The joint byte cap still applies when individually valid fields would
exceed it together. The later model contract may accept smaller requests but
cannot silently loosen these security limits.

Five/ten quiz counts preserve the canonical LT-08 contract. LT-05 does not claim
that a full 5,000-word LT-08 source fits a single 4,096-token context. Any later
source-to-request batching belongs to LT-08's approved design; this boundary
rejects excess and never truncates or claims full-source coverage implicitly.

Rust deserializes a typed closed envelope, validates before awaiting process or
network work, and wraps every post-admission error with the accepted task and
correlation. Uncorrelatable malformed IPC gets the fixed `invalid-request` code
without echoing input. The client validates the returned union and requires
exact correlation equality before resolving. Its `run` generic and negative
compile-time fixtures reject task cross-pairs and ambiguous correlation.

Error codes are closed: `unsupported-platform`, `unsupported-hardware`,
`sidecar-absent`, `not-installed`, `busy`, `cancelled`, `invalid-request`,
`invalid-response`, `startup-failed`, `timeout`, `out-of-memory`, `crash`, and
`shutting-down`. There is no free-text detail. Unknown abnormal exit is `crash`;
`out-of-memory` requires an explicit recognized native/protocol signal, never
substring inference from discarded stderr.

### 3. Prove ownership of the connection before sending its secret

Start the child with `--host 127.0.0.1 --port 0`. The OS assigns the ephemeral
port; neither logs nor a reserve/release port race supplies authority. Discover
the exact child's loopback listener with macOS `proc_pidinfo`/`proc_pidfdinfo`
socket information or Windows `GetExtendedTcpTable` owner-PID listener rows.
Keep the owned child unreaped during this operation so its PID cannot be reused.

Listener discovery is only a candidate address. Open a TCP stream without
writing bytes, then verify an ESTABLISHED server-side socket with the reverse
four-tuple of that stream and the exact unreaped child's PID. Only after that
proof may the bearer token or request body cross that same stream. Every new
stream repeats proof. Socket introspection failure, child exit, tuple mismatch,
or deadline expiry closes the stream and fails closed. There is no automatic
reconnect, proxy, redirect, connection pooling, or fallback connector.

Use the locked `hyper` HTTP/1 client connection API over the verified Tokio
stream, via `hyper-util::rt::TokioIo`. This preserves an established stream and
uses a mature HTTP parser. It avoids both a hand-written HTTP parser and an
ordinary `reqwest` call that would create a different, unproved connection.
Limit HTTP headers to 16 KiB, response frames while reading to 256 KiB, and JSON
nesting to 32. Disallow response upgrades and redirects. Use `Connection: close`
for a single request per verified stream.

Readiness uses a bounded health response plus an authenticated `/v1/models`
probe on verified connections, with a fixed native model alias and no response
body logging. Native `POST /tokenize` tokenizes the entire serialized task
input with special tokens; validate its bounded integer token array and reject
more than 2,047 prompt tokens before generation. Send those same token IDs as
the completion prompt, so a later tokenization cannot silently change the
source. The 4,096-token context reserves 2,048 output tokens plus one guard
token. The fake implements this tokenizer response for deterministic tests;
real token budget suitability is not yet a model-quality claim.

Task generation uses only `POST /completion`, `stream: false`,
`n_predict: 2048`, `cache_prompt: false`, and a native-owned task JSON schema.
The proof serializer encodes the typed task input as JSON prompt data; this is
protocol plumbing, not an approved production prompt or teaching rubric. The
production empty model resolver prevents live use. The sidecar completion
envelope's `content` must decode into the task's draft. Reject duplicate JSON
keys recursively before structural conversion, trailing values, and unknown
task fields; never deserialize through a duplicate-collapsing generic object
and then claim duplicate-key validation.

The total deadline is 120 seconds from admission to terminal decision, including
startup/retries, tokenization, response transfer, and validation. Startup has
at most 30 seconds of that same budget and at most three child generations. Discovery
and readiness use at most 100 checks, each bounded by the remaining deadline;
connection-ownership proof uses at most 20 checks in 200 ms, always clipped to
the remaining request budget. Return the terminal result when decided, then
allow at most five additional seconds to terminate/reap the generation. The
service stays stopping/busy until cleanup completes; it cannot start another
request in that interval. Timeout never triggers automatic replay. These fixed initial transport bounds
are not a performance claim for a real model.

Evidence: [Microsoft endpoint ownership API](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)
and [Apple socket/process structures](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h)
support the OS inspection approach. Feasibility of the implemented connector
on supported machines is an explicit E2E gate, not established by those API
descriptions. An API key alone authenticates the caller to a server; it cannot
prove the server belongs to Tesina.

### 4. Supervise the exact child through cancellation, quit, and parent death

Use a small native state machine: idle, starting, running, stopping, and shutdown
prepared. One owner serializes admission and terminal transitions. A competing
request receives busy; no content queue is retained. Once a matching cancel is
accepted, cancelled wins exactly once, the HTTP connection closes, and the
generation is terminated/reaped within five seconds. Starting a fresh process
on the next explicit request is simpler and stronger than claiming upstream
cooperative cancellation proves model work stopped.

IPC may deliver cancel before run. Keep at most 32 UUID records shared by
pre-admission cancellations and completed-request deduplication, expiring after
120 seconds. Cancellation before admission reserves a tombstone; admission
consumes it into a correlated cancelled terminal result without dispatch. Do
not evict live records. Full capacity rejects new unknown cancel/admission as
busy so an accepted cancellation cannot be lost. Duplicates are idempotent;
unknown cancellation never targets another active request. Record expiration
is opportunistic on each operation, not a background service. The TypeScript
client also remembers local cancellation and does not dispatch a locally
cancelled request that has not yet been invoked.

Thirty-two records allow short IPC cancellation bursts while bounding memory
for a service with only one active request. The 120-second retention matches
the longest accepted request lifetime; IDs are unique and never reused, and
the client-side cancellation guard prevents a delayed local dispatch after its
tombstone has expired. A cancellation accepted after native dispatch must reach
the same native admission within that deadline or the client abandons the run.

**Windows:** Create a non-inheritable Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Use `CreateProcessW` with
`PROC_THREAD_ATTRIBUTE_JOB_LIST` and an explicit inherited-handle list so the
child enters the job atomically during creation; only the app holds the job
handle. Keep the process handle until wait completes. Closing/terminating that
owned job provides cleanup on application death, including updater termination.
If atomic assignment fails, do not launch an uncontained child. Never use
suspended-create followed by assignment: a parent crash between those calls
can orphan the suspended process. This is supported on Windows 10+ by
[Microsoft's process-attribute contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and the [documented race analysis](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812).

**macOS:** Use one fixed internal guardian mode of the same signed application
executable, entered before Tauri/single-instance initialization. The application
is the sole writer of a private anonymous lifeline pipe. The guardian receives
only its read end and a bounded native launch/control channel, owns the
unreaped `llama-server` child, and reports the child's identity through that
private channel. It must not inherit a lifeline writer into itself or the
sidecar. EOF before or after spawn initiates exact-child termination and wait;
normal shutdown uses the same path. The guardian exits after reaping. No PID
file, process-name search, or launchd service is introduced.

The guardian's control envelope contains native-resolved generation/artifact
information only, is size-limited to 8 KiB, and accepts exactly start/stop state
transitions; EOF or malformed control data stops its child. It is not exposed
as an IPC command or general command-line launcher. Its entrypoint verifies
the expected inherited descriptors and native parent relationship. Normal app
arguments cannot supply executable/model paths. Signals target only the live,
unreaped child the guardian spawned; after wait, no later signal uses that PID.

Apple documents [pipe creation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/pipe.2.html)
and [EOF reads](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/read.2.html).
The guardian design uses those semantics; it is not a macOS kernel kill-on-parent-
death facility. It covers application death while the guardian remains intact.
Simultaneous forced destruction of both app and guardian is a stated limitation
against same-user/native-process control, not a cleanup guarantee. Tests must
kill the app during pre-spawn, startup, and active transport windows.

Normal termination first requests graceful child exit, waits up to two seconds,
then terminates the verified owned generation and waits within the overall
five-second budget. Failed cleanup stops further inference and fails the gate;
it never triggers a broad kill. On child exit, the active result is translated
and no request automatically restarts.

Add shutdown preparation alongside existing persistence-safe shutdown calls:
before the Windows updater's `install()`, before other relaunch, and before
non-macOS close/true quit. Native exit handling is a backstop; the OS lifetime
mechanism covers abrupt exit. A failed install/quit resumes the inference state
to idle without restarting the cancelled generation, alongside the existing
failed-shutdown recovery. macOS hide remains hide; it does not prepare shutdown.

### 5. Close the HTTP-plugin escape without rebuilding reference autofill

Remove the generic HTTP plugin registration and webview permission, migrating
only `autofill/client.ts` transport. A small native `reference_fetch` module owns
GET destination validation and a closed result `{status, body}` or stable error;
existing TypeScript DOI/ISBN/HTML extraction and reference mapping remain.
Requests carry only URL and response kind (`json` or `html`), never headers,
body, method, authentication, proxy, or redirect policy. Restrict explicit ports
to 80/443, strip fragment, reject credentials, and bound URLs to 4,096 bytes.

Use existing locked `url` parsing and `reqwest` for public HTTP(S), with
environment proxies and automatic redirects disabled. Resolve every hop
natively; reject any non-global/local result, including mixed DNS answer sets,
and pin the approved address set into that hop's client resolver. The pinned
resolution must govern the actual connection, including retries among approved
addresses; no later default DNS lookup is allowed. Preserve the original host
for TLS validation and Host headers. A new redirect receives the entire check
again, including scheme, port, DNS, credentials, and 10-second total deadline.
Never forward credentials or arbitrary upstream-request headers.

The address predicate is explicitly public-only: reject IPv4 loopback, RFC1918,
CGNAT, link-local, unspecified, multicast, reserved/documentation and other
special-use ranges; reject IPv6 loopback/unspecified, ULA, link-local, multicast,
documentation and transition/special-use ranges; normalize IPv4-mapped IPv6
before checking. Reject local interface addresses even if globally numbered.
Tests own a fixed address corpus plus controlled resolver/connector failures;
they must not rely only on string matching of `localhost`.

Keep the existing 10-second timeout, fixed user agent/Accept values, DOI
preference, author limit, and error mapping. Cap decoded HTML and JSON at
4,000,000 bytes while streaming, including decompression; allow at most five
redirects. Preserve public HTTP for legacy academic sites. The intended
compatibility change is loss of private/intranet and loopback URL lookup; it is
explicitly part of proposal approval. Ports beyond 80/443 also become unsupported.
Do not refactor the reference form, metadata parsers, or unrelated fetch paths.

Alternative: URL-pattern denies on the wildcard HTTP plugin miss DNS aliases
and rebinding, and would leave generic headers/methods available. Retaining
the plugin and relying on the bearer token fails the no-direct-webview invariant.

### 6. Keep secrets and runtime output out of every logging path

Generate a fresh secret from two independent UUIDv4 values per child generation
(244 random bits using the existing OS-backed UUID dependency). Supply it only
through the cleared child environment's `LLAMA_API_KEY`, never command arguments,
files, URLs, IPC, or logs. After `env_clear`, allow only required OS environment
values and native-owned temporary directories; do not pass inherited `LLAMA_*`,
`AIP_*`, proxy, model-fetch, or dynamic-library override variables.

The fixed runtime switches are `--host 127.0.0.1 --port 0 --no-webui --no-agent
--no-webui-mcp-proxy --no-slots --offline --log-disable --ctx-size 4096
--parallel 1 --no-context-shift`, plus a native-resolved local model and fixed
alias. The pinned `common/arg.cpp` defines these exact context/parallel switches.
Reject token-budget excess before completion and reject any response indicating
input truncation; source is never shortened to fit. No MCP config,
model URL/HF selector, tools, media, or router-management fields are accepted.
`--offline` is a fetch setting, not an OS network sandbox. `--no-agent` alone
does not erase inherited MCP configuration, hence clearing the environment.

Null stdout and stderr at spawn; `--log-disable` alone does not cover every
upstream print. Do not capture raw process output to diagnose failure. Fixed
application events may contain elapsed time, status/error code, and counters;
do not derive Debug/log representations of input/result/native secret state.
Correlation IDs in error envelopes are validated identifiers, not log content.
Use `.tesina-native/local-ai/` only if private transient files are necessary;
the initial secret/lifeline/state is memory/handle-owned and creates no setting,
model manifest, or backup record. Symlink/reparse escapes are rejected before
artifact use, and the webview retains the existing namespace deny.

Pinned upstream evidence: [argument/environment controls](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/common/arg.cpp),
[HTTP auth/readiness/cancellation](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/tools/server/server-http.cpp),
and [server endpoint registration](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/tools/server/server.cpp).
Loaded inference/models return 401 without the key; loading can return 503
before auth, `/health` is public, and OPTIONS is public with no content.
Tests treat these as separate non-sensitive responses, not a universal-401 rule.

### 7. Pin complete native artifacts in a separate proof packaging path

Pin llama.cpp `b10809`, commit
`5266f24da75dc449bd56cbed7addb9c8e4a6a73e`, published 2026-09-04. The stable
v0.4.0 pointer resolves to that build, but packaging uses the exact asset URLs
below. GitHub reports the release mutable, so SHA-256/size is the authority.
All three downloaded archives were independently SHA-256 checked during this
proposal research; no binary was executed and no model was downloaded.

| Native target | Exact source | Bytes | SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | <https://github.com/ggml-org/llama.cpp/releases/download/b10809/llama-b10809-bin-macos-arm64.tar.gz> | 11123196 | `7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2` |
| macOS x64 | <https://github.com/ggml-org/llama.cpp/releases/download/b10809/llama-b10809-bin-macos-x64.tar.gz> | 11175330 | `13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6` |
| Windows CPU x64 | <https://github.com/ggml-org/llama.cpp/releases/download/b10809/llama-b10809-bin-win-cpu-x64.zip> | 18407457 | `9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5` |

Source of release metadata: [exact release API](https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10809).
Runtime license: [MIT at the pinned commit](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/LICENSE).
The Windows archive includes `libomp.dll` and `LICENSE-LLVM-OpenMP` (Apache-2.0
with LLVM exception); it does not include the main MIT notice, which packaging
must add from the pinned source. Preserve all accompanying dependency notices.
Do not assume the main runtime license covers every sibling library.

Pinned cpp-httplib CMake metadata selects BoringSSL `0.20260903.0`; the
[exact BoringSSL notice](https://github.com/google/boringssl/blob/0.20260903.0/LICENSE)
is Apache-2.0, and inspected macOS server libraries contain BoringSSL symbols.
Disabled web UI does not remove embedded code or its redistribution obligations.
The complete embedded/UI/transitive binary license inventory remains
**unverified**. Record every bundled component's exact notice/source in the
packaging manifest before real-runtime package acceptance. Unknown or
incompatible licensing is a stop condition, not an accepted runtime dependency.
The fake-process implementation can be reviewed separately from this gate;
it grants no permission to redistribute these prebuilt archives.

Both downloaded macOS `llama-server` and `libllama-server-impl` Mach-O slices
declare minimum OS 13.3. This is static binary evidence, not a runtime test.
Package separate native resource directories for arm64 and x64 inside the
universal proof app; select the compiled/native architecture in Rust. Preserve
the complete required dylib closure (including linked RPC libraries) and
relative loader layout; do not lipo or strip arbitrary linked dependencies.
Windows uses a dedicated CPU-x64 resource directory with required DLLs.
Use a proof-only Tauri resources overlay for these directories, not an
unconditional `externalBin` entry that breaks every normal build.

The artifact preparation script verifies archive digest and size before any
extraction/execution, rejects traversal/absolute paths and escaping links, and
records a per-member size/digest inventory. Internal dylib symlinks may be
accepted only when their final target stays inside the pinned extracted root.
Copy only the server's complete dependency closure and notices to the proof
bundle. Verify loader paths/dependencies, native architecture and OS floor,
then checksum the prepared payload before signing. The signed app must verify
as a whole; do not compare post-signing Mach-O bytes with upstream bytes because
signing changes those files. No runtime binary downloads or upgrades occur in
the product. Later release integration will use its approved signed bundle.

Promote only already-locked Rust libraries needed for the implementation:
`hyper 1.10.1`, `hyper-util 0.1.20`, `http-body-util`, `bytes`, Tokio I/O/process
features, `reqwest 0.13.4`, and `url 2.5.8`; reuse `windows 0.61.3`, `libc`,
`uuid`, `serde`, `serde_json`, and `sha2`. Their exact crate source/digests remain
in Cargo.lock; use only the narrowly needed client/HTTP1/native API features.
Record the promoted versions and MIT/Apache-2.0 license metadata in the final
change, and fail the dependency/license check if resolution introduces an
unapproved license. No shell plugin or new JSON-schema framework is needed.

Add a narrowly filtered native verification job/workflow for changes in this
runtime, its proof fixtures, Rust dependencies, runtime manifests, or Tauri
packaging. It downloads the pinned small binaries only, never weights, and
performs archive/layout/notice plus packaged `--version`/`--help` checks through
a fixed native proof action. Full fake-process IPC tests use a compiled test
executable, not llama.cpp compilation. Unrelated docs/UI paths skip artifact
preparation. Real model/manual minimum-hardware quality acceptance stays outside
LT-05 and ordinary CI. Normal installers remain free of this runtime until the
separate capability/release gates authorize bundling it.

### 8. Make the E2E path and its limitations measurable

Compile a deterministic fake sidecar as a test executable with only the pinned
subset `/health`, `/v1/models`, `/tokenize`, and `/completion`. It binds port 0, reads the
per-process key from the same native environment path, validates the fixed
request shape, and supports native-harness-controlled fixture cases. It can
delay, crash, return malformed/oversized data, expose canary output, and report
safe request counters; it cannot be selected by shipping IPC.

Build a non-shipping platform proof app using existing native-proof conventions.
Its webview imports the actual TypeScript client and invokes the production
registered native commands. Rust injects the test artifact resolver but retains
the production process/ownership/proxy code. A separate runner observes exact
process handles/PIDs and an unrelated sentinel; fixture results are checked
against independent expected values. Record only scenario booleans, correlation,
counts/timing, and expected-output digests in evidence, not raw text or secrets.

| Evidence ID | Path exercised | Required assertions on macOS and Windows |
| --- | --- | --- |
| E1 | Webview → client → IPC → native proxy → spawned fake → result | Both tasks in en/es, five/ten quiz counts, Unicode/span fidelity, exact success/error correlation, no cross-task output |
| E2 | Actual OS socket discovery/connection proof + independent competing listener | Wrong PID/reused port/child exit fail before any bearer or body byte; same established stream is used after proof; introspection denial fails closed |
| E3 | Independent HTTP probes of fake/pinned protocol | Loaded unauthorized inference/models denied; health/loading/OPTIONS contain no sensitive data; UI/tools/MCP proxy absent/disabled |
| E4 | Webview IPC admission and concurrent cancellation + real fake | Cancel before run, during startup/read, completion race, foreign ID, saturated 32-record table, five-second exit/reap, next explicit request gets new generation |
| E5 | Native startup, lifecycle hooks, owned parent-death runner | Missing artifact/model, checksum failure, startup timeout, busy, child crash, forced parent death at each launch phase, normal quit, Windows pre-install shutdown, relaunch, failed-update resume, macOS hide/reopen; sentinel survives |
| E6 | Fake malformed protocol + production parser/log sinks | Byte/depth/header bounds, duplicate keys, trailing JSON, wrong tuple/span/task, invalid UTF-16, output/stderr canaries absent from logs/errors; no partial result |
| E7 | Webview denied generic fetch/FS/commands + native reference fetch | Actual capability/CSP denials, private-path denial, public DOI/ISBN/URL result parity, DNS/redirect/private/numeric/proxy adversarial cases cannot reach a loopback trap |
| E8 | Pinned artifact preparation + installed proof resources | Digests/notices/loader layout/architectures/minimum OS recorded; bundle launches only fixed version/help action; normal app contains no proof selector/model enablement |

E1/E2/E4/E5/E6 require actual native sockets and processes on both platforms,
not mocked trait results. E7 combines actual platform permission denial with
controlled resolver/connector integration and existing autofill mapping tests;
public endpoint live availability is not a CI dependency. A trusted native-only
fixture hook can pin a test origin for success responses; shipping requests
always enforce public-only resolution. No proof bypass is reachable from the
webview or compiled into the default product.

Use focused TS contract/client/autofill/updater tests while iterating. The final
approved implementation must pass `deno task check`, `deno task test`, relevant
format/lint, locked Rust checks/tests, both native E2E runs, package smoke, and
strict OpenSpec validation at the final diff. The evidence report must distinguish
API/source research, static archive inspection, fake process IPC, package launch,
physical minimum-platform tests, and real-model tests. At proposal time all
implementation/runtime/platform execution rows remain **pending**.

## Risks / Trade-offs

- Same-user native-process control can defeat a guardian or read process memory
  → the boundary targets compromised webview, malformed runtime, and unrelated
  loopback peers; no claim of an OS sandbox or administrator resistance.
- Socket ownership APIs may be denied or behave differently on a packaged host
  → fail closed and stop LT-05 completion until actual macOS/Windows proof passes;
  never weaken to an authenticated request on an unproved connection.
- The pinned binaries exclude macOS 12 and may expose further CPU/runtime limits
  → explicitly approve optional macOS 13.3 floor, retain app support, gate
  packaging and report unsupported states; no model eligibility claim yet.
- Removing generic HTTP changes private/intranet and unusual-port references
  → call out the deliberate compatibility change before implementation and
  retain existing public reference mapping/DOI preference tests.
- Lifecycle plus network containment may exceed 20 files/1,000 handwritten lines
  → estimate the final cohesive diff before coding and run the canonical size
  challenge before exceeding the threshold; do not omit security to fit a number
  or split types/tests from their working boundary.
- Runtime response shapes may change upstream → pin protocol/source/assets,
  reject invalid output, and require a new reviewed pin change instead of runtime
  updates. Asset checksums detect tampering but are not independent build
  reproducibility evidence.

## Migration Plan

1. Obtain approval for the complete validated OpenSpec, including public-only
   reference fetch, the optional macOS 13.3 floor, native dependency promotions,
   and the guardian/socket-ownership design. There is no implementation approval
   implied by the roadmap or by this artifact being present.
2. Implement the hidden contracts/fake-process seam and necessary HTTP/lifecycle
   migration together. Keep normal model resolution empty and proof paths gated.
3. Complete E1–E8 at the applicable final head and report missing physical or
   real-model evidence honestly. Update per-change version/release notes only
   at the later implementation PR boundary, not in this proposal phase.
4. Rollback removes the dormant runtime and proof packaging. Keep or revert the
   reference-transport migration as one coherent change; never restore a generic
   webview HTTP route while leaving an accessible sidecar enabled. No model,
   essay schema, or device setting has been created to migrate.

No material design choice is deferred as an open question. Approval and
execution evidence are pending gates with the failure behavior above.
