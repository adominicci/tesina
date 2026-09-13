## Context

See `proposal.md` for motivation and
`specs/writing-coach-experience/spec.md` for the observable contract. The
existing `bilingual-writing-coach-engine` is a pure, synchronous TypeScript
package surface under `apps/desktop/src/lib/learning/coach/`; it accepts an
immutable text snapshot, document language, absolute UTF-16 origin, and
protected spans, then returns ordered issues with stable message descriptors.
It deliberately owns neither UI strings nor editor integration.

`EditorScreen.svelte` currently owns the active essay, document language,
editor lifecycle, preview state, autosave, APA Check, spelling, and citation
environment. `Editor.svelte` constructs the single editor through
`createTesinaEditor`. Separately, `EditorScreen.svelte` renders one
`$tesina-editor-addon` alias: that alias selects the spelling experience in its
proof configuration and a no-op component otherwise. It is not a general
multi-addon registry and cannot be replaced without breaking spelling proof.
Paraglide owns UI-locale rendering, while citation formatting and authored
document text follow the document language. The selected prototype-C decision
establishes a dedicated Study workspace with explicit Write/Study modes and a
fixed source passage; its optional model and quiz concepts remain future work.

The integration therefore crosses Svelte state, ProseMirror extraction and
range mapping, deterministic engine invocation, localization, and accessibility
without creating a new document or persistence contract.

## Goals / Non-Goals

**Goals:**

- Keep engine analysis, editor mapping, UI rendering, and ephemeral interaction
  state as separate typed seams.
- Make every displayed issue traceable to one immutable paragraph snapshot and
  one exact current ProseMirror range.
- Preserve normal editor, APA Check, spelling, preview, export, autosave, and
  undo behavior by making Study a read-only consumer of editor state.
- Make stale-result rejection and session cleanup explicit enough to test with
  fake clocks and deterministic fixtures.

**Non-Goals:**

- Generalize a framework for later model, quiz, analytics, or persistence work.
- Change the engine rule set, evaluator, issue schema, ProseMirror schema,
  essay schema, APA authority, citation format, or export format.
- Infer student intent, authorship, factual correctness, or citation sufficiency.

## Decisions

### 1. Mount one essay-scoped controller and expose an explicit view mode

`EditorScreen.svelte` will own an in-memory `"write" | "study"` mode and one
Writing Coach controller keyed to the mounted essay ID. The mode defaults to
Write on every mount. A two-option control remains reachable in the editor
title bar. Study replaces the paper canvas and writing-side controls with a
dedicated workspace, while Write continues to own the existing editor,
spelling, references, APA Check, preview, and export controls. Entering preview
uses Write mode and clears transient coach emphasis; Study is never layered on
top of preview.

The editor remains mounted while Study is shown so its current state and undo
history remain intact, but it is hidden from the accessibility tree and cannot
receive pointer or keyboard input. The Study component receives immutable view
data and action callbacks rather than the editor object. Leaving Study without
`Edit this passage` restores the normal Write surface without moving the editor
selection.

This follows prototype C and keeps the two contexts legible. A coach popover in
the writing toolbar was rejected because it would compete with APA Check and
would not provide the fixed reflective workspace. A persisted per-essay mode
was rejected because Study state is explicitly session-only.

### 2. Arm analysis only after first Study entry and schedule it with a bounded debounce

The essay-scoped controller has a small explicit state machine:
`idle`, `analyzing`, `issues`, `no-current-issues`, and
`unavailable-for-current-text`. Before first Study entry it accepts snapshot
updates but starts no timer and runs no analysis. First entry analyzes
immediately. Thereafter a document revision starts a trailing 300 ms timer and,
for a continuous burst, a 1,000 ms maximum timer measured from the burst's
first change. Whichever fires first consumes the latest complete snapshot and
cancels both timers.

Each run is identified by `{ essayId, revision, documentLanguage,
citationEnvironmentVersion, snapshotId, generation }`. The citation extension's
monotonic plugin-state version is the canonical citation/reference-environment
identity: it increments for document changes and for the existing
`apa:external` refresh transaction used after reference-library or language
changes. Publication requires exact equality with the controller's current
identity after extraction and analysis; a mismatch discards the whole
generation. Language changes, reference changes, external citation refreshes,
and extraction failures clear issues and fixed sessions before scheduling the
replacement bounded run. Essay changes and teardown cancel timers and
invalidate the generation before any new controller mounts.

Although the engine is synchronous today, generation tokens are retained
because extraction and Svelte scheduling can interleave with editor updates;
they also prevent a later asynchronous adapter from weakening the contract.
Running on every keystroke was rejected as unnecessary work. An unbounded
trailing debounce was rejected because continuous typing could prevent the
workspace from ever becoming current.

### 3. Extract one immutable eligible paragraph at a time with a UTF-16 source map

A pure desktop adapter will walk the current ProseMirror document and emit
`CoachPassageSnapshot` values only for paragraph nodes whose ancestors place
them in body, abstract, appendix, list, or blockquote content and not inside an
excluded node. Eligibility is decided from node types and ancestors, never from
displayed CSS or prose heuristics. Title-page fields, headings, keyword lines,
tables, figures, equations, generated reference content, and labels are
excluded as specified.

Each snapshot contains:

- a stable per-revision passage ID;
- the full display text in document language;
- a UTF-16 offset map from every snapshot boundary to the corresponding
  ProseMirror position, with noncontiguous boundaries marked invalid;
- the document-language, document-revision, and citation-environment identities;
  and
- protected UTF-16 spans for structurally sourced inline content.

Authored text nodes contribute their original code units directly. Citation
atoms contribute the same rendered text produced from the live citation
environment and document language, and their entire contributed range is
protected. Their boundary map points around the atom, but no interior citation
offset is navigable. Hard breaks contribute a newline only when both adjacent
boundaries remain exact. Protection is driven by an explicit allowlist of
sourced node/mark types present in the current schema. At this change's base,
the allowlist contains the `citation` node and the Tiptap StarterKit `link`
mark; the schema has no identifier node or mark. Consequently plain URL-like
text without the `link` mark and all identifier-like plain text are ordinary
authored text. If a sanctioned identifier node/mark is added before
implementation, it may join the explicit allowlist, but textual shape alone
never protects or excludes content. Passage construction never normalizes
case, whitespace, Unicode, URLs, or identifiers.

The adapter calls the engine separately for each passage with
`documentStart: 0`; returned issue offsets are passage-relative UTF-16 ranges.
It then validates the observed substring and both mapped boundaries before
producing an editor-facing range. If any issue in a generation is invalid,
the entire generation becomes unavailable instead of publishing a partial list.
This preserves the engine contract while avoiding a synthetic cross-paragraph
document whose separators could produce false findings.

Using `doc.textBetween()` alone was rejected because it cannot preserve rendered
citation text or an exact position for atomic inline nodes. Reading text from
the DOM was rejected because presentation timing and accessibility markup are
not a document contract.

### 4. Compose a sibling controller with a schema-free editor plugin

`EditorScreen.svelte` will own the coach controller as a sibling of the existing
`$tesina-editor-addon` component. It passes a typed coach bridge through
`Editor.svelte` into `createTesinaEditor`, which installs a dedicated
schema-free ProseMirror plugin in the existing extension list. The plugin
reports document and `apa:external` transactions, exposes the citation plugin
version, maps active issue/suppression ranges, and owns an optional transient
decoration for `Edit this passage`. It adds no node, mark, persisted metadata,
or history transaction. The `$tesina-editor-addon` alias and
`SpellingExperienceEditorAddon.svelte` remain untouched and mounted exactly as
before, so spelling continues to receive its existing props and editor instance.
A mapped range is valid only when both boundaries remain contiguous and the
current substring still equals the stored snapshot substring.

`Edit this passage` revalidates the current essay, revision, mapped range, and
substring immediately before switching to Write. On success it dispatches only
a selection transaction, scrolls the selection into view, and focuses the
editor. On failure it switches to Write, clears the fixed session, and emits the
localized stale-source status without selecting a nearby range. The decoration
clears on the events listed in the spec and supplements, rather than replaces,
the native selection.

Searching for the observed text was rejected because repeated text makes the
target ambiguous. Storing a coach mark in the document was rejected because it
would affect history, persistence, schema, and export.

Replacing or wrapping `$tesina-editor-addon` was rejected because it is a
single build-time spelling seam, not a composable runtime extension point.
Installing the plugin directly from the Study component was rejected because
the component must not own the editor or outlive its essay-scoped controller.

### 5. Model fixed sessions and suppressions with stable, in-memory identities

The controller converts each validated engine issue into a `MappedCoachIssue`
whose identity is scoped to exactly one analysis generation and retains the
engine issue, passage snapshot, mapped range, and generation. Display order is
exactly passage document order followed by engine issue order; the UI never
reranks by category or severity.

Selecting an issue copies its immutable mapped issue into a fixed session.
Background analysis may update counts, but cannot replace the session's passage
or question. Source-touching transactions, language change, essay switch, or
teardown invalidate it. Previous/Next explicitly choose a new issue and create
a new fixed session.

Dismiss and Not helpful create a distinct `CoachSuppression` identity that does
not retain or reuse the mapped issue's generation key. It contains the mapped
range plus source text, category, explanation/question message IDs, and a
canonical serialization of their typed parameters. The action kind is retained
only in live controller memory so the UI can behave consistently during the
click and is never emitted as an event. Transaction mappings carry an untouched
record into later revisions, including when an unrelated earlier edit shifts
the range. A transaction that touches, deletes, splits, or makes its source
range noncontiguous removes it. On the next generation, suppression rematches
only when the newly emitted issue has the mapped range, substring, category,
message IDs, and canonical parameters recorded by the suppression. All records
disappear on citation-environment change or with the essay-scoped controller.

Clearing all suppression on any unrelated edit was rejected because it would
make the session actions unreliable. Persisting a content hash was rejected
because identical prose elsewhere could suppress the wrong finding and because
the feature explicitly has no persistent preference contract.

### 6. Render typed engine descriptors through an exhaustive Paraglide adapter

A pure rendering adapter in the desktop UI layer will exhaustively switch over
the six category values and all current explanation/question message IDs,
passing typed parameters to dedicated Paraglide messages. Engine code does not
import messages or receive UI locale. The active Paraglide locale renders
controls, status, accessibility text, categories, explanations, and questions;
the immutable passage and `observedText` parameter remain document-language
source text.

Focused contract tests enumerate the engine unions and both message catalogs so
a new descriptor cannot fall through to a raw ID. UI-locale changes rerun only
this adapter. Document-language changes invalidate snapshots and run the engine
again. No runtime English/Spanish branching is allowed outside Paraglide.

Embedding final strings in the engine was rejected because it mixes document
and UI locale and would make LT-04 responsible for engine wording. Generic
string interpolation keyed at runtime was rejected because missing translations
would not be exhaustively checked.

### 7. Treat accessibility and responsive behavior as controller/component contracts

The mode control uses a native, keyboard-operable selection pattern with a
programmatic label and visible selected state. User-triggered Study entry moves
focus once to the workspace heading or current issue heading; background
analysis never moves it. One polite live region receives a structurally deduped
status value for state/count/position changes. Exact source emphasis uses
semantic text plus a non-color-only visual treatment and accessible labeling.

The Study layout uses one responsive content column that can grow into a
source-and-question arrangement only when space permits. Controls wrap, source
text uses overflow-safe wrapping, and no minimum width exceeds 320 CSS pixels.
Animations and smooth scrolling are disabled under `prefers-reduced-motion`.
Tests cover keyboard/focus/live-region behavior, reduced motion CSS, long
English and Spanish text, and narrow-window overflow.

### 8. Preserve feature boundaries with explicit dependency and non-interference tests

The allowed runtime dependency direction is:

`EditorScreen / Study component -> experience controller and adapters -> pure
coach engine`.

The engine remains free of Svelte, ProseMirror, Paraglide, Tauri, persistence,
network, model, APA-check, and export imports. Existing LT-03 boundary tests will
be narrowed only as needed to distinguish the now-authorized desktop
registration from forbidden imports inside the engine graph. Automated
before/after fixtures will compare persisted essay JSON, APA results, export
eligibility, and representative sanctioned export bytes while coach state
exists. Focused spies will additionally prove that viewing, navigating,
dismissing, and marking Not helpful issue no persistence, network, telemetry,
editor-content, APA, preview, or export calls. Manual proof is reserved for
real assistive-technology behavior and narrow visual layout. The ordinary
editor transaction remains the only route by which a student's later revision
changes the essay.

Creating a shared learning-tools service was rejected because LT-04 has one
deterministic consumer and no approved model or quiz surface to generalize.

## Risks / Trade-offs

- **[Citation rendering or editor positions drift between extraction and use]**
  → Capture the citation plugin version and document revision with each
  snapshot, invalidate on `apa:external`, validate observed substrings and
  boundaries at publication and navigation, and fail the whole generation
  closed.
- **[A 1,000 ms maximum timer analyzes during continuous typing]** → Analysis is
  synchronous, pure, and restricted to eligible paragraphs; generation and
  revision checks prevent stale publication, and later edits schedule the next
  bounded run.
- **[Mapping suppressions across transactions adds state complexity]** → Keep
  the plugin schema-free, model mapping as pure functions, and remove records on
  any touched or ambiguous source instead of guessing.
- **[Keeping the editor mounted while hidden could expose duplicate focusable
  content]** → Use an inert/hidden container in Study and assert keyboard and
  accessibility-tree isolation in component tests.
- **[Deterministic rules can still be unhelpful]** → Use neutral language,
  preserve Not helpful as a private session action, never claim correctness,
  and retain LT-03's reviewed evaluator gate without adding telemetry.
- **[Study can be mistaken for APA validation]** → Keep its navigation,
  terminology, counts, styling, and tests separate from APA Check and exclude
  coach results from preview/export eligibility.

## Migration Plan

1. Add failing pure tests for extraction/mapping, scheduling, session state,
   suppressions, and locale descriptors before integrating Svelte.
2. Add the EditorScreen-owned sibling controller and schema-free editor plugin
   behind the explicit mode control; keep Write as the default and preserve the
   spelling alias and existing editor path.
3. Add the Study workspace, Paraglide messages, accessibility behavior, and
   focused integration/non-interference tests.
4. Automate English/Spanish locale, lifecycle, mapping, essay-switch, preview,
   APA/spelling, persistence, export-eligibility, and representative export-byte
   proofs. Collect manual evidence only for real screen-reader, focus/live-region,
   reduced-motion, and 320 CSS-pixel layout behavior.

Rollback removes the mode control and its desktop integration. Because no
schema, stored data, dependency, Tauri command, or migration is introduced,
existing essays require no data rollback and remain readable throughout.

## Approval Decisions

The following decisions are intentionally proposed for approval with this
change; altering one changes the observable contract or task breakdown:

1. Eligible scope is authored paragraph prose in body, abstract, and appendix,
   including list and blockquote paragraphs; titles, headings, keywords, tables,
   figures, equations, and generated references remain excluded.
2. Analysis is dormant until first Study entry, then remains armed for that
   mounted essay session with a 300 ms trailing and 1,000 ms maximum debounce.
3. Study uses the full extracted paragraph as its fixed source passage, while
   `Edit this passage` selects only the exact issue substring.
4. Dismiss and Not helpful intentionally have the same session-only visibility
   lifetime; Not helpful records nothing beyond transient controller state.
5. Study replaces the paper workspace rather than appearing beside or over it;
   the editor remains mounted but inert so its history and state are preserved.
6. URL/identifier exclusion is structural and YAGNI: protect only sanctioned
   citation, link, or identifier nodes/marks present in the current schema;
   plain lookalike text remains authored prose and no recognizer is introduced.
