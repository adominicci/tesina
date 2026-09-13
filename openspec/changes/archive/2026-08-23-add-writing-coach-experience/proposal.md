## Why

Tesina now has a reviewed deterministic bilingual writing-coach engine, but students cannot yet use its observations to reflect and revise. LT-04 turns that hidden engine into an optional Study workspace while keeping the normal writing surface focused and preserving APA Check as a separate authority.

## What Changes

- Add explicit Write and Study modes. Writing Coach opens in a dedicated Study workspace through navigation separate from APA Check, references, spelling, and export controls.
- Analyze eligible authored body prose with the essay's document language after a bounded debounce, while rendering all controls, explanations, questions, and status text through Paraglide in the current UI locale.
- Protect only citation, link, and identifier content that the current editor schema represents structurally. Plain URL-like or identifier-like text remains authored prose; Writing Coach adds no textual recognizer or heuristic.
- Present the selected deterministic issue as one fixed, exact source passage with its category, short explanation, and focused learning question. Let the student navigate back to the exact paper range, reflect, and revise in the editor; never generate, insert, or apply replacement prose.
- Cover all six deterministic categories: specificity, evidence, clarity, economy, repetition, and voice. Describe observable prose only, with no authorship, grading, misconduct, or APA-error language.
- Keep Dismiss and Not helpful as ephemeral session actions. They hide an unchanged finding only for the current essay session, reset when that finding's source text changes, and never persist, transmit, profile, or collect telemetry.
- Provide deterministic empty, analyzing, issue, and no-current-issues states; stale-result rejection on edits, language changes, citation/reference-environment changes, essay switches, and component teardown; and exact source navigation/highlighting without document mutation.
- Add keyboard, screen-reader, focus, live-region, reduced-motion, and narrow-window behavior, including non-interference proof for APA Check, spelling, persistence, preview, and export.
- Do not add title-page coaching, model/sidecar controls, local generation, selected-text AI review, quizzes, network access, persistence, telemetry, schema changes, export changes, automatic rewriting, or a visible claim that coach findings are APA requirements.

## Capabilities

### New Capabilities

- `writing-coach-experience`: Defines the explicit Write/Study interaction, deterministic coach presentation and navigation, ephemeral session actions, locale behavior, accessibility, and non-interference boundaries.

### Modified Capabilities

None.

## Impact

- New Svelte 5 Writing Coach workspace/panel, pure message adapter, ephemeral controller/state, ProseMirror extraction/navigation/highlight integration, Paraglide messages, and focused component/integration tests under `apps/desktop`.
- Focused changes to `EditorScreen.svelte`, an EditorScreen-owned sibling coach controller, and a schema-free ProseMirror plugin. The single `$tesina-editor-addon` alias remains owned by the spelling experience and is not replaced or multiplexed.
- No new dependency, Tauri command, native permission, network path, persistence field, essay schema/version change, APA-engine/export contract, model runtime, quiz surface, or telemetry sink.
