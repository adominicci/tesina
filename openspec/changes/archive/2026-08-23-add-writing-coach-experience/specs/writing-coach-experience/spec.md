## Purpose

Defines an accessible, optional Study workspace where students inspect deterministic writing observations, reflect on focused questions, and return to the exact source passage to revise their own paper without changing APA authority or persisting learning state.

## ADDED Requirements

### Requirement: Explicit Write and Study modes
The editor SHALL expose an accessible two-mode control with `Write` and `Study` options. Write mode SHALL retain the normal paper, spelling, references, APA Check, preview, and export experience. Study mode SHALL replace the writing surface with a dedicated Writing Coach workspace for the active essay. Entering or leaving Study MUST NOT mutate the essay. Writing Coach navigation, label, count, tone, and status MUST remain separate from APA Check and MUST NOT present coach findings as APA errors, export warnings, grades, or misconduct evidence.

#### Scenario: Student opens Study mode
- **WHEN** the student activates Study from the Write surface
- **THEN** the dedicated Writing Coach workspace opens for the same essay and the normal paper remains unchanged

#### Scenario: Student returns to Write mode
- **WHEN** the student activates Write from the Study workspace
- **THEN** the normal writing surface returns with the same essay content, editor history, spelling behavior, APA Check state, preview behavior, and export behavior

#### Scenario: APA Check has issues
- **WHEN** APA Check and Writing Coach both have findings
- **THEN** each surface shows only its own count, terminology, navigation, tone, and actions, and neither count contributes to the other

#### Scenario: Spelling remains independent
- **WHEN** the student uses spelling without entering Study mode
- **THEN** existing spelling capability and correction actions remain available on the Write surface and no spelling issue or replacement control appears in Study

### Requirement: Optional bounded deterministic analysis
Writing Coach analysis SHALL remain idle until the student first enters Study for the active essay session. First entry SHALL analyze the current eligible authored-body snapshot immediately. After activation, document changes SHALL schedule deterministic analysis after 300 milliseconds without a new change, with a maximum wait of 1,000 milliseconds from the first pending change. Each scheduled run SHALL capture essay ID, document revision, document language, a canonical citation/reference-environment version or digest, extracted source snapshots, and an analysis generation. A result MUST be published only when all captured identities still match; otherwise it SHALL be discarded. Document-language changes, citation/reference-environment changes, external citation-refresh transactions, essay switches, controller destruction, and invalid extraction/mapping SHALL invalidate pending work and fixed source state, clear displayed issues rather than publish partial or stale findings, and schedule bounded reanalysis when the essay controller remains active.

#### Scenario: Coach has never been opened
- **WHEN** the student writes without entering Study during the essay session
- **THEN** no writing-coach analysis runs and normal writing behavior is unchanged

#### Scenario: Study opens for the first time
- **WHEN** the student first enters Study with a valid essay snapshot
- **THEN** the workspace enters an analyzing state and runs the deterministic coach immediately using the essay's document language

#### Scenario: Student types continuously after activation
- **WHEN** document changes continue without a 300-millisecond quiet period
- **THEN** analysis runs no later than 1,000 milliseconds after the first pending change and uses the latest complete snapshot available at that boundary

#### Scenario: Older generation finishes after an edit
- **WHEN** a result belongs to an essay ID, revision, language, citation/reference environment, snapshot, or generation that is no longer current
- **THEN** it is discarded without changing the visible issue list, selection, focus, document, or accessibility status

#### Scenario: Citation display environment changes
- **WHEN** reference data or an external citation-refresh transaction changes the rendered citation text while either an English or Spanish passage is pending or fixed in Study
- **THEN** the pending result and fixed passage are invalidated, Study enters analyzing, and bounded reanalysis publishes only a passage rendered from the current document language and citation/reference environment

#### Scenario: Extraction cannot preserve an exact mapping
- **WHEN** an engine issue cannot map contiguously from its immutable source snapshot to the same ProseMirror revision
- **THEN** that analysis generation fails closed with no partial findings or guessed navigation ranges

### Requirement: Eligible authored-passage boundary
LT-04 SHALL analyze authored paragraph text within body, abstract, and appendix sections, including paragraphs nested in lists and block quotes. It MUST exclude the paper title/title-page form, headings, keywords lines, tables and their cells/titles/notes, figures and their titles/notes, equations, generated reference pages, generated labels, and non-document chrome. Within an eligible paragraph, only citation, link, or identifier nodes or marks that are structurally represented by the current editor schema SHALL be preserved as protected sourced spans. Plain URL-like or identifier-like text without such structure SHALL remain authored prose. LT-04 MUST NOT add a textual URL/identifier recognizer or heuristic. The extraction SHALL retain a UTF-16 source map back to the exact ProseMirror revision and MUST NOT change the document.

#### Scenario: Authored body paragraph is eligible
- **WHEN** a paragraph in the body, abstract, appendix, list, or block quote contains eligible authored prose
- **THEN** its immutable text snapshot is analyzed with the document language and can produce exact mapped findings

#### Scenario: Non-prose surface contains a matching phrase
- **WHEN** a matching phrase appears only in a title-page field, heading, keywords line, table, figure, equation, generated reference, generated label, or application chrome
- **THEN** the Writing Coach experience does not analyze or display that phrase

#### Scenario: Citation appears inside a passage
- **WHEN** an eligible paragraph contains an inline citation
- **THEN** the fixed source passage preserves its rendered citation text, the corresponding engine range is protected, and no coach finding can target any part of that citation

#### Scenario: Structurally marked sourced content appears inside a passage
- **WHEN** the current editor schema represents citation, link, or identifier content with a sanctioned node or mark inside an eligible paragraph
- **THEN** extraction preserves that content, protects exactly its structural range, and uses no text-shape heuristic

#### Scenario: URL-like or identifier-like text has no structural mark
- **WHEN** authored prose contains plain text that resembles a URL or identifier but the current editor schema does not represent it with a sanctioned node or mark
- **THEN** that text remains eligible authored prose and is not excluded or protected because of its spelling pattern

### Requirement: Six localized deterministic categories
The Study workspace SHALL support exactly `specificity`, `evidence`, `clarity`, `economy`, `repetition`, and `voice`. It SHALL exhaustively map every engine explanation and learning-question descriptor to Paraglide messages. Controls, category labels, explanations, questions, empty/status text, and accessible names SHALL render in the active UI locale. Analysis and preserved source passages SHALL use document language, and quoted `observedText` parameters MUST remain byte-for-byte equivalent to the engine output. Changing UI locale SHALL rerender Study chrome and descriptors without rerunning analysis or changing the fixed source snapshot; changing document language SHALL end the fixed Study session and trigger a new analysis.

#### Scenario: Spanish document in English UI
- **WHEN** the essay document language is Spanish and the UI locale is English
- **THEN** analysis and the fixed passage remain Spanish while all Study controls, category labels, explanation, and learning question render in English

#### Scenario: UI locale changes during Study
- **WHEN** the student changes UI locale while an issue session is open
- **THEN** Study chrome and descriptor text rerender in the new UI locale while the issue range, category, document-language source passage, and analysis generation remain unchanged

#### Scenario: Descriptor mapping is incomplete
- **WHEN** any current or future coach message identifier lacks an English or Spanish Paraglide mapping
- **THEN** compile-time or focused contract verification fails rather than displaying a raw identifier or falling back to document language

#### Scenario: All categories are present
- **WHEN** deterministic fixtures produce one issue in each category
- **THEN** every category has distinct localized labeling and question-led presentation without authorship, grading, misconduct, or APA-error wording

### Requirement: Fixed question-led Study session
Selecting a finding SHALL open one Study session containing the immutable full source passage, a non-color-only emphasis of the exact issue substring, the localized category, one short explanation, and one focused learning question. The source passage and selected issue SHALL remain fixed until the student chooses another finding, returns to Write, the underlying source text changes, the document language changes, or the essay session ends. Study MUST NOT make the source editable, solicit or store a typed answer, generate an example, or offer acceptance/insertion of prose. Previous and Next controls SHALL move through the current unsuppressed issue order and wrap only when more than one issue exists.

#### Scenario: Student inspects a finding
- **WHEN** the student selects an issue in Study
- **THEN** the exact immutable passage remains visible with the issue text emphasized and one explanation/question rendered from the engine descriptors

#### Scenario: Student reflects
- **WHEN** the focused learning question is displayed
- **THEN** the workspace asks the student to think and revise but provides no answer field, generated answer, rewrite, replacement, Apply action, or insertion control

#### Scenario: Student navigates findings
- **WHEN** multiple unsuppressed issues exist and the student uses Previous or Next
- **THEN** the selected fixed passage changes to the prior or next issue in deterministic engine order and the control exposes its updated position accessibly

#### Scenario: Issue source changes outside the fixed session
- **WHEN** the exact underlying source range changes after the student returns to Write
- **THEN** the prior fixed session is invalidated and cannot be reopened as though it described the new text

### Requirement: Exact return-to-source navigation
The Study workspace SHALL provide an `Edit this passage` action that switches to Write mode, scrolls the current paper range into view, selects the exact mapped issue range, and places focus in the editor without changing text. A transient visual emphasis MAY accompany the selection but MUST use the current mapped revision, MUST be perceivable without color alone, MUST not enter the ProseMirror document or history, and MUST clear on selection change, source change, essay switch, preview entry, or component teardown. If the mapping is stale, the action SHALL return to Write without selecting or guessing a range and SHALL announce that the passage changed.

#### Scenario: Student chooses to edit
- **WHEN** the active issue still maps to the current editor revision and the student activates Edit this passage
- **THEN** Write mode opens, the exact issue substring is selected and scrolled into view, editor focus is restored, and no text or undo history changes

#### Scenario: Navigation range is stale
- **WHEN** the source passage changed before Edit this passage executes
- **THEN** Write mode opens without a guessed selection, the stale session clears, and a polite status announces that the passage changed

#### Scenario: Navigation highlight clears
- **WHEN** the user changes selection, edits the source, enters preview, switches essays, or leaves the editor
- **THEN** the transient coach emphasis is removed without affecting authored content or APA decorations

### Requirement: Ephemeral Dismiss and Not helpful actions
Each active finding SHALL offer separate `Dismiss` and `Not helpful` actions. Both actions SHALL hide that finding while its mapped source text, category, and message descriptors remain unchanged in the current essay session. `Dismiss` is a neutral skip; `Not helpful` records no additional event or profile and has the same visibility lifetime. A suppression identity SHALL be independent of any per-generation mapped-issue identity: it SHALL map its range across unrelated ProseMirror revisions and rematch only unchanged source text, category, explanation/question message IDs, and canonical message parameters. Suppression SHALL reset when its mapped source is touched, deleted, becomes noncontiguous, changes text, changes category/descriptors, or belongs to another document language or citation/reference environment. All suppression SHALL clear on essay switch, component teardown, or application-session end. It MUST NOT be written to the essay, backups, app settings, local/session storage, logs, telemetry, or a network request.

#### Scenario: Student dismisses an unchanged issue
- **WHEN** the student chooses Dismiss and later edits a different passage in the same essay session
- **THEN** the dismissed finding remains hidden after its mapped unchanged range is reanalyzed

#### Scenario: Unrelated edit shifts a suppressed range
- **WHEN** an unrelated edit before a suppressed issue shifts its mapped range into a later document revision while its source text, category, message IDs, and canonical parameters remain unchanged
- **THEN** the new generation's issue rematches the mapped suppression identity and remains hidden without reusing the old generation's mapped-issue identity

#### Scenario: Student marks an issue Not helpful
- **WHEN** the student chooses Not helpful
- **THEN** the issue hides for the same ephemeral lifetime as Dismiss and no feedback event, profile, storage write, log, or network call occurs

#### Scenario: Underlying source changes
- **WHEN** an edit touches, deletes, splits, or changes the suppressed finding's mapped source text or descriptors
- **THEN** that suppression is removed and any issue emitted for the revised source may appear again

#### Scenario: Essay session ends
- **WHEN** the student switches essays, leaves the editor, or the coach component is destroyed
- **THEN** every dismissal and Not helpful suppression is cleared and no state survives to the next essay session

### Requirement: Deterministic workspace states and announcements
The Study workspace SHALL expose distinct localized states for `idle`, `analyzing`, `issues`, `no-current-issues`, and `unavailable-for-current-text`. First entry without a completed result SHALL show analyzing rather than a false clean state. A completed valid empty issue list SHALL show no-current-issues. Invalid extraction/mapping SHALL show unavailable-for-current-text without technical details. State changes and issue-position changes SHALL use one polite live region, SHALL avoid repeated announcements for structurally equal state, and MUST NOT move focus automatically after background analysis.

#### Scenario: First analysis is pending
- **WHEN** Study opens before a current analysis completes
- **THEN** the workspace shows and politely announces analyzing without claiming the writing is issue-free

#### Scenario: Valid analysis returns no issues
- **WHEN** the current snapshot completes with zero unsuppressed issues
- **THEN** the workspace shows no-current-issues and does not describe the essay as correct, human-authored, APA-compliant, or finished

#### Scenario: Background result updates the issue count
- **WHEN** a current analysis changes the visible issue count while focus is elsewhere
- **THEN** the polite live region announces the new state once and focus remains where the student placed it

### Requirement: Accessible responsive Study workspace
The Write/Study mode control, issue navigation, Dismiss, Not helpful, and Edit this passage SHALL be fully keyboard operable with visible focus and localized accessible names. Entering Study by user action SHALL move focus to the Study heading or selected issue heading; returning through Edit this passage SHALL move focus to the editor selection. Source emphasis and category/status differences MUST NOT rely on color alone. Motion used for mode changes, passage emphasis, or issue changes SHALL be removed when reduced motion is requested. At viewport widths down to 320 CSS pixels, Study content and actions SHALL remain readable and operable without horizontal page scrolling, clipped controls, or source text overflow.

#### Scenario: Keyboard-only Study flow
- **WHEN** a keyboard user enters Study, navigates issues, dismisses an issue, and chooses Edit this passage
- **THEN** focus order is logical, every action is operable, visible focus is preserved, and editor focus returns to the exact source range

#### Scenario: Reduced motion is enabled
- **WHEN** the operating system requests reduced motion
- **THEN** mode, issue, scroll, and emphasis transitions use no nonessential animation while all state changes remain perceivable

#### Scenario: Narrow window
- **WHEN** the Study workspace is rendered at 320 CSS pixels wide with long English or Spanish source text
- **THEN** text wraps, controls remain reachable, and the page has no horizontal overflow

#### Scenario: Screen reader inspects source emphasis
- **WHEN** the active issue is presented without visual color information
- **THEN** semantic text and accessible labeling identify the source passage, emphasized observation, category, explanation, question, and issue position

### Requirement: Essay switching and feature non-interference
Writing Coach state SHALL be owned by the mounted active-essay session. Switching essays SHALL destroy pending timers, stale generations, selected source sessions, transient highlights, and suppressions before the next essay mounts. Coach analysis and interactions MUST NOT call persistence, mutate essay settings/content, alter ProseMirror schema/history, change citation/reference rendering, contribute to APA Check or export warnings, block preview/export, affect spelling capability or dictionaries, or change autosave/backups except when the student independently edits the paper in Write mode.

#### Scenario: Student switches essays during analysis
- **WHEN** the active essay changes while a coach timer or result is pending
- **THEN** pending work is invalidated and no issue, announcement, suppression, focus move, or highlight crosses into the next essay

#### Scenario: Coach issue exists during export
- **WHEN** the current essay has Writing Coach findings and the student previews or exports it
- **THEN** persisted essay JSON, APA results, preview/export output, export eligibility, and representative exported bytes are identical to behavior with the coach closed

#### Scenario: Student edits after reflection
- **WHEN** the student returns to Write and revises the paper using normal editor commands
- **THEN** the ordinary editor transaction, undo, autosave, APA, spelling, preview, and export paths handle that student-authored edit without a coach-specific mutation path

### Requirement: Deterministic local-only boundary
LT-04 SHALL use only the existing pure deterministic writing-coach engine and in-memory UI/controller state. It MUST NOT add Tauri commands, network access, model inference, model installation or controls, generation, quizzes, answer storage, telemetry, analytics, persistent dismissals, automatic rewriting/insertion, essay schema changes, APA-engine authority changes, or DOCX/PDF behavior changes. The Study workspace MUST NOT claim that an issue proves AI use, plagiarism, misconduct, incorrect facts, missing citations elsewhere in the paper, or noncompliance with APA.

#### Scenario: Complete Study interaction remains local
- **WHEN** the student enters Study, reviews every issue, dismisses or marks findings Not helpful, and returns to edit
- **THEN** only in-memory deterministic analysis and UI state are used until the student's own ordinary editor transaction occurs

#### Scenario: Future learning controls are absent
- **WHEN** LT-04 is complete without a later approved OpenSpec
- **THEN** Study contains no local-model, selected-text AI, generated example, quiz, download, consent, or network control
