import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { createTesinaEditor } from "../../createEditor.ts";
import { createPaginationMeasurer } from "../measure.ts";
import {
  createDisposablePaginationProofPlugin,
  setDisposablePaginationProofPlan,
} from "./disposablePaginationProof.ts";
import { createLongDocumentFixtures } from "./longDocumentFixture.ts";
import {
  createNativeProofBridge,
  type NativeProofBridgeScope,
} from "./nativeBridge.ts";
import {
  createNativeManualEvidence,
  nativeManualChecks,
  type NativeManualEvidenceMode,
  recordNativeManualEvidence,
} from "./nativeManualEvidence.ts";
import {
  NATIVE_INPUT_PROTOCOL_VERSION,
  parseNativeManualInputMessage,
  WINDOWS_NATIVE_INPUT_DRIVER,
} from "./nativeManualInputProtocol.ts";
import { startProofPageWatchdog } from "./proofPageWatchdog.ts";
import "./nativeManualProof.css";

const nativeScope = globalThis as unknown as NativeProofBridgeScope;
const nativeBridge = createNativeProofBridge(nativeScope);
const evidenceMode: NativeManualEvidenceMode =
  nativeScope.__TESINA_NATIVE_INPUT_DRIVER__ === WINDOWS_NATIVE_INPUT_DRIVER
    ? "windows-driven"
    : "human";
const shell = requireElement<HTMLElement>("#proof-shell");
const mount = requireElement<HTMLElement>("#proof-mount");
const instructions = requireElement<HTMLElement>("#manual-instructions");
const finishButton = requireElement<HTMLButtonElement>("#manual-finish");
const resultElement = requireElement<HTMLElement>("#proof-result");

let evidence = createNativeManualEvidence();
let editor: Editor | undefined;
let gapPos = -1;
let finished = false;
let pasteDocumentJson: string | undefined;
let deadKeyBaseline:
  | {
    json: string;
    documentSize: number;
    selectionFrom: number;
    selectionTo: number;
    insertionPos: number;
  }
  | undefined;
let deadKeyAcknowledgementPosted = false;
let deadKeyOutcomePosted = false;
let copiedDocumentJson: string | null = null;
let copyRightKeys = 0;
let collapseAcknowledged = false;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing manual-proof element: ${selector}`);
  return element;
}

function positionOfParagraph(doc: PMNode, needle: string): number {
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.type.name === "paragraph" && node.textContent.includes(needle)) {
      result = pos;
      return false;
    }
    return true;
  });
  if (result < 0) throw new Error(`Missing manual-proof paragraph: ${needle}`);
  return result;
}

function domPosition(node: Node | null, offset: number): number | null {
  if (!editor || !node) return null;
  try {
    return editor.view.posAtDOM(node, offset);
  } catch {
    return null;
  }
}

function updateStatus(): void {
  const status = nativeManualChecks(evidence, evidenceMode);
  for (const [name, passed] of Object.entries(status)) {
    const element = requireElement<HTMLElement>(`#manual-${name}`);
    element.dataset["passed"] = String(passed);
    element.textContent = `${element.textContent?.split(":")[0]}: ${
      passed ? "captured" : "pending"
    }`;
  }
  finishButton.disabled = evidenceMode === "windows-driven" ||
    !Object.values(status).every(Boolean);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function postNativeInput(value: unknown): void {
  if (evidenceMode !== "windows-driven" || finished) return;
  try {
    const message = parseNativeManualInputMessage(value);
    if (!nativeBridge.postNativeInput(message)) {
      finish(false, "Windows native input channel is unavailable");
    }
  } catch (error) {
    finish(false, `Native input acknowledgement failed: ${String(error)}`);
  }
}

function inspectMouseSelection(event: MouseEvent): void {
  if (!event.isTrusted || gapPos < 0) return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return;
  const anchor = domPosition(selection.anchorNode, selection.anchorOffset);
  const focus = domPosition(selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return;
  const prior = evidence;
  evidence = recordNativeManualEvidence(evidence, {
    kind: "mouse-up",
    isTrusted: event.isTrusted,
    selectionFrom: anchor,
    selectionTo: focus,
    gapPosition: gapPos,
    selectedText: selection.toString(),
  });
  updateStatus();
  if (
    evidence !== prior && evidence.selectionFrom !== null &&
    evidence.selectionTo !== null && evidence.gapPosition !== null
  ) {
    postNativeInput({
      version: NATIVE_INPUT_PROTOCOL_VERSION,
      stage: "drag",
      selectionFrom: evidence.selectionFrom,
      selectionTo: evidence.selectionTo,
      gapPosition: evidence.gapPosition,
      selectedText: evidence.selectedText,
    });
  }
}

document.addEventListener("keydown", (event) => {
  evidence = recordNativeManualEvidence(evidence, {
    kind: "key-down",
    isTrusted: event.isTrusted,
    key: event.key,
    code: event.code,
    isComposing: event.isComposing,
    ctrlKey: event.ctrlKey,
  });
  if (
    evidenceMode === "windows-driven" && event.isTrusted &&
    event.key === "Dead" && editor
  ) {
    if (deadKeyAcknowledgementPosted) {
      finish(false, "Duplicate trusted Dead keydown was received");
      return;
    }
    if (!nativeManualChecks(evidence, evidenceMode).paste) {
      finish(
        false,
        "Dead-key input started before exact native paste evidence",
      );
      return;
    }
    if (evidence.caretAfterPos === null) {
      finish(false, "Dead-key input started before exact caret evidence");
      return;
    }
    const selection = editor.state.selection;
    if (
      !editor.isFocused || !selection.empty ||
      selection.from !== evidence.caretAfterPos
    ) {
      finish(
        false,
        "Dead-key input started without the acknowledged ProseMirror caret",
      );
      return;
    }
    deadKeyBaseline = {
      json: JSON.stringify(editor.getJSON()),
      documentSize: editor.state.doc.content.size,
      selectionFrom: selection.from,
      selectionTo: selection.to,
      insertionPos: selection.from,
    };
    deadKeyAcknowledgementPosted = true;
    updateStatus();
    postNativeInput({
      version: NATIVE_INPUT_PROTOCOL_VERSION,
      stage: "dead-keydown",
      documentSize: deadKeyBaseline.documentSize,
      insertionPos: deadKeyBaseline.insertionPos,
    });
  }
  updateStatus();
}, true);
document.addEventListener("compositionstart", (event) => {
  evidence = recordNativeManualEvidence(evidence, {
    kind: "composition-start",
    isTrusted: event.isTrusted,
    beforeSize: editor?.state.doc.content.size ?? -1,
  });
  updateStatus();
}, true);
document.addEventListener("compositionupdate", (event) => {
  evidence = recordNativeManualEvidence(evidence, {
    kind: "composition-update",
    isTrusted: event.isTrusted,
  });
  updateStatus();
}, true);
document.addEventListener("compositionend", (event) => {
  if (!event.isTrusted) return;
  const data = event.data;
  requestAnimationFrame(() => {
    evidence = recordNativeManualEvidence(evidence, {
      kind: "composition-end",
      isTrusted: event.isTrusted,
      data,
      afterSize: editor?.state.doc.content.size ?? -1,
    });
    updateStatus();
  });
}, true);
document.addEventListener("copy", (event) => {
  if (!event.isTrusted) return;
  const selectedText = document.getSelection()?.toString() ?? "";
  const prior = evidence;
  evidence = recordNativeManualEvidence(evidence, {
    kind: "copy",
    isTrusted: event.isTrusted,
    selectedText,
    documentSize: editor?.state.doc.content.size ?? -1,
  });
  updateStatus();
  if (evidence !== prior && evidence.copyDocumentSize !== null) {
    copiedDocumentJson = JSON.stringify(editor?.getJSON());
    copyRightKeys = evidence.rightKeys;
    requestAnimationFrame(() =>
      postNativeInput({
        version: NATIVE_INPUT_PROTOCOL_VERSION,
        stage: "copy",
        selectedText: evidence.selectedText,
        documentSize: evidence.copyDocumentSize,
      })
    );
  }
}, true);
document.addEventListener("paste", (event) => {
  if (!event.isTrusted) return;
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  const beforeSize = editor?.state.doc.content.size ?? -1;
  requestAnimationFrame(() => {
    const selection = editor?.state.selection;
    if (
      evidenceMode === "windows-driven" &&
      (!selection || !selection.empty)
    ) {
      finish(false, "Native paste did not leave a collapsed ProseMirror caret");
      return;
    }
    if (evidenceMode === "windows-driven") {
      pasteDocumentJson = JSON.stringify(editor?.getJSON());
    }
    const prior = evidence;
    evidence = recordNativeManualEvidence(evidence, {
      kind: "paste",
      isTrusted: event.isTrusted,
      pastedText,
      beforeSize,
      afterSize: editor?.state.doc.content.size ?? -1,
      selectionPos: selection?.from ?? -1,
    });
    updateStatus();
    if (
      evidence !== prior && evidence.pasteBeforeSize !== null &&
      evidence.pasteAfterSize !== null && evidence.pasteSelectionPos !== null
    ) {
      postNativeInput({
        version: NATIVE_INPUT_PROTOCOL_VERSION,
        stage: "paste",
        pastedText: evidence.pastedText,
        beforeSize: evidence.pasteBeforeSize,
        afterSize: evidence.pasteAfterSize,
        selectionPos: evidence.pasteSelectionPos,
      });
    }
  });
}, true);
document.addEventListener("mousedown", (event) => {
  evidence = recordNativeManualEvidence(evidence, {
    kind: "mouse-down",
    isTrusted: event.isTrusted,
  });
}, true);
document.addEventListener("mouseup", inspectMouseSelection, true);

function inspectDrivenCollapse(): void {
  if (
    evidenceMode !== "windows-driven" || !editor || finished ||
    collapseAcknowledged || evidence.copies === 0 || evidence.pastes !== 0 ||
    evidence.rightKeys <= copyRightKeys
  ) return;
  const selection = editor.state.selection;
  const documentSize = editor.state.doc.content.size;
  if (
    !editor.isFocused || !selection.empty ||
    selection.from !== evidence.selectionTo ||
    documentSize !== evidence.copyDocumentSize ||
    JSON.stringify(editor.getJSON()) !== copiedDocumentJson
  ) {
    finish(
      false,
      "Native ArrowRight did not collapse the copied selection in the unchanged document",
    );
    return;
  }
  collapseAcknowledged = true;
  postNativeInput({
    version: NATIVE_INPUT_PROTOCOL_VERSION,
    stage: "collapsed",
    documentSize,
    selectionPos: selection.from,
  });
}

function inspectDrivenCaret(): void {
  if (
    evidenceMode !== "windows-driven" || !editor || finished ||
    evidence.caretAfterPos !== null || evidence.pasteAfterSize === null ||
    evidence.pasteSelectionPos === null || evidence.pasteRightKeys === null ||
    evidence.rightKeys <= evidence.pasteRightKeys
  ) return;
  const selection = editor.state.selection;
  const documentSize = editor.state.doc.content.size;
  const beforePos = evidence.pasteSelectionPos;
  const afterPos = selection.from;
  if (
    !editor.isFocused || documentSize !== evidence.pasteAfterSize ||
    JSON.stringify(editor.getJSON()) !== pasteDocumentJson ||
    !selection.empty ||
    selection.to !== afterPos || afterPos !== beforePos + 1
  ) {
    finish(
      false,
      `Native ArrowRight did not produce the exact ProseMirror caret advance (size=${documentSize}, selection=${selection.from}-${selection.to}, expected=${
        beforePos + 1
      })`,
    );
    return;
  }
  const prior = evidence;
  evidence = recordNativeManualEvidence(evidence, {
    kind: "caret-outcome",
    documentSize,
    beforePos,
    afterPos,
  });
  if (evidence === prior) {
    finish(false, "Native ArrowRight evidence was rejected");
    return;
  }
  updateStatus();
  postNativeInput({
    version: NATIVE_INPUT_PROTOCOL_VERSION,
    stage: "caret",
    documentSize,
    beforePos,
    afterPos,
  });
}

function inspectDrivenTransaction(): void {
  if (
    evidenceMode !== "windows-driven" || !editor || !deadKeyBaseline || finished
  ) return;
  const documentSize = editor.state.doc.content.size;
  if (!deadKeyOutcomePosted) {
    if (documentSize === deadKeyBaseline.documentSize) return;
    if (documentSize !== deadKeyBaseline.documentSize + 1) {
      finish(false, "Dead-key input changed more than one authored character");
      return;
    }
    const insertionPos = deadKeyBaseline.insertionPos;
    const insertedText = editor.state.doc.textBetween(
      insertionPos,
      insertionPos + 1,
      "\n",
      "\n",
    );
    const documentWithoutInsertion = editor.state.tr.delete(
      insertionPos,
      insertionPos + 1,
    ).doc;
    const selection = editor.state.selection;
    const exactDelta = insertedText === "é" &&
      JSON.stringify(documentWithoutInsertion.toJSON()) ===
        deadKeyBaseline.json &&
      selection.empty && selection.from === insertionPos + 1;
    if (!exactDelta) {
      finish(
        false,
        `Dead-key input did not produce the exact authored é delta (pos=${insertionPos}, text=${
          JSON.stringify(insertedText)
        }, selection=${selection.from}-${selection.to}, size=${documentSize})`,
      );
      return;
    }
    evidence = recordNativeManualEvidence(evidence, {
      kind: "dead-key-outcome",
      data: insertedText,
      beforeSize: deadKeyBaseline.documentSize,
      afterSize: documentSize,
      insertionPos,
    });
    deadKeyOutcomePosted = true;
    updateStatus();
    postNativeInput({
      version: NATIVE_INPUT_PROTOCOL_VERSION,
      stage: "dead-key",
      data: insertedText,
      beforeSize: deadKeyBaseline.documentSize,
      afterSize: documentSize,
      insertionPos,
    });
    return;
  }
  if (evidence.undoKeys === 0) return;
  const selection = editor.state.selection;
  const documentRestored = JSON.stringify(editor.getJSON()) ===
    deadKeyBaseline.json;
  const selectionRestored = selection.from === deadKeyBaseline.selectionFrom &&
    selection.to === deadKeyBaseline.selectionTo;
  evidence = recordNativeManualEvidence(evidence, {
    kind: "undo-outcome",
    documentSize,
    documentRestored,
    selectionRestored,
  });
  updateStatus();
  postNativeInput({
    version: NATIVE_INPUT_PROTOCOL_VERSION,
    stage: "undo",
    documentSize,
    documentRestored,
    selectionRestored,
  });
  if (
    Object.values(nativeManualChecks(evidence, evidenceMode)).every(Boolean)
  ) {
    finish(true);
  } else {
    finish(
      false,
      "Native undo did not restore exact document and selection identity",
    );
  }
}

const watchdog = startProofPageWatchdog(
  evidenceMode === "windows-driven" ? 40_000 : 240_000,
  () => {
    finish(false, "Manual native-input evidence timed out");
  },
);

function finish(passed: boolean, error?: string): void {
  if (finished) return;
  finished = true;
  watchdog.cancel();
  const checks = nativeManualChecks(evidence, evidenceMode);
  const resultPassed = passed && Object.values(checks).every(Boolean);
  const result = {
    passed: resultPassed,
    engine: navigator.userAgent,
    checks: {
      nativeComposedCharacterInput: checks.ime,
      nativeClipboard: checks.copy && checks.paste,
      nativeMouseDragAcrossGap: checks.drag,
    },
    metrics: {
      compositionStarts: evidence.compositionStarts,
      compositionUpdates: evidence.compositionUpdates,
      compositionEnds: evidence.compositionEnds,
      deadKeys: evidence.deadKeys,
      deadKeyCode: evidence.deadKeyCode,
      deadKeyAckStage: deadKeyAcknowledgementPosted ? "trusted-keydown" : "",
      rightKeys: evidence.rightKeys,
      pasteSelectionPos: evidence.pasteSelectionPos,
      caretBeforePos: evidence.caretBeforePos,
      caretAfterPos: evidence.caretAfterPos,
      caretDocumentSize: evidence.caretDocumentSize,
      deadKeyBeforeSize: evidence.deadKeyBeforeSize,
      deadKeyAfterSize: evidence.deadKeyAfterSize,
      deadKeyInsertionPos: evidence.deadKeyInsertionPos,
      deadKeyData: evidence.deadKeyData,
      undoKeys: evidence.undoKeys,
      undoDocumentSize: evidence.undoDocumentSize,
      undoDocumentRestored: evidence.undoDocumentRestored,
      undoSelectionRestored: evidence.undoSelectionRestored,
      composingKeys: evidence.composingKeys,
      compositionData: evidence.compositionData,
      copies: evidence.copies,
      pastes: evidence.pastes,
      selectedTextLength: evidence.selectedText.length,
      selectionFrom: evidence.selectionFrom,
      selectionTo: evidence.selectionTo,
      gapPosition: evidence.gapPosition ?? gapPos,
      inputDriver: evidenceMode === "windows-driven"
        ? WINDOWS_NATIVE_INPUT_DRIVER
        : "human",
    },
    ...(error
      ? { error }
      : resultPassed
      ? {}
      : { error: "Native input evidence is incomplete" }),
  };
  resultElement.textContent = JSON.stringify(result, null, 2);
  nativeBridge.postResult(result);
}

finishButton.addEventListener("click", () => finish(true));

async function prepare(): Promise<void> {
  const fixture = createLongDocumentFixtures().en;
  editor = createTesinaEditor({
    element: mount,
    content: fixture.content,
    newlyCreated: true,
    citationEnv: {
      refsById: new Map(fixture.references.map((ref) => [ref.id, ref])),
      locale: "en",
    },
    referenceEnv: {
      references: fixture.references,
      locale: "en",
      emptyLabel: "unused",
    },
    paginationEnv: null,
  });
  editor.registerPlugin(createDisposablePaginationProofPlugin());
  editor.on("transaction", inspectDrivenTransaction);
  editor.on("selectionUpdate", inspectDrivenCaret);
  editor.on("selectionUpdate", inspectDrivenCollapse);
  const paragraphPos = positionOfParagraph(
    editor.state.doc,
    "Invented paragraph 1",
  );
  const measurer = createPaginationMeasurer({
    view: editor.view,
    onInvalidate: () => {},
  });
  try {
    const measurement = await measurer.read({
      epoch: 1,
      signal: new AbortController().signal,
      latestEpoch: () => 1,
    });
    if (measurement.status !== "measured") {
      throw new Error("Manual native measurement became stale");
    }
    const lines = measurement.fragments.filter((fragment) =>
      fragment.lineGroup?.id === `text:${paragraphPos}`
    );
    if (lines.length < 3) throw new Error("Manual paragraph has too few lines");
    gapPos = lines[2]!.breakBefore.pos;
    setDisposablePaginationProofPlan(editor, {
      epoch: 1,
      gaps: [{ kind: "line", pos: gapPos, height: 180 }],
    });
    await nextFrame();
    shell.dataset["firstPlan"] = "stable";
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, gapPos - 2),
      ).scrollIntoView(),
    );
    const gapElement = requireElement<HTMLElement>(
      "[data-pagination-proof-gap='line']",
    );
    gapElement.scrollIntoView({ block: "center" });
    await nextFrame();
    editor.view.focus();
    instructions.textContent = evidenceMode === "windows-driven"
      ? "The Win32 native-input driver is verifying drag, clipboard, exact dead-key input, and one-step undo."
      : "Drag across the gray page gap, copy and paste, then enter a composed character (for example Option-E then E).";
    document.body.dataset["manualReady"] = "true";
    updateStatus();
    if (evidenceMode === "windows-driven") {
      const start = editor.view.coordsAtPos(gapPos - 4);
      const end = editor.view.coordsAtPos(gapPos + 4);
      const gap = gapElement.getBoundingClientRect();
      postNativeInput({
        version: NATIVE_INPUT_PROTOCOL_VERSION,
        stage: "ready",
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        gap: { top: gap.top, bottom: gap.bottom },
        dragStart: {
          x: (start.left + start.right) / 2,
          y: (start.top + start.bottom) / 2,
        },
        dragEnd: {
          x: (end.left + end.right) / 2,
          y: (end.top + end.bottom) / 2,
        },
      });
    }
  } finally {
    measurer.destroy();
  }
}

prepare().catch((error: unknown) => {
  finish(false, error instanceof Error ? error.message : String(error));
});
