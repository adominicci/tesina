## Purpose

Provide a dormant local-inference boundary that contains native process and
transport failures, protects student text, and can be verified independently
from model installation, learning-interface behavior, and model quality.

## ADDED Requirements

### Requirement: Hidden optional runtime and honest capability

The runtime SHALL expose a versioned, discriminated capability with ready, busy,
and unavailable states. Unavailable reasons SHALL distinguish unsupported
platform, unsupported hardware/runtime compatibility, sidecar absent, and model
not installed. Capability checks SHALL neither start a process nor download or
generate anything. Normal product builds SHALL contain no enabled model entry,
model installation/generation control, test-provider selection, or test-result
route. Runtime failures SHALL leave editing, spelling, deterministic coaching,
persistence, APA validation, preview, and export available with unchanged
authority. Optional runtime compatibility SHALL require macOS 13.3 or later on
Apple Silicon/Intel or Windows 10 or later on x64; the application SHALL retain
its existing macOS 12 support independently.

#### Scenario: Normal application has no runtime or model

- **WHEN** a normal application checks capability without installed runtime or
  model artifacts
- **THEN** it returns the applicable unavailable reason, starts no child,
  performs no download, and exposes no new learning control

#### Scenario: Older supported application platform

- **WHEN** Tesina runs on macOS 12
- **THEN** optional inference reports unsupported hardware/runtime compatibility
  while the existing application remains usable

#### Scenario: Proof fixture cannot be selected by product code

- **WHEN** a normal webview submits fixture selectors, executable paths, model
  paths, or proof-only command names
- **THEN** the request is rejected without starting a child or returning fixture
  data

### Requirement: Correlated task-specific boundary

The service SHALL accept only `writingCoach` and `groundedQuiz`, each paired with
its own typed input and success shape. Every accepted request SHALL carry a
caller-created random UUID request ID and exactly one of a nonnegative safe
integer document revision or an immutable source-snapshot ID. Every accepted
request's success or error SHALL repeat its original task and correlation
unchanged. An uncorrelatable malformed envelope SHALL receive only a fixed
invalid-request rejection without reflecting submitted values. The client
SHALL reject mismatched task, request ID, revision, or snapshot responses and
SHALL expose no generic completion, prompt, endpoint, header, file, or shell
operation.

#### Scenario: Task mapping is checked statically

- **WHEN** a consumer assigns a quiz request/result to a writing-coach call, or
  supplies both correlation alternatives
- **THEN** compile-time contract verification rejects the cross-pair or
  ambiguous correlation

#### Scenario: Valid task completes

- **WHEN** either task succeeds or fails after acceptance
- **THEN** its result contains only that task's success shape or a stable error
  code, with the original correlation intact

#### Scenario: Completion belongs to another source

- **WHEN** a returned task, request ID, revision, or snapshot differs from the
  pending request or the consumer's current source
- **THEN** the result is discarded without a document mutation or displayed
  finding

### Requirement: Bounded structurally validated task data

Requests SHALL use document language `en` or `es`, include at most 16,384 UTF-16
code units of source text in total, and fit within 96 KiB of serialized UTF-8
JSON. Writing-coach input SHALL contain one immutable passage; quiz input SHALL
contain one to four named immutable source passages and a requested count of
exactly five or ten questions. Empty text, unsafe numbers, duplicate source identities,
unrecognized fields, and invalid correlation SHALL fail before transport.
Responses SHALL fit within 256 KiB and parse as exactly one schema-valid JSON
result without trailing content or duplicate object keys. Writing-coach results
SHALL contain at most 32 issues using the existing six categories, bounded
explanation/question strings, and valid UTF-16 ranges within the supplied
passage. Quiz drafts SHALL contain exactly the requested count, four options,
one correct index, and the canonical per-component source-span shape. Every
supplied span SHALL refer to its named input snapshot, lie within its source,
and avoid splitting a surrogate pair. Text fields SHALL be limited to 2,048
UTF-16 code units and each provenance component to one through four spans.
These checks SHALL establish transport/shape integrity only; LT-05 SHALL not
claim semantic grounding, teaching quality, or approval to display drafts.
The native generation context SHALL be limited to 4,096 tokens with one active
slot and at most 2,048 generated tokens. Native tokenization of the complete
serialized input, including special tokens, SHALL reject more than 2,047 prompt
tokens before generation. The service SHALL not truncate, shift away, or
silently omit source text to fit that limit.

#### Scenario: Input exceeds a declared limit

- **WHEN** an otherwise valid request exceeds the text, byte, count, identifier,
  or schema limits
- **THEN** a correlated invalid-request error is returned without sending input
  to the sidecar

#### Scenario: Untrusted response attempts smuggling

- **WHEN** output is oversized, contains duplicate keys, trailing JSON, unknown
  fields, malformed tuples, an invalid category, or a foreign/out-of-range span
- **THEN** the entire result is rejected as invalid-response and no partial
  draft is returned

#### Scenario: Structurally valid bilingual fixture

- **WHEN** an English or Spanish fixture returns a valid task-specific draft
  containing non-ASCII text and supplementary Unicode characters
- **THEN** its task and source identities survive transport exactly and its
  UTF-16 ranges validate against the original text without normalization

#### Scenario: Byte-bounded input exceeds token context

- **WHEN** the entire serialized input passes text/byte validation but tokenizes
  above the prompt budget
- **THEN** the correlated request fails before generation and no shortened
  source is submitted

### Requirement: Native-only sidecar authority

Only the native boundary SHALL select executable/model artifacts, start the
child, hold its authentication secret and address, and make model requests.
Selected artifacts SHALL come from native-owned approved bundle/registry
entries; webview strings SHALL never select a path, executable, environment,
argument, model, or endpoint. Symbolic-link/reparse escapes, unknown artifacts,
and failed integrity checks SHALL prevent launch. No broad shell or additional
filesystem capability SHALL be granted. Private runtime state SHALL use an
isolated subtree of the existing webview-denied `.tesina-native` namespace and
SHALL not reuse or modify backup control records.

#### Scenario: Compromised webview requests arbitrary execution

- **WHEN** a webview submits a command, model path, executable path, alternate
  endpoint, header, or environment override
- **THEN** native validation rejects it without file access or child launch

#### Scenario: Private runtime artifact is requested through filesystem APIs

- **WHEN** the webview attempts to read or write the runtime's private subtree
- **THEN** filesystem capabilities deny access while existing backup and essay
  access behavior remains intact

### Requirement: Authenticated isolated loopback transport

The sidecar SHALL bind only IPv4 loopback on an ephemeral port, use a new
unpredictable secret per child generation, disable its web UI, agent/tools,
MCP proxy, slot inspection, remote model retrieval, and logging, and accept only
the native boundary's fixed bounded task protocol. Native requests SHALL bypass
environment proxies, prohibit redirects, and use the selected numeric address.
Before transmitting a secret or student text, the boundary SHALL prove that the
established server-side connection belongs to its exact unreaped child and
SHALL transmit only over that same connection. Every new connection SHALL be
proved independently; an authentication response alone SHALL not establish
server identity. An unrelated listener SHALL never be killed or accepted as
the owned sidecar; startup SHALL make at most three attempts within 30 seconds. Loaded
inference and model endpoints SHALL reject absent/wrong authentication. Public
health, loading, and preflight responses SHALL contain no text, model path,
secret, or generated content.

#### Scenario: Another process owns a discovered or reused address

- **WHEN** a competing listener receives the connection or the child exits and
  its listener address is reused before connection
- **THEN** the boundary sends neither secret nor student text to that listener,
  terminates only its own failed child, and either starts a fresh generation
  within the bound or returns startup-failed

#### Scenario: Unauthenticated caller probes the runtime

- **WHEN** a caller requests inference or model information without the current
  secret after loading
- **THEN** access is denied; a separate public health/preflight/loading response
  contains only non-sensitive readiness/error information

#### Scenario: Host environment enables extra runtime behavior

- **WHEN** the parent environment contains proxy, remote model, agent/MCP,
  library-search, or runtime override variables
- **THEN** they cannot alter the child arguments, enabled features, artifact
  resolution, or transport destination

### Requirement: Webview isolation with compatible public reference lookup

The webview SHALL have no generic native HTTP permission and no CSP permission
to connect to the sidecar. Existing DOI, ISBN/author, and public HTTP(S) URL
autofill SHALL use a bounded native GET-only reference transport with fixed
headers and no caller-supplied body, method, credentials, or proxy. That
transport SHALL accept only ports 80/443 and globally routable destination
addresses, validate all resolved addresses and every redirect target, and bind
the actual connection to the validated resolution without DNS rebinding. It
SHALL reject private, loopback, link-local, unspecified, multicast, local-host,
and special-use destinations including alternate numeric and IPv4-mapped IPv6
forms. It SHALL enforce a 10-second total timeout, at most five redirects,
bounded URLs, and at most 4,000,000 decoded body bytes. Private/intranet URL
lookup SHALL now return the existing recoverable autofill failure. Public
lookup mapping, DOI preference, existing error categories, and the reference
editing UI SHALL remain unchanged.

#### Scenario: Existing public reference lookup succeeds

- **WHEN** DOI, ISBN with author metadata, or a public page with citation metadata
  is looked up through the normal reference interface
- **THEN** the same mapped reference and DOI preference are obtained through the
  bounded native transport

#### Scenario: URL disguises a local destination

- **WHEN** a URL uses localhost, numeric aliases, mapped IPv6, a hostname resolving
  privately, mixed public/private DNS answers, a rebound address, or a redirect
  to a non-public destination
- **THEN** no connection reaches that destination and the existing autofill
  failure is returned

#### Scenario: Webview attempts the removed general HTTP route

- **WHEN** the webview invokes the generic HTTP plugin or directly fetches the
  sidecar origin
- **THEN** capability or CSP enforcement denies the operation before sidecar
  access

### Requirement: Single owned request and recoverable lifecycle

The service SHALL allow one active request and no unbounded queue. Competing
requests SHALL receive correlated busy errors. Cancellation SHALL target only
the matching pending UUID, produce at most one terminal cancelled result, stop
and reap the owned child within five seconds, and permit a later explicit
request to start a fresh generation with a fresh secret. A cancellation accepted
before request admission SHALL prevent that UUID from starting a child or
sending content when its run command arrives. Pre-admission cancellation and
terminal deduplication records SHALL share a maximum of 32 UUID records and a
120-second lifetime; live records SHALL not be silently evicted. A full record
table SHALL reject additional unknown cancellation/admission with busy rather
than acknowledge a cancellation it cannot honor. Completed cancellation IDs
SHALL be no-ops, and unknown IDs SHALL not affect another request. Request execution SHALL have a
120-second admission-to-terminal-decision deadline, including startup/retries,
tokenization, response transfer, and validation. Startup SHALL consume at most
30 seconds of that same budget. A terminal result SHALL be returned when the
decision is made; owned-child cleanup SHALL complete within an additional five
seconds, during which new requests receive busy. Timeout, invalid response, child crash, and confirmed
out-of-memory failures SHALL terminate and reap the owned generation before
another launch. Unknown crashes SHALL not be mislabeled out-of-memory. No
request SHALL automatically replay student text after failure.

#### Scenario: Cancellation races with completion

- **WHEN** the matching cancel is accepted while the request is still pending
- **THEN** exactly one cancelled terminal result wins, later completion is
  ignored, and the owned process exits within five seconds

#### Scenario: Foreign cancellation arrives

- **WHEN** cancellation names another pending/completed/unknown UUID
- **THEN** it does not stop or change the current request

#### Scenario: Cancel arrives before its run command

- **WHEN** cancellation of a valid UUID is accepted before the matching run is
  admitted and the run arrives within the record lifetime
- **THEN** the run returns its correlated cancelled result without process
  launch or content transport

#### Scenario: Cancellation IDs attempt unbounded allocation

- **WHEN** unknown cancellations fill the bounded record table
- **THEN** additional records receive busy without evicting an accepted live
  cancellation, and expired records are reclaimed

#### Scenario: Child crashes and user retries

- **WHEN** the child exits unexpectedly during generation and a later explicit
  request is submitted
- **THEN** the first request reports crash, cleanup completes, and the later
  request can use a fresh child without replaying the failed input

### Requirement: Shutdown follows application ownership

Normal application quit, updater installation that exits the application, and
updater relaunch SHALL stop and reap the exact owned sidecar before proceeding
past the explicit shutdown boundary. Actual parent-process death SHALL also
cause owned sidecar cleanup within five seconds through a lifetime mechanism
independent of application destructors. macOS window hide SHALL preserve the
existing app-in-Dock convention and SHALL not be treated as application quit.
Shutdown preparation SHALL stop new requests; if update/quit preparation fails
and the application remains open, it SHALL be possible to resume future
explicit requests without preserving the cancelled generation. Cleanup SHALL
never target a process discovered by name, port, or a stale PID file.

#### Scenario: Application is forcibly terminated

- **WHEN** the proof harness terminates the verified parent during startup or an
  active request while its cleanup mechanism remains intact
- **THEN** the recorded owned sidecar exits within five seconds and an unrelated
  sentinel process remains alive

#### Scenario: Windows updater exits inside installation

- **WHEN** the existing updater reaches its Windows install call
- **THEN** inference shutdown has completed before the call that can terminate
  the app, and no post-install callback is required for cleanup

#### Scenario: macOS main window hides and reopens

- **WHEN** the close control hides the main window and the Dock reopens it
- **THEN** the application keeps its existing hide/reopen behavior and does not
  misreport a normal hide as an application crash or quit

### Requirement: Content-free diagnostics

Application logs, sidecar stdout/stderr retention, and error payloads SHALL
contain no student/source text, generated text, authentication secret, model
path, or paper path. Runtime failures SHALL expose only closed error codes and
accepted correlation data. Production child output SHALL not be retained or
forwarded into logs. Diagnostics SHALL use fixed event names, bounded numeric
measurements, and non-content status codes; raw request/response/error objects
SHALL not be logged.

#### Scenario: Sidecar emits sensitive failure output

- **WHEN** the fake sidecar emits unique source, generated-text, secret, and path
  canaries on stdout/stderr or in malformed response/error fields
- **THEN** captured application logs and returned error payloads contain none of
  those canaries and sidecar output has not been retained as a log artifact

### Requirement: Provenance-bound packaging and distinct evidence layers

Runtime artifacts SHALL be pinned by target, upstream version/commit, exact
source URL, byte count, SHA-256, license, and dependency notices. Installation
or packaging verification SHALL reject mismatched bytes and unsafe archive
members before executable use. No moving release tag/URL, opportunistic upstream
build, or weight download SHALL enter normal PR CI. Native artifact verification
SHALL be path-filtered and weight-free; live model acceptance SHALL remain
separate and explicitly authorized. LT-05 SHALL use a non-shipping proof flavor
for runtime packaging until both platforms' applicable capability gates pass.
Successful fake-process tests SHALL not be reported as real runtime, minimum-OS,
model quality, signing, or release acceptance.

#### Scenario: Pinned archive is replaced upstream

- **WHEN** downloaded archive bytes do not match the committed digest/size or
  contain an unsafe member
- **THEN** packaging stops before execution and uses no replacement release

#### Scenario: Normal PR changes only UI or documentation

- **WHEN** an unrelated PR runs ordinary checks
- **THEN** it downloads no runtime/model and compiles no upstream inference
  runtime

### Requirement: End-to-end platform evidence uses the actual boundary

Acceptance SHALL exercise the TypeScript client in the platform webview,
registered native commands, production validation/proxy/lifetime code, and a
separate fake executable speaking the accepted HTTP protocol on both macOS and
Windows. Fixture selection and sensitive observability SHALL exist only in a
non-shipping proof harness. Evidence SHALL record commit SHA, OS/architecture,
webview version, fixture version, owned process identities, scenario outcomes,
and elapsed cleanup times. Mock-only transport tests SHALL not satisfy this
end-to-end requirement. Missing platform/package evidence SHALL remain pending
and SHALL prevent an LT-05-complete claim.

#### Scenario: Both tasks pass the real fake-process path

- **WHEN** each platform runs English and Spanish writing-coach and quiz fixtures
  including both five-question and ten-question drafts
  through its webview and native IPC
- **THEN** the actual spawned fake process receives the bounded authenticated
  request and the webview receives only its correlated validated task result

#### Scenario: A test replaces native transport with a mock

- **WHEN** a unit test proves a client or parser contract without launching a
  process through native IPC
- **THEN** that result is recorded only as unit evidence and leaves the platform
  end-to-end gate unfulfilled
