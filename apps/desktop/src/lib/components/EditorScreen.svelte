<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { Editor as TiptapEditor } from "@tiptap/core";
  import { hasAuthoredBodyTitle } from "@tesina/docx-export";
  import type {
    ApaCheckIssue,
    CitationAttrs,
    DocLocale,
    Reference,
  } from "@tesina/engine";
  import { checkApaDocument, getTerms } from "@tesina/engine";
  import type {
    Essay,
    EssaySettings,
    FontChoice,
    TitlePage,
  } from "$lib/model/essay";
  import { APA_FONTS } from "$lib/model/fonts";
  import Editor from "$lib/components/Editor.svelte";
  import EditorAddon from "$tesina-editor-addon";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import CoverSheet, {
    type CoverPatch,
  } from "$lib/components/CoverSheet.svelte";
  import CitationPopover from "$lib/components/CitationPopover.svelte";
  import HeadingMenu from "$lib/components/HeadingMenu.svelte";
  import ListMenu from "$lib/components/ListMenu.svelte";
  import TableMenu from "$lib/components/TableMenu.svelte";
  import FontMenu from "$lib/components/FontMenu.svelte";
  import TableInsertDialog from "$lib/components/TableInsertDialog.svelte";
  import UpdatePill from "$lib/components/UpdatePill.svelte";
  import EquationDialog from "$lib/components/EquationDialog.svelte";
  import "$lib/components/float-menu.css";
  import PrintPreview from "$lib/components/PrintPreview.svelte";
  import RefEntry from "$lib/components/RefEntry.svelte";
  import ReferenceQuickForm from "$lib/components/ReferenceQuickForm.svelte";
  import BibImportModal from "$lib/components/BibImportModal.svelte";
  import TitlePageForm from "$lib/components/TitlePageForm.svelte";
  import ExportWarningsDialog from "$lib/components/ExportWarningsDialog.svelte";
  import { collectCitedRefIds } from "$lib/editor/citedRefs";
  import {
    type ReferenceDecorationEnv,
    refreshReferenceDecoration,
    repaintReferenceDecoration,
  } from "$lib/editor/referenceDecoration";
  import { invalidatePagination } from "$lib/editor/pagination/extension";
  import { composeDocumentPages } from "$lib/editor/pagination/pageComposition";
  import {
    calculatePaperScale,
    observePaperScale,
    type PaperScaleLayout,
  } from "$lib/editor/pagination/paperScale";
  import type {
    PaginationEnvironment,
    PaginationStateReport,
  } from "$lib/editor/pagination/types";
  import {
    canInsertApaEquation,
    insertApaEquation,
    insertApaTable,
    insertFigure,
    updateApaEquationAt,
  } from "$lib/editor/blocks";
  import { importImageFile } from "$lib/persist/assets";
  import { buildOutline, type OutlineItem } from "$lib/editor/outline";
  import {
    apaIssueKey,
    deleteIssueRanges,
    type PositionedApaIssue,
  } from "$lib/editor/apaCheck";
  import { localizeApaCheck } from "$lib/components/apaCheckMessages";
  import {
    type CitationEnv,
    insertCitation,
    refreshCitations,
  } from "$lib/editor/citation";
  import {
    addAbstract,
    addAppendix,
    addKeywordsLine,
    hasAbstract,
    removeAbstract,
    removeAppendixAtSelection,
    selectionInAppendix,
  } from "$lib/editor/sections";
  import { library } from "$lib/state/library.svelte";
  import { essays } from "$lib/state/essays.svelte";
  import { uiLocale } from "$lib/state/uiLocale.svelte";
  import { dismissable } from "$lib/dom/dismiss";
  import {
    type ExportFormat,
    exportEssayToDocx,
  } from "$lib/export/exportEssay";
  import { exportEssayToPdf } from "$lib/export/exportPdf";
  import { resolveReferencesForExport } from "$lib/export/referenceResolution";
  import {
    createStudentExportSnapshot,
    type StudentTitlePageWarning,
    studentTitlePageWarnings,
  } from "$lib/model/titlePageValidation";
  import { m } from "$lib/paraglide/messages";
  import {
    persistence,
  } from "$lib/persist/coordinator";
  import { createAutosaveController } from "$lib/persist/autosaveController.svelte";
  import { useReleaseNotesController } from "$lib/update/releaseNotesController.svelte";
  import { createWritingCoachController } from "$lib/learning/coachExperience/controller";
  import type { CoachControllerState } from "$lib/learning/coachExperience/types";
  import type {
    CoachEditorBridge,
    CoachEditorHandle,
  } from "$lib/learning/coachExperience/editorPlugin";
  import WritingCoachStudy from "$lib/components/WritingCoachStudy.svelte";

  interface Props {
    essay: Essay;
    newlyCreated: boolean;
    onLaunchConsumed: () => void;
    onBack: () => void;
    onOpenLibrary: () => void;
  }

  let {
    essay,
    newlyCreated,
    onLaunchConsumed,
    onBack,
    onOpenLibrary,
  }: Props = $props();
  const releaseNotes = useReleaseNotesController();
  const autosave = createAutosaveController({
    persist: () => essays.persist(capturePersistSnapshot()),
  });

  // Remounted per essay via {#key essay.id}; initial captures are deliberate.
  let documentLanguage = $state<DocLocale>(
    untrack(() => essay.settings.documentLanguage),
  );
  let words = $state(untrack(() => 0));
  let editor = $state<TiptapEditor | undefined>(undefined);
  let coverTitleInput = $state<HTMLInputElement | undefined>(undefined);
  let titleFormInput = $state<HTMLInputElement | undefined>(undefined);
  let abstractPresent = $state(false);
  let inAppendix = $state(false);
  let citePopoverOpen = $state(false);
  let refFormOpen = $state(false);
  let citeOnSave = $state(false);
  let titleFormOpen = $state(untrack(() => newlyCreated));
  let addMenuOpen = $state(false);
  let outlineOpen = $state(true);
  let refsOpen = $state(true);
  let focusMode = $state(false);
  let previewOpen = $state(false);
  let previewPageCount = $state(0);
  let referencePageCount = $state(1);
  let livePaginationReport = $state<PaginationStateReport | null>(null);
  let paperLayout = $state<PaperScaleLayout>(calculatePaperScale(816, 0));
  let refSearch = $state("");
  let confirmingDelete = $state<string | null>(null);
  let exporting = $state(false);
  let exportMessage = $state("");
  let exportMenuOpen = $state(false);
  /* The format the current export is for. Carried through the advisory dialog
     and through a fix-the-title-page detour so the resumed export still writes
     the format the user actually asked for. */
  let exportFormat = $state<ExportFormat>("docx");
  /* Non-empty while the advisory export dialog is up. Its own presence is the
     "already warned" flag, so confirming exports without re-checking. */
  let exportWarnings = $state<StudentTitlePageWarning[]>([]);
  /* Set when the user leaves the advisory dialog to edit the title page, so
     saving finishes the export they already asked for. */
  let resumeExportAfterTitlePage = $state(false);
  let essayTitle = $state(untrack(() => essay.titlePage.title));
  let titleFormDraft = $state(untrack(() => essay.titlePage.title));
  let outline = $state<OutlineItem[]>(
    untrack(() => buildOutline(essay.content)),
  );
  let selPos = $state(0);
  let bubble = $state<{ x: number; y: number } | null>(null);
  /** Active block format at the cursor, for the Headings/Lists menus. */
  let activeHeadingLevel = $state<number | null>(null);
  let activeList = $state<"bullet" | "ordered" | "lettered" | null>(null);
  let inTable = $state(false);
  let canInsertEquation = $state(false);
  let tableDialogOpen = $state(false);
  /** Insert opens with a blank LaTeX field; edit (from the pencil menu) opens
   * pre-filled at that equation's position. Same dialog either way. */
  let equationDialog = $state<
    { mode: "insert" } | { mode: "edit"; pos: number; latex: string } | null
  >(null);
  /** Only one bottom-bar dropdown open at a time. */
  let openMenu = $state<"headings" | "lists" | "table" | "font" | null>(null);
  /** Live APA structure issues, fed by the editor's check extension. */
  let apaIssues = $state<PositionedApaIssue[]>([]);
  let apaCheckOpen = $state(false);
  /** Checked from the export snapshot itself (not the live pill state), so
     the advisory dialog always matches the bytes about to be written. */
  let exportApaIssues = $state<ApaCheckIssue[]>([]);
  let citedCounts = $state<Map<string, number>>(
    untrack(() => collectCitedRefIds(essay.content)),
  );
  let lastDoc = $state<unknown>(untrack(() => essay.content));
  const coachEssayId = untrack(() => essay.id);
  let coachRevision = 0;
  let coachEditorHandle: CoachEditorHandle | null = null;
  const coachController = createWritingCoachController(coachEssayId);
  let coachMode = $state<"write" | "study">("write");
  let coachState = $state<CoachControllerState>(coachController.getState());
  let coachNavigationStale = $state(false);
  let coachHeading: HTMLHeadingElement | null = null;
  const unsubscribeCoach = coachController.subscribe((next) => {
    coachState = next;
  });
  const syncCoachSnapshot = () => {
    if (!coachEditorHandle) return;
    coachController.updateSnapshot(coachEditorHandle.capture(coachEssayId));
  };
  const coachBridge: CoachEditorBridge = {
    currentRevision: () => coachRevision,
    attach: (handle) => {
      coachEditorHandle = handle;
      if (handle) syncCoachSnapshot();
    },
    onTransaction: (event) => {
      if (event.docChanged) coachRevision += 1;
      const readText = (range: { from: number; to: number }) =>
        event.doc.textBetween(range.from, range.to, "", "");
      coachController.mapFixedSource(event.mapping, readText, coachRevision);
      coachController.mapSuppressions(event.mapping, readText);
      if (event.docChanged || event.externalCitationRefresh) {
        queueMicrotask(syncCoachSnapshot);
      }
    },
  };

  async function enterCoachStudy(): Promise<void> {
    previewOpen = false;
    coachNavigationStale = false;
    syncCoachSnapshot();
    coachController.enterStudy();
    coachMode = "study";
    await tick();
    coachHeading?.focus();
  }

  function returnToWrite(): void {
    coachController.leaveStudy();
    coachMode = "write";
    coachNavigationStale = false;
    coachEditorHandle?.clearHighlight();
  }

  async function editCoachPassage(): Promise<void> {
    const result = await coachController.editCurrentPassage(
      async () => {
        coachMode = "write";
        await tick();
      },
      (issue) => coachEditorHandle?.navigate(issue) ?? false,
    );
    coachNavigationStale = result === "stale";
  }

  function suppressCoachIssue(action: "dismiss" | "not-helpful"): void {
    coachNavigationStale = false;
    coachController.suppressCurrent(action);
  }

  const citationEnv: CitationEnv = {
    refsById: untrack(() => library.byId()),
    locale: untrack(() => documentLanguage),
  };

  const wordGoal = $derived(essay.settings.wordGoal ?? 2500);
  const progress = $derived(Math.min(100, Math.round((words / wordGoal) * 100)));

  // Inline-editable word goal (click the label in the outline progress card).
  let editingGoal = $state(false);
  let goalDraft = $state(2500);

  function startEditGoal() {
    goalDraft = wordGoal;
    editingGoal = true;
  }

  function commitGoal() {
    if (!editingGoal) return;
    const raw = Number(goalDraft);
    const n = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : wordGoal;
    const clamped = Math.min(100000, Math.max(100, n));
    essay.settings = { ...essay.settings, wordGoal: clamped };
    editingGoal = false;
    autosave.scheduleSave();
  }
  const liveComposition = $derived.by(() => {
    const report = livePaginationReport;
    const plan = report?.visiblePlan ?? report?.lastStablePlan;
    if (!plan || !report?.pageCount) return null;
    return composeDocumentPages({
      authoredPageStarts: plan.pageStarts,
      referencePageCount: report.pageCount.references,
    });
  });
  const livePageTotal = $derived(liveComposition?.total ?? null);

  function setFont(font: FontChoice) {
    essay.settings = { ...essay.settings, font };
    autosave.scheduleSave();
  }

  /** Editor sheets render in the chosen APA font via inherited CSS vars. */
  const docFont = $derived(APA_FONTS[essay.settings.font]);
  const sheetFontStyle = $derived(
    `--doc-font: ${docFont.stack}; --doc-font-size: ${docFont.sizePt}pt; --body-title: ${
      hasAuthoredBodyTitle(lastDoc, essayTitle)
        ? "none"
        : JSON.stringify(essayTitle)
    }`,
  );
  /** One reactive selection shared by the live sheet, preview, and export. */
  const referenceResolution = $derived.by(() =>
    resolveReferencesForExport(
      citedCounts.keys(),
      library.references,
      essay.referencesSnapshot ?? [],
      essay.settings.includeUncitedReferences,
    )
  );
  const referencesForExport = $derived(referenceResolution.references);
  const referenceEnv: ReferenceDecorationEnv = {
    references: untrack(() => referencesForExport),
    locale: untrack(() => documentLanguage),
    emptyLabel: untrack(() =>
      m.refsheet_empty(undefined, { locale: documentLanguage })
    ),
    fontKey: untrack(() => essay.settings.font),
    onPageCountChange: (count) => {
      referencePageCount = count;
    },
  };

  function handlePaginationReport(report: PaginationStateReport) {
    const prior = livePaginationReport;
    livePaginationReport = report.pageCount || !prior?.pageCount
      ? report
      : {
        ...report,
        pageCount: prior.pageCount,
        visiblePlan: report.visiblePlan ?? prior.visiblePlan,
        lastStablePlan: report.lastStablePlan ?? prior.lastStablePlan,
      };

    const visiblePlan = report.visiblePlan ?? report.lastStablePlan;
    if (!visiblePlan) return;
    const composition = composeDocumentPages({
      authoredPageStarts: visiblePlan.pageStarts,
      referencePageCount: report.pageCount?.references ?? referencePageCount,
      documentEnd: editor?.state.doc.content.size,
    });
    referenceEnv.pageNumbers = composition.pages
      .filter((page) => page.kind === "references")
      .map((page) => page.pageNumber);
    if (editor && !editor.isDestroyed) repaintReferenceDecoration(editor);
  }

  const paginationEnv: PaginationEnvironment = {
    reason: "canonical-layout",
    getReferencePageCount: () => referencePageCount,
    onPageCount: handlePaginationReport,
  };

  const mountPaperScale: Attachment<HTMLDivElement> = (outer) => {
    const viewport = outer.parentElement;
    const stack = outer.firstElementChild;
    if (!(viewport instanceof HTMLElement) || !(stack instanceof HTMLElement)) {
      return;
    }
    return observePaperScale(viewport, stack, (layout) => {
      paperLayout = layout;
    });
  };

  $effect(() => {
    referenceEnv.references = referencesForExport;
    referenceEnv.locale = documentLanguage;
    referenceEnv.fontKey = essay.settings.font;
    referenceEnv.emptyLabel = m.refsheet_empty(undefined, {
      locale: documentLanguage,
    });
    if (editor && !editor.isDestroyed) refreshReferenceDecoration(editor);
  });

  let lastPaginationLocale = untrack(() => documentLanguage);
  let lastPaginationFont = untrack(() => essay.settings.font);
  let lastPaginationTitle = untrack(() => essayTitle);
  $effect(() => {
    const currentEditor = editor;
    const locale = documentLanguage;
    const font = essay.settings.font;
    const title = essayTitle;
    if (!currentEditor || currentEditor.isDestroyed) return;
    const localeChanged = locale !== lastPaginationLocale;
    const fontChanged = font !== lastPaginationFont;
    const titleChanged = title !== lastPaginationTitle;
    if (!localeChanged && !fontChanged && !titleChanged) return;
    lastPaginationLocale = locale;
    lastPaginationFont = font;
    lastPaginationTitle = title;
    void tick().then(async () => {
      if (currentEditor !== editor || currentEditor.isDestroyed) return;
      if (localeChanged) invalidatePagination(currentEditor, "document-locale");
      if (titleChanged) invalidatePagination(currentEditor, "canonical-layout");
      if (fontChanged) {
        invalidatePagination(currentEditor, "font");
        await document.fonts?.ready;
        if (currentEditor !== editor || currentEditor.isDestroyed) return;
        invalidatePagination(currentEditor, "font-ready");
      }
    });
  });

  const abstractLabel = $derived(
    getTerms(documentLanguage).headings.abstract,
  );
  const referencesLabel = $derived(
    getTerms(documentLanguage).headings.references,
  );
  const appendixLabel = $derived(
    getTerms(documentLanguage).headings.appendix,
  );

  const STATUS_LABELS = {
    guardando: m.editor_status_saving,
    guardado: m.editor_status_saved,
    error: m.editor_status_error,
  } as const;

  interface RefRow {
    ref: Reference;
    text: string;
    cited: number;
    personal: boolean;
  }

  const refRows = $derived.by(() => {
    const t = getTerms(documentLanguage);
    const rows: RefRow[] = library.references.map((ref) => {
      const personal = ref.type === "personalCommunication";
      let text: string;
      if (personal) {
        const first = ref.authors[0];
        const name = first
          ? first.kind === "group" ? first.name : first.family
          : "";
        text = `${name} — ${t.personalCommunication}`;
      } else {
        text = "";
      }
      return { ref, text, cited: citedCounts.get(ref.id) ?? 0, personal };
    });
    const q = refSearch.trim().toLowerCase();
    return rows.filter((row) =>
      q === "" ||
      JSON.stringify(row.ref).toLowerCase().includes(q)
    );
  });

  function syncCitationEnv() {
    citationEnv.refsById = library.byId();
    citationEnv.locale = documentLanguage;
    if (editor) refreshCitations(editor);
  }

  function snapshotCitedRefs(): Reference[] {
    const byId = library.byId();
    const cited: Reference[] = [];
    for (const refId of citedCounts.keys()) {
      const ref = byId.get(refId);
      if (ref) cited.push(ref);
    }
    return cited;
  }

  // What we persist as the essay's denormalized snapshot: the live cited refs
  // PLUS the prior snapshot copy of any still-cited reference that has since
  // been deleted from the shared library. Without this, the first autosave
  // after deleting a cited ref would drop its copy and defeat the reconcile
  // restore on reopen (model/reconcile.ts). The live sheet keeps using the
  // plain snapshot above.
  function snapshotForPersist(): Reference[] {
    const live = snapshotCitedRefs();
    const have = new Set(live.map((r) => r.id));
    const merged = [...live];
    for (const r of essay.referencesSnapshot ?? []) {
      if (!have.has(r.id) && citedCounts.has(r.id)) merged.push(r);
    }
    return merged;
  }

  function capturePersistSnapshot(): Essay {
    essay.settings.documentLanguage = documentLanguage;
    essay.content = lastDoc;
    essay.referencesSnapshot = snapshotForPersist();
    return structuredClone($state.snapshot(essay) as Essay);
  }

  onMount(() => autosave.bindPersistence(persistence));
  onDestroy(() => {
    unsubscribeCoach();
    coachController.destroy();
  });

  async function leaveEditor(destination: () => void) {
    try {
      await autosave.persistNow();
    } catch {
      // Stay in the editor so the visible error can be retried.
      return;
    }
    destination();
  }

  async function goBack() {
    await leaveEditor(onBack);
  }

  async function openLibrary() {
    await leaveEditor(onOpenLibrary);
  }

  function handleUpdate(docJson: unknown, wordCount: number) {
    lastDoc = docJson;
    words = wordCount;
    citedCounts = collectCitedRefIds(docJson);
    essay.referencesSnapshot = snapshotForPersist();
    outline = buildOutline(docJson);
    if (editor) abstractPresent = hasAbstract(editor);
    autosave.scheduleSave();
  }

  function updateBubble(instance: TiptapEditor) {
    const { from, to, empty } = instance.state.selection;
    if (empty || to - from < 1) {
      bubble = null;
      return;
    }
    try {
      const start = instance.view.coordsAtPos(from);
      const end = instance.view.coordsAtPos(to);
      bubble = {
        x: (start.left + end.right) / 2,
        y: Math.min(start.top, end.top) - 10,
      };
    } catch {
      bubble = null;
    }
  }

  function handleReady(instance: TiptapEditor) {
    editor = instance;
    abstractPresent = hasAbstract(instance);
    words = instance.state.doc.textBetween(
      0,
      instance.state.doc.content.size,
      " ",
      " ",
    ).trim().split(/\s+/).filter((w) => w !== "").length;
    const track = () => {
      inAppendix = selectionInAppendix(instance);
      selPos = instance.state.selection.from;
      updateBubble(instance);
      let level: number | null = null;
      for (let l = 1; l <= 5; l++) {
        if (instance.isActive("heading", { level: l })) {
          level = l;
          break;
        }
      }
      activeHeadingLevel = level;
      activeList = instance.isActive("bulletList")
        ? "bullet"
        : instance.isActive("orderedList")
        ? (instance.isActive("orderedList", { listStyle: "lower-alpha" })
          ? "lettered"
          : "ordered")
        : null;
      inTable = instance.isActive("table");
      canInsertEquation = canInsertApaEquation(instance.state);
    };
    instance.on("selectionUpdate", track);
    instance.on("transaction", track);
    track();
    instance.on("blur", () => {
      // Let bubble clicks land before hiding.
      setTimeout(() => (bubble = null), 150);
    });
  }

  function goTo(item: OutlineItem) {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection(Math.min(item.pos + 1, editor.state.doc.content.size))
      .scrollIntoView()
      .run();
  }

  function goToIssue(issue: PositionedApaIssue) {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection(Math.min(issue.from + 1, editor.state.doc.content.size))
      .scrollIntoView()
      .run();
  }

  const emptyParagraphIssues = $derived(
    apaIssues.filter((i) => i.rule === "empty-paragraph"),
  );

  function fixIssues(issues: readonly PositionedApaIssue[]) {
    if (editor) deleteIssueRanges(editor, issues);
  }

  const activeIndex = $derived.by(() => {
    let index = -1;
    outline.forEach((item, i) => {
      if (item.pos <= selPos) index = i;
    });
    return index;
  });

  function setLanguage(lang: DocLocale) {
    if (documentLanguage === lang) return;
    documentLanguage = lang;
    syncCitationEnv();
    autosave.scheduleSave();
  }

  function toggleAbstract() {
    if (!editor) return;
    if (abstractPresent) removeAbstract(editor);
    else addAbstract(editor);
    abstractPresent = hasAbstract(editor);
    addMenuOpen = false;
  }

  function handleAddKeywords() {
    if (!editor) return;
    if (!abstractPresent) addAbstract(editor);
    addKeywordsLine(editor);
    abstractPresent = hasAbstract(editor);
    addMenuOpen = false;
  }

  function handleAddAppendix() {
    if (editor) addAppendix(editor);
    addMenuOpen = false;
  }

  function handleRemoveAppendix() {
    if (editor) removeAppendixAtSelection(editor);
    addMenuOpen = false;
  }

  /**
   * Exports the essay. Incomplete APA — title page or document structure —
   * never stops this: the first attempt surfaces every shortfall as advice
   * in one dialog, and `skipExportAdvice` carries the user's "export anyway"
   * (or the fix-title-page detour, which already showed the advice once)
   * through the second call.
   */
  async function handleExport(
    format: ExportFormat = exportFormat,
    skipExportAdvice = false,
  ) {
    if (!editor || exporting) return;
    const currentEditor = editor;
    exportFormat = format;
    exportMenuOpen = false;
    exporting = true;
    exportMessage = "";
    exportWarnings = [];
    exportApaIssues = [];
    try {
      const documentSnapshot = lastDoc ?? currentEditor.getJSON();
      const exportReferences = resolveReferencesForExport(
        collectCitedRefIds(documentSnapshot).keys(),
        library.references,
        essay.referencesSnapshot ?? [],
        essay.settings.includeUncitedReferences,
      );
      if (exportReferences.unresolvedCitedRefIds.length > 0) {
        exportMessage = m.editor_export_missing_references();
        return;
      }
      const exportSnapshot = createStudentExportSnapshot(
        essay,
        documentSnapshot,
        exportReferences.references,
        documentLanguage,
      );
      if (!skipExportAdvice) {
        const warnings = studentTitlePageWarnings(
          exportSnapshot.essay.titlePage,
          documentLanguage,
        );
        const bodyIssues = checkApaDocument(documentSnapshot);
        if (warnings.length > 0 || bodyIssues.length > 0) {
          exportWarnings = warnings;
          exportApaIssues = bodyIssues;
          return;
        }
      }

      const exportForFormat = format === "pdf"
        ? exportEssayToPdf
        : exportEssayToDocx;
      const outcome = await exportForFormat(
        exportSnapshot.essay,
        exportSnapshot.document,
        exportSnapshot.references,
      );
      if (outcome.status === "saved") {
        exportMessage = m.editor_exported({ path: outcome.path });
      } else if (outcome.status === "error") {
        exportMessage = m.editor_export_error({ message: outcome.message });
      }
    } finally {
      exporting = false;
    }
  }

  function handleInsertCitation(attrs: CitationAttrs) {
    citePopoverOpen = false;
    if (editor) insertCitation(editor, attrs);
  }

  let figureInput = $state<HTMLInputElement | undefined>(undefined);

  async function handleFigureFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !editor) return;
    try {
      const relPath = await importImageFile(file);
      insertFigure(editor, relPath);
    } catch (err) {
      console.error("No se pudo insertar la figura:", err);
    }
  }

  // ── BibTeX import (shared modal; opened from the reference form) ──
  /** Largest .bib we'll read into memory (huge for a bibliography). */
  const MAX_BIB_BYTES = 5_000_000;
  let bibInput = $state<HTMLInputElement | undefined>(undefined);
  let bibText = $state<string | null>(null);
  let bibError = $state<string | null>(null);

  async function handleBibFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    bibError = null;
    if (!file) return;
    if (file.size > MAX_BIB_BYTES) {
      bibError = m.bib_file_too_big();
      return;
    }
    try {
      bibText = await file.text();
      refFormOpen = false;
    } catch (err) {
      console.error("No se pudo leer el archivo .bib:", err);
      bibError = m.bib_read_error();
    }
  }

  function handleSaveReference(ref: Reference) {
    library.add(ref);
    refFormOpen = false;
    syncCitationEnv();
    // From the writing bar the new source is cited where the cursor sits.
    if (citeOnSave && editor && ref.type !== "personalCommunication") {
      insertCitation(editor, {
        items: [{ refId: ref.id }],
        mode: "parenthetical",
      });
    }
    citeOnSave = false;
  }

  function openRefForm(insertAfter: boolean) {
    citeOnSave = insertAfter;
    refFormOpen = true;
  }

  function handleCiteFromPanel(refId: string) {
    if (!editor) return;
    insertCitation(editor, { items: [{ refId }], mode: "parenthetical" });
  }

  function handleDeleteReference(refId: string) {
    if (confirmingDelete !== refId) {
      confirmingDelete = refId;
      return;
    }
    confirmingDelete = null;
    library.remove(refId);
    syncCitationEnv();
  }

  function handleSaveTitlePage(titlePage: TitlePage, settings: EssaySettings) {
    const resumeExport = resumeExportAfterTitlePage;
    essay.titlePage = titlePage;
    essay.settings = {
      ...settings,
      documentLanguage,
      variant: "student",
    };
    essayTitle = titlePage.title;
    titleFormDraft = titlePage.title;
    resumeExportAfterTitlePage = false;
    exportMessage = "";
    titleFormOpen = false;
    autosave.scheduleSave();
    /* Saving finishes the export the user already asked for. The advice is
       skipped: they just read it in the form, so re-raising the dialog would
       trap "fix and save" in a loop it cannot leave. */
    if (resumeExport) void handleExport(exportFormat, true);
  }

  /** Applies an inline edit from the student title-page sheet. */
  function handleCoverChange(patch: CoverPatch) {
    essay.titlePage = { ...essay.titlePage, ...patch };
    if (patch.title !== undefined) essayTitle = essay.titlePage.title;
    autosave.scheduleSave();
  }

  function openTitleForm() {
    titleFormDraft = essayTitle;
    titleFormOpen = true;
  }

  function closeTitleForm() {
    titleFormOpen = false;
    titleFormDraft = essayTitle;
    // Dismissing the form abandons the export it was opened from, so a
    // later unrelated save doesn't resume it unexpectedly.
    resumeExportAfterTitlePage = false;
  }
</script>

<div
  class="app"
  class:no-outline={!outlineOpen}
  class:no-refs={!refsOpen}
  class:focus={focusMode}
>
  <header class="titlebar" data-tauri-drag-region>
    <div class="tb-left">
      <div class="traffic-space"></div>
      <button class="icon-btn" onclick={goBack} title={m.tb_back()} aria-label={m.tb_back()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="16" height="16"><path d="M14 6l-6 6 6 6" /></svg>
      </button>
    </div>
    <div class="tb-title" data-tauri-drag-region>
      <span class="mark">T</span> <b>{essayTitle}</b>
    </div>
    <div class="coach-mode" role="group" aria-label={m.writing_coach_mode_label()}>
      <button
        type="button"
        aria-pressed={coachMode === "write"}
        onclick={returnToWrite}
      >{m.writing_coach_mode_write()}</button>
      <button
        type="button"
        aria-pressed={coachMode === "study"}
        onclick={() => void enterCoachStudy()}
      >{m.writing_coach_mode_study()}</button>
    </div>
    <div class="tb-actions">
      <button
        class="icon-btn"
        class:on={outlineOpen && !focusMode}
        onclick={() => (outlineOpen = !outlineOpen)}
        title={m.tb_outline()}
        aria-label={m.tb_outline()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
      </button>
      <button
        class="icon-btn"
        class:on={refsOpen && !focusMode}
        onclick={() => (refsOpen = !refsOpen)}
        title={m.tb_refs()}
        aria-label={m.tb_refs()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 4h11a2 2 0 0 1 2 2v14l-4-2-4 2V6H6z" /><path d="M6 4v16" /></svg>
      </button>
      <button
        class="icon-btn"
        class:on={previewOpen}
        onclick={() => {
          previewOpen = !previewOpen;
          if (previewOpen) {
            coachController.leaveStudy();
            coachMode = "write";
            coachNavigationStale = false;
            coachEditorHandle?.clearHighlight();
            previewPageCount = 0;
          }
        }}
        title={m.tb_preview()}
        aria-label={m.tb_preview()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></svg>
      </button>
      <button
        class="icon-btn"
        onclick={() => uiLocale.cycleTheme()}
        title={m.common_theme()}
        aria-label={m.common_theme()}
      >
        {uiLocale.theme === "light" ? "☀" : uiLocale.theme === "dark" ? "☾" : "◐"}
      </button>
    </div>
  </header>

  {#if coachMode === "write"}
    <div
      class="coach-write-status"
      data-coach-write-status
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >{coachNavigationStale ? m.writing_coach_status_stale() : ""}</div>
  {/if}

  <div class="shell" class:study-mode={coachMode === "study"}>
    <aside
      class="outline"
      aria-hidden={coachMode === "study"}
      inert={coachMode === "study"}
    >
      <div class="panel-head">
        <h4>{m.outline_title()}</h4>
        <div
          class="add-wrap"
          {@attach addMenuOpen && dismissable(() => (addMenuOpen = false))}
        >
          <button class="mini" onclick={() => (addMenuOpen = !addMenuOpen)} aria-label={m.outline_add()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {#if addMenuOpen}
            <div class="popover menu" role="menu">
              <button role="menuitem" onclick={toggleAbstract}>
                {abstractPresent ? m.editor_remove_abstract() : m.editor_add_abstract()}
              </button>
              <button role="menuitem" onclick={handleAddKeywords}>{m.editor_keywords()}</button>
              <button role="menuitem" onclick={handleAddAppendix}>{m.editor_add_appendix()}</button>
              {#if inAppendix}
                <button role="menuitem" onclick={handleRemoveAppendix}>{m.editor_remove_appendix()}</button>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <button class="out-item" onclick={openTitleForm}>
        <span class="n">—</span>{m.outline_titlepage(undefined, {
          locale: documentLanguage,
        })}
        <span class="wc">{m.outline_one_page(undefined, {
          locale: documentLanguage,
        })}</span>
      </button>
      {#each outline as item, i (item.pos)}
        <button
          class="out-item"
          class:sub={item.sub}
          class:active={i === activeIndex}
          onclick={() => goTo(item)}
        >
          {#if !item.sub}<span class="n">{item.marker}</span>{/if}
          {item.label ||
            (item.marker === "R" ? abstractLabel : appendixLabel)}
          {#if !item.sub}
            <span class="wc">
              {item.words > 0 ? item.words.toLocaleString(uiLocale.current) : ""}
            </span>
          {/if}
        </button>
      {/each}
      <button class="out-item" onclick={() => (refsOpen = true)}>
        <span class="n">R</span>{referencesLabel}
        <span class="wc">{citedCounts.size}</span>
      </button>

      <div class="out-progress">
        <div class="pl">
          {#if editingGoal}
            <input
              class="goal-input"
              type="number"
              min="100"
              max="100000"
              step="50"
              bind:value={goalDraft}
              aria-label={m.outline_goal_edit()}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitGoal();
                } else if (e.key === "Escape") {
                  editingGoal = false;
                }
              }}
              onblur={commitGoal}
              {@attach (node) => {
                node.focus();
                node.select();
              }}
            />
          {:else}
            <button
              class="goal-btn"
              onclick={startEditGoal}
              title={m.outline_goal_edit()}
            >
              {m.outline_progress({
                goal: wordGoal.toLocaleString(uiLocale.current),
              })}
            </button>
          {/if}
          <span>{progress}%</span>
        </div>
        <div class="bar"><span style="width: {progress}%"></span></div>
      </div>
    </aside>

    <main class="canvas">
      {#if previewOpen}
        <div class="preview-host">
          {#key documentLanguage}
            <PrintPreview
              {essay}
              docJson={lastDoc ?? editor?.getJSON()}
              references={referencesForExport}
              onPageCount={(pages) => (previewPageCount = pages)}
            />
          {/key}
        </div>
      {:else}
        {#if coachMode === "study"}
          <WritingCoachStudy
            state={coachState}
            stale={coachNavigationStale}
            onPrevious={() => coachController.previousIssue()}
            onNext={() => coachController.nextIssue()}
            onDismiss={() => suppressCoachIssue("dismiss")}
            onNotHelpful={() => suppressCoachIssue("not-helpful")}
            onEditPassage={() => void editCoachPassage()}
            onHeadingReady={(element) => (coachHeading = element)}
          />
        {/if}
        <div
          class="paper-fit-viewport"
          class:coach-hidden={coachMode === "study"}
          data-write-workspace
          aria-hidden={coachMode === "study"}
          inert={coachMode === "study"}
        >
          <div
            class="paper-scale-outer"
            data-paper-scale={paperLayout.scale}
            style:width={`${paperLayout.outerWidth}px`}
            style:height={`${paperLayout.outerHeight}px`}
            {@attach mountPaperScale}
          >
            <div
              class="paper-scale-inner sheet-stack"
              style={sheetFontStyle}
              style:width={`${paperLayout.layoutWidth}px`}
              style:transform={`scale(${paperLayout.scale})`}
            >
              <CoverSheet
                titlePage={essay.titlePage}
                language={documentLanguage}
                onChange={handleCoverChange}
                onOpenForm={openTitleForm}
                bind:titleInput={coverTitleInput}
              />
              <Editor
                initialDoc={lastDoc}
                {newlyCreated}
                {onLaunchConsumed}
                {documentLanguage}
                {citationEnv}
                {referenceEnv}
                {paginationEnv}
                onUpdate={handleUpdate}
                onApaIssues={(issues) => (apaIssues = issues)}
                onReady={handleReady}
                onEditEquation={(pos, latex) =>
                  (equationDialog = { mode: "edit", pos, latex })}
                {coachBridge}
              />
            </div>
          </div>
        </div>
      {/if}
    </main>

    <aside
      class="refs"
      aria-hidden={coachMode === "study"}
      inert={coachMode === "study"}
    >
      <div class="panel-head">
        <h4>{referencesLabel}</h4>
        <div class="panel-head-actions">
          <button class="btn btn-secondary btn-sm" onclick={openLibrary}>
            {m.libm_manage()}
          </button>
          <button class="btn btn-primary btn-sm" onclick={() => openRefForm(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
            {m.panel_add().replace("+ ", "")}
          </button>
        </div>
      </div>
      <div class="search-ref">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input type="text" placeholder={m.refs_search()} bind:value={refSearch} />
      </div>
      {#each refRows as row (row.ref.id)}
        <div class="ref-card">
          {#if row.personal}
            <p class="rtxt">{row.text}</p>
          {:else}
            <RefEntry reference={row.ref} language={documentLanguage} />
          {/if}
          <div class="ref-foot">
            <span
              class="badge"
              class:badge-accent={row.cited > 0}
              class:badge-warn={row.cited === 0 && !row.personal}
            >
              {row.personal
                ? m.refs_in_text_only()
                : row.cited > 0
                ? `${m.refs_cited()} · ${row.cited}`
                : m.refs_uncited()}
            </span>
            <button
              class="btn-quiet btn-danger-text del"
              onclick={() => handleDeleteReference(row.ref.id)}
              onblur={() => (confirmingDelete = null)}
            >
              {confirmingDelete === row.ref.id ? m.panel_delete_confirm() : "×"}
            </button>
            <button
              class="btn-quiet"
              onclick={() => handleCiteFromPanel(row.ref.id)}
            >
              {m.refs_insert()}
            </button>
          </div>
        </div>
      {/each}
    </aside>
  </div>

  {#if !previewOpen && coachMode === "write"}
    <Toolbar
      dock={uiLocale.dock}
      onDockChange={(next) => uiLocale.setDock(next)}
    >
      <div
        class="fab-cite"
        {@attach citePopoverOpen && dismissable(() => (citePopoverOpen = false))}
      >
        <button
          class="fm-btn primary"
          onclick={() => (citePopoverOpen = !citePopoverOpen)}
          disabled={!editor}
          data-tip={m.editor_insert_citation()}
          aria-label={m.editor_insert_citation()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 5v14M5 12h14" /></svg>
          <span class="fm-label">{m.editor_insert_citation()}</span>
        </button>
        {#if citePopoverOpen}
          <CitationPopover
            references={library.references}
            {documentLanguage}
            onInsert={handleInsertCitation}
            onClose={() => (citePopoverOpen = false)}
          />
        {/if}
      </div>
      <button
        class="fm-btn"
        onclick={() => openRefForm(true)}
        data-tip={m.fab_new_ref_hint()}
        aria-label={m.fab_new_ref()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4h11a2 2 0 0 1 2 2v14l-4-2-4 2V6H6z" /><path d="M6 4v16" /></svg>
        <span class="fm-label">{m.fab_new_ref()}</span>
      </button>
      <div class="fm-sep"></div>
      <HeadingMenu
        {editor}
        activeLevel={activeHeadingLevel}
        open={openMenu === "headings"}
        onToggle={() => (openMenu = openMenu === "headings" ? null : "headings")}
        onClose={() => (openMenu = null)}
      />
      <ListMenu
        {editor}
        {activeList}
        open={openMenu === "lists"}
        onToggle={() => (openMenu = openMenu === "lists" ? null : "lists")}
        onClose={() => (openMenu = null)}
      />
      <TableMenu
        {editor}
        {inTable}
        open={openMenu === "table"}
        onToggle={() => (openMenu = openMenu === "table" ? null : "table")}
        onClose={() => (openMenu = null)}
        onInsert={() => (tableDialogOpen = true)}
      />
      <button
        class="fm-btn"
        onclick={() => figureInput?.click()}
        disabled={!editor}
        data-tip={m.fab_figure()}
        aria-label={m.fab_figure()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="1" /><circle cx="8.5" cy="9" r="1.5" /><path d="M21 15l-5-5L5 20" /></svg>
        <span class="fm-label">{m.fab_figure()}</span>
      </button>
      <input
        bind:this={figureInput}
        type="file"
        accept="image/*"
        style="display: none"
        onchange={handleFigureFile}
      />
      <button
        class="fm-btn"
        onclick={() => (equationDialog = { mode: "insert" })}
        disabled={!editor || !canInsertEquation}
        data-tip={m.fab_equation()}
        aria-label={m.fab_equation()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 16l3 5 6-16h7" /></svg>
        <span class="fm-label">{m.fab_equation()}</span>
      </button>
      <FontMenu
        current={essay.settings.font}
        open={openMenu === "font"}
        onToggle={() => (openMenu = openMenu === "font" ? null : "font")}
        onClose={() => (openMenu = null)}
        onSelect={setFont}
      />
      <div class="fm-sep"></div>
      <button
        class="fm-btn"
        class:on={focusMode}
        onclick={() => (focusMode = !focusMode)}
        data-tip={m.fab_focus()}
        aria-label={m.fab_focus()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>
        <span class="fm-label">{m.fab_focus()}</span>
      </button>
      <div class="fm-sep"></div>
      <div class="fm-export-wrap" {@attach dismissable(() => (exportMenuOpen = false))}>
        <button
          class="fm-btn fm-primary-action"
          onclick={() => (exportMenuOpen = !exportMenuOpen)}
          disabled={!editor || exporting}
          data-tip={exporting ? m.editor_exporting() : m.editor_export()}
          aria-label={exporting ? m.editor_exporting() : m.editor_export()}
          aria-haspopup="menu"
          aria-expanded={exportMenuOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M8 11l4 4 4-4M5 21h14" /></svg>
          <span class="fm-label">{exporting ? m.editor_exporting() : m.editor_export()}</span>
        </button>
        {#if exportMenuOpen}
          <div class="popover menu export-menu" role="menu" aria-label={m.editor_export_format()}>
            <button role="menuitem" onclick={() => void handleExport("docx")}>
              {m.editor_export_docx()}
            </button>
            <button role="menuitem" onclick={() => void handleExport("pdf")}>
              {m.editor_export_pdf()}
            </button>
          </div>
        {/if}
      </div>
      <div
        class="fm-export-wrap"
        {@attach apaCheckOpen && dismissable(() => (apaCheckOpen = false))}
      >
        <button
          class="fm-btn apa-pill"
          class:bad={apaIssues.length > 0}
          onclick={() => (apaCheckOpen = !apaCheckOpen)}
          data-tip={apaIssues.length === 0
            ? m.apa_check_tip_ok()
            : m.apa_check_tip_issues({ count: apaIssues.length })}
          aria-label={m.apa_check_menu_label()}
          aria-haspopup="menu"
          aria-expanded={apaCheckOpen}
        >
          {#if apaIssues.length === 0}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12.5l5 5L20 6.5" /></svg>
          {:else}
            <span class="apa-pill-count">{apaIssues.length}</span>
          {/if}
          <span class="fm-label">APA</span>
        </button>
        {#if apaCheckOpen}
          <div class="popover menu apa-check-menu" role="menu" aria-label={m.apa_check_menu_label()}>
            <div
              class="popover-head"
              data-tone={apaIssues.length === 0 ? "success" : "warn"}
            >
              <span class="popover-dot" aria-hidden="true"></span>
              <div class="popover-title">
                {apaIssues.length === 0
                  ? m.apa_check_all_good()
                  : m.apa_check_tip_issues({ count: apaIssues.length })}
              </div>
            </div>
            {#if apaIssues.length > 0}
              {#if emptyParagraphIssues.length > 1}
                <button
                  class="apa-fix-all"
                  role="menuitem"
                  onclick={() => fixIssues(emptyParagraphIssues)}
                >
                  {m.apa_check_fix_all({ count: emptyParagraphIssues.length })}
                </button>
              {/if}
              {#each apaIssues as issue (apaIssueKey(issue))}
                <div class="apa-check-row">
                  <button
                    class="apa-check-jump"
                    role="menuitem"
                    onclick={() => goToIssue(issue)}
                  >
                    {localizeApaCheck(issue)}
                  </button>
                  {#if issue.rule === "empty-paragraph"}
                    <button
                      class="apa-check-fix"
                      role="menuitem"
                      onclick={() => fixIssues([issue])}
                    >
                      {m.apa_check_fix()}
                    </button>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      <span class="fm-count">
        {m.fab_words({ count: words.toLocaleString(uiLocale.current) })}
      </span>
    </Toolbar>
  {/if}

  {#if bubble && !previewOpen && coachMode === "write"}
    <div class="bubble show" style="left: {bubble.x}px; top: {bubble.y}px">
      <button class="bb" style="font-weight: 700" onclick={() => editor?.chain().focus().toggleBold().run()} aria-label={m.toolbar_bold()}>B</button>
      <button class="bb it" onclick={() => editor?.chain().focus().toggleItalic().run()} aria-label={m.toolbar_italic()}>I</button>
      <button class="bb un" onclick={() => editor?.chain().focus().toggleUnderline().run()} aria-label={m.toolbar_underline()}>U</button>
      <div class="bb-sep"></div>
      <button class="bb" onclick={() => editor?.chain().focus().toggleBlockquote().run()} aria-label={m.toolbar_blockquote()}>❝</button>
    </div>
  {/if}

  <footer class="statusbar" class:dim={focusMode}>
    <span>{words === 1 ? m.editor_words_one() : m.editor_words_many({ count: words })}</span>
    <span class="sep">·</span>
    <span
      data-live-page-status
      data-preview-page-count={previewPageCount > 0
        ? previewPageCount
        : undefined}
    >
      {#if livePageTotal !== null}
        {livePageTotal === 1
          ? m.status_pages_one()
          : m.status_pages_many({ count: livePageTotal })}
      {:else if livePaginationReport?.status === "fallback"}
        {m.status_pages_unavailable()}
      {:else}
        {m.status_pages_pending()}
      {/if}
    </span>
    <span class="sep">·</span>
    <span>{m.status_refs({ count: citedCounts.size })}</span>
    <span class="sep">·</span>
    <button
      class="lang"
      title={m.doclang_switch()}
      aria-label={m.doclang_switch()}
      onclick={() => setLanguage(documentLanguage === "es" ? "en" : "es")}
    >
      {documentLanguage.toUpperCase()}
    </button>
    <span class="sep">·</span>
    <span>{m.status_apa_edition(undefined, { locale: uiLocale.current })}</span>
    <button
      type="button"
      class="version"
      data-release-notes-version
      title={m.release_notes_open_tooltip({
        version: releaseNotes.installedVersion,
      }, { locale: uiLocale.current })}
      aria-label={m.release_notes_open_label({
        version: releaseNotes.installedVersion,
      }, { locale: uiLocale.current })}
      onclick={() => releaseNotes.openInstalledNotes()}
    >
      {m.app_version_short({ version: releaseNotes.installedVersion }, {
        locale: uiLocale.current,
      })}
    </button>
    <UpdatePill />
    {#if exportMessage}
      <span class="export-msg">{exportMessage}</span>
    {/if}
    <span class="saved" data-status={autosave.status}>
      <span class="dot"></span>
      {STATUS_LABELS[autosave.status]()}
    </span>
  </footer>
  <EditorAddon
    {essay}
    {editor}
    titleInput={titleFormInput ?? coverTitleInput}
    {titleFormOpen}
    title={essayTitle}
    doc={lastDoc}
    {documentLanguage}
    onTitleChange={(value: string) => {
      titleFormDraft = value;
      if (!titleFormOpen) handleCoverChange({ title: value });
    }}
    onEssayMutation={() => autosave.scheduleSave()}
    onOpenTitleForm={openTitleForm}
  />
</div>

{#if refFormOpen}
  <ReferenceQuickForm
    language={documentLanguage}
    onSave={handleSaveReference}
    onImportBibtex={() => bibInput?.click()}
    onClose={() => {
      refFormOpen = false;
      citeOnSave = false;
    }}
  />
{/if}

<input
  bind:this={bibInput}
  type="file"
  accept=".bib"
  style="display: none"
  onchange={handleBibFile}
/>

{#if bibText !== null}
  <BibImportModal
    {bibText}
    onDone={() => {
      bibText = null;
      syncCitationEnv();
    }}
    onClose={() => (bibText = null)}
  />
{/if}

{#if bibError}
  <div class="bib-error-toast" role="alert">
    <span>{bibError}</span>
    <button
      class="bib-error-x"
      onclick={() => (bibError = null)}
      aria-label={m.common_close()}
    >×</button>
  </div>
{/if}

{#if exportWarnings.length > 0 || exportApaIssues.length > 0}
  <ExportWarningsDialog
    warnings={exportWarnings}
    apaIssues={exportApaIssues}
    onExportAnyway={() => {
      exportWarnings = [];
      exportApaIssues = [];
      void handleExport(exportFormat, true);
    }}
    onFixTitlePage={() => {
      exportWarnings = [];
      exportApaIssues = [];
      resumeExportAfterTitlePage = true;
      openTitleForm();
    }}
    onClose={() => {
      exportWarnings = [];
      exportApaIssues = [];
    }}
  />
{/if}

{#if titleFormOpen}
  <TitlePageForm
    titlePage={essay.titlePage}
    settings={essay.settings}
    onSave={handleSaveTitlePage}
    bind:titleInput={titleFormInput}
    bind:titleDraft={titleFormDraft}
    onClose={closeTitleForm}
  />
{/if}

{#if tableDialogOpen}
  <TableInsertDialog
    onInsert={(rows, cols, header) => {
      tableDialogOpen = false;
      if (editor) insertApaTable(editor, rows, cols, header);
    }}
    onClose={() => (tableDialogOpen = false)}
  />
{/if}

{#if equationDialog}
  <EquationDialog
    initialLatex={equationDialog.mode === "edit" ? equationDialog.latex : ""}
    editing={equationDialog.mode === "edit"}
    onConfirm={(latex) => {
      if (editor) {
        if (equationDialog?.mode === "edit") {
          updateApaEquationAt(editor, equationDialog.pos, latex);
        } else {
          insertApaEquation(editor, latex);
        }
      }
      equationDialog = null;
    }}
    onClose={() => (equationDialog = null)}
  />
{/if}

<style>
  /* Live APA check pill + popover. The jump buttons deliberately reuse the
     `.menu button` base styles; only the fix buttons restyle, scoped under
     .apa-check-menu so they outrank the `.menu button` selector. */
  .apa-pill {
    color: var(--success);
  }

  .apa-pill.bad {
    color: var(--warn-strong);
  }

  .apa-pill-count {
    min-width: 18px;
    height: 18px;
    border-radius: var(--r-pill);
    background: var(--warn-strong);
    color: var(--accent-on);
    font-size: var(--t-small);
    font-weight: var(--w-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--sp-1);
  }

  .apa-check-menu {
    min-width: 260px;
    max-height: 320px;
    overflow-y: auto;
  }

  .apa-check-row {
    display: flex;
    align-items: center;
    padding-right: var(--sp-2);
  }

  .apa-check-jump {
    flex: 1;
  }

  .apa-check-menu .apa-check-fix,
  .apa-check-menu .apa-fix-all {
    border: 1px solid var(--warn-strong);
    background: none;
    color: var(--warn-strong);
    border-radius: var(--r-sm);
    padding: var(--sp-05) var(--sp-2);
    font-size: var(--t-caption);
    white-space: nowrap;
  }

  .apa-check-menu .apa-check-fix:hover,
  .apa-check-menu .apa-fix-all:hover {
    background: var(--warn-soft);
  }

  .apa-check-menu .apa-fix-all {
    display: block;
    margin: var(--sp-2) var(--sp-2) var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
  }

  /* Buttons come from the global styles/controls.css — .btn and its
     variants are defined once, app-wide. Nothing button-shaped here. */

  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--canvas);
    /* Anchos de los paneles laterales y alto del header. Viven acá (y no en
       .shell) porque la barra flotante es hermana del shell y necesita leerlos
       para anclarse al borde del canvas. --header-h es el alto de 40px del
       .titlebar, incluido su borde inferior de 1px (con box-sizing: border-box). */
    --outline-w: 248px;
    --refs-w: 312px;
    --header-h: 40px;
  }

  .app.no-outline { --outline-w: 0px; }
  .app.no-refs { --refs-w: 0px; }

  .app.no-outline.no-refs,
  .app.focus {
    --outline-w: 0px;
    --refs-w: 0px;
  }

  .titlebar {
    height: 40px;
    flex: 0 0 40px;
    display: grid;
    grid-template-columns: 1fr minmax(0, auto) auto 1fr;
    align-items: center;
    padding: 0 var(--sp-3);
    background: var(--chrome);
    border-bottom: 1px solid var(--border);
    user-select: none;
    -webkit-user-select: none;
  }

  .tb-left {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .traffic-space {
    width: 62px;
  }

  .tb-title {
    justify-self: center;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--t-body);
    color: var(--muted);
    max-width: 46vw;
    overflow: hidden;
  }

  .tb-title b {
    color: var(--fg-2);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .coach-mode {
    display: inline-flex;
    justify-self: center;
    margin-inline: var(--sp-4);
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    background: var(--canvas);
  }

  .coach-mode button {
    min-height: 26px;
    border: 0;
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--muted);
    padding: 2px 10px;
    font: inherit;
    font-size: var(--t-caption);
    font-weight: 600;
    cursor: pointer;
  }

  .coach-mode button[aria-pressed="true"] {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .coach-mode button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .coach-write-status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .mark {
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    border-radius: 5px;
    background: var(--accent);
    color: var(--accent-on);
    display: grid;
    place-items: center;
    font-family: var(--serif);
    font-weight: 700;
    font-size: var(--t-caption);
  }

  .tb-actions {
    justify-self: end;
    display: flex;
    gap: var(--sp-1);
  }

  .icon-btn {
    width: 30px;
    height: 30px;
    border: none;
    background: none;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    color: var(--muted);
    cursor: pointer;
    transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
  }

  .icon-btn:hover {
    background: var(--hover);
    color: var(--fg);
  }

  .icon-btn.on {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .icon-btn :global(svg) {
    width: 16px;
    height: 16px;
  }

  .shell {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--outline-w) 1fr var(--refs-w);
    transition: grid-template-columns 220ms var(--ease);
  }

  .shell.study-mode {
    grid-template-columns: 1fr;
  }

  .shell.study-mode .outline,
  .shell.study-mode .refs {
    display: none;
  }

  .outline {
    background: var(--chrome);
    border-right: 1px solid var(--border);
    overflow: hidden auto;
    padding: var(--sp-5) var(--sp-3);
    transition: opacity 220ms var(--ease);
  }

  .no-outline .outline,
  .focus .outline {
    opacity: 0;
    pointer-events: none;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-3);
  }

  .panel-head h4 {
    margin: 0;
    font-size: var(--t-caption);
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
  }

  .panel-head-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-15);
  }




  .add-wrap {
    position: relative;
  }

  .fm-export-wrap {
    position: relative;
    display: flex;
  }

  /* Opens upward: the export control sits on the bottom dock, so a menu
     anchored below it would render off-screen. */
  .fm-export-wrap .export-menu {
    top: auto;
    bottom: 115%;
    right: 0;
    min-width: 150px;
  }

  .mini {
    width: 22px;
    height: 22px;
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--muted);
    cursor: pointer;
  }

  .mini:hover {
    color: var(--accent-text);
    border-color: var(--accent);
  }

  .menu {
    position: absolute;
    /* Anchored to the button's right edge so it opens into the column, not
       past it — the .outline column clips horizontal overflow. */
    right: 0;
    top: 115%;
    /* Shell from `.popover` in controls-v2.css; this used --r-sm. */
    display: flex;
    flex-direction: column;
    min-width: 170px;
    z-index: 20;
    overflow: hidden;
  }

  .menu button {
    border: none;
    background: none;
    font-size: var(--t-small);
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    color: var(--fg);
    white-space: nowrap;
  }

  .menu button:hover {
    background: var(--hover);
  }

  .out-item {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    width: 100%;
    text-align: left;
    padding: var(--sp-15) var(--sp-2);
    border: none;
    background: none;
    border-radius: var(--r-sm);
    color: var(--fg-2);
    font-size: var(--t-body);
    cursor: pointer;
    transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
  }

  .out-item:hover {
    background: var(--hover);
  }

  .out-item.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }

  .out-item .n {
    font-family: var(--mono);
    font-size: var(--t-caption);
    color: var(--muted);
    width: 16px;
    flex: 0 0 auto;
  }

  .out-item.active .n {
    color: var(--accent-text);
  }

  .out-item .wc {
    margin-left: auto;
    font-family: var(--mono);
    font-size: var(--t-caption);
    color: var(--muted);
  }

  .out-item.sub {
    padding-left: var(--sp-6);
    font-size: var(--t-small);
    color: var(--muted);
  }

  .out-progress {
    margin-top: var(--sp-5);
    padding: var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
  }

  .out-progress .pl {
    font-size: var(--t-caption);
    color: var(--muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--sp-2);
  }

  .out-progress .goal-btn {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .out-progress .goal-btn:hover {
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .out-progress .goal-input {
    font: inherit;
    width: 6.5em;
    padding: 1px var(--sp-1);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    background: var(--bg);
    color: var(--fg);
    outline: none;
  }

  .bar {
    height: 6px;
    border-radius: var(--r-pill);
    background: var(--hover);
    overflow: hidden;
  }

  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: var(--r-pill);
    transition: width 220ms var(--ease);
  }

  .canvas {
    overflow-y: auto;
    scroll-behavior: smooth;
    min-width: 0;
    padding: var(--sp-8) var(--sp-6) 8rem;
    box-sizing: border-box;
  }

  .paper-fit-viewport {
    width: 100%;
  }

  .coach-hidden {
    display: none;
  }

  /* The stacked page-sheets: the cover plus one sheet per document section
     (body, references, appendices) painted inside the editor. */
  .sheet-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    transform-origin: top left;
  }

  .paper-scale-outer {
    position: relative;
    margin-inline: auto;
  }

  .sheet-stack :global(.apa-editor) {
    padding: 0;
    width: 816px;
    min-height: 0;
  }

  .preview-host {
    padding-bottom: 4rem;
  }

  .refs {
    background: var(--chrome);
    border-left: 1px solid var(--border);
    overflow: hidden auto;
    padding: var(--sp-5) var(--sp-4);
    transition: opacity 220ms var(--ease);
  }

  .no-refs .refs,
  .focus .refs {
    opacity: 0;
    pointer-events: none;
  }





  .search-ref {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0 var(--sp-2);
    height: 34px;
    margin: var(--sp-3) 0;
  }

  .search-ref :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--muted);
  }

  .search-ref input {
    border: 0;
    background: none;
    outline: none;
    width: 100%;
    font-size: var(--t-body);
    color: var(--fg);
  }

  .ref-card {
    padding: var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    margin-bottom: var(--sp-2);
    transition: border-color var(--fast) var(--ease);
  }

  .ref-card:hover {
    border-color: color-mix(in oklab, var(--accent), var(--border) 55%);
  }

  .rtxt,
  .ref-card :global(.rtxt) {
    margin: 0 0 var(--sp-2);
    font-family: var(--serif);
    font-size: var(--t-small);
    line-height: 1.5;
    color: var(--fg-2);
    overflow-wrap: anywhere;
  }

  .ref-foot {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  /* Layout hook only — the buttons come from controls-v2.css. */
  .ref-foot .del {
    margin-left: auto;
  }

  /* .fm-btn lives in the shared float-menu.css (imported above) so the
     standalone Heading/List menu components style their triggers identically. */

  .fm-sep {
    width: 1px;
    height: 22px;
    background: var(--border);
    margin: 0 var(--sp-05);
  }

  .fm-count {
    font-family: var(--mono);
    font-size: var(--t-caption);
    color: var(--muted);
    padding: 0 var(--sp-3) 0 var(--sp-2);
    white-space: nowrap;
  }

  .fab-cite {
    position: relative;
  }

  .bubble {
    position: fixed;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: var(--sp-05);
    padding: var(--sp-1);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-raised);
    transform: translate(-50%, -100%);
  }

  .bubble.show {
    animation: pop 140ms var(--ease);
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-100% + 6px));
    }
  }

  .bb {
    min-width: 30px;
    height: 30px;
    padding: 0 var(--sp-2);
    border: none;
    background: none;
    border-radius: var(--r-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--t-body);
    font-weight: 600;
    color: var(--fg-2);
    cursor: pointer;
    transition: background var(--fast) var(--ease);
  }

  .bb:hover {
    background: var(--hover);
  }

  .bb.it {
    font-style: italic;
    font-family: var(--serif);
  }

  .bb.un {
    text-decoration: underline;
  }

  .bb-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 var(--sp-1);
  }

  .statusbar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-15) var(--sp-4);
    border-top: 1px solid var(--border);
    background: var(--chrome);
    font-family: var(--mono);
    font-size: var(--t-caption);
    color: var(--muted);
    transition: opacity 220ms var(--ease);
  }

  .statusbar.dim {
    opacity: 0.5;
  }

  .statusbar .sep {
    color: var(--border);
  }

  .statusbar .lang,
  .statusbar .version {
    border: none;
    background: none;
    font: inherit;
    cursor: pointer;
    padding: 0 var(--sp-05);
    flex: 0 0 auto;
  }

  .statusbar .lang {
    color: var(--accent-text);
  }

  .statusbar .version {
    color: inherit;
  }

  .statusbar .version:hover,
  .statusbar .version:focus-visible {
    color: var(--accent-text);
  }

  .export-msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 32%;
  }

  .saved {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-15);
    color: var(--success);
  }

  .saved[data-status="guardando"] {
    color: var(--muted);
  }

  .saved[data-status="error"] {
    color: var(--danger);
  }

  .saved .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* BibTeX file-read errors (too big / unreadable), mirroring the library. */
  .bib-error-toast {
    position: fixed;
    top: 52px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    max-width: min(90vw, 520px);
    padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
    border-radius: var(--r-md);
    background: var(--warn-soft);
    color: var(--warn-strong);
    border: 1px solid var(--warn);
    box-shadow: var(--elev-raised);
    font-size: var(--t-body);
  }

  .bib-error-x {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: var(--t-h3);
    line-height: 1;
    padding: 0 var(--sp-05);
  }

  @media (max-width: 600px) {
    .titlebar {
      grid-template-columns: auto 1fr auto;
      padding-inline: var(--sp-1);
    }

    .tb-title {
      display: none;
    }

    .traffic-space {
      width: 0;
    }

    .coach-mode {
      margin-inline: var(--sp-1);
    }

    .coach-mode button {
      padding-inline: var(--sp-2);
      white-space: nowrap;
    }

    .tb-actions button:nth-child(1),
    .tb-actions button:nth-child(2) {
      display: none;
    }

    .canvas {
      padding-inline: var(--sp-2);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .canvas {
      scroll-behavior: auto;
    }

    .shell,
    .outline,
    .refs,
    .bar > span,
    .out-item,
    .icon-btn,
    .statusbar {
      transition: none;
    }

    .bubble.show {
      animation: none;
    }
  }
</style>
