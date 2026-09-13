// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { undoDepth } from "@tiptap/pm/history";
import { NODE_NAMES } from "@tesina/engine";
import { createTesinaEditor } from "$lib/editor/createEditor.ts";
import { refreshCitations } from "$lib/editor/citation.ts";
import { analyzeCoachPassages } from "./analysisAdapter.ts";
import { createWritingCoachController } from "./controller.ts";
import { createCoachSuppression, mapCoachSuppression } from "./mapping.ts";
import type { CoachEditorBridge, CoachEditorHandle } from "./editorPlugin.ts";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

function createHarness(text: string) {
  const element = document.createElement("div");
  document.body.append(element);
  let handle: CoachEditorHandle | null = null;
  const attachments: Array<CoachEditorHandle | null> = [];
  const transactions: Parameters<
    NonNullable<CoachEditorBridge["onTransaction"]>
  >[0][] = [];
  const bridge: CoachEditorBridge = {
    currentRevision: () => 1,
    attach: (next) => {
      handle = next;
      attachments.push(next);
    },
    onTransaction: (event) => transactions.push(event),
  };
  const editor = createTesinaEditor({
    element,
    content: {
      type: "doc",
      content: [{
        type: NODE_NAMES.sectionBody,
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      }],
    },
    newlyCreated: false,
    citationEnv: { refsById: new Map(), locale: "en" },
    referenceEnv: { references: [], locale: "en", emptyLabel: "None" },
    paginationEnv: null,
    coachBridge: bridge,
  });
  if (!handle) throw new Error("coach editor bridge was not attached");
  return {
    editor,
    element,
    handle: handle as CoachEditorHandle,
    transactions,
    attachments,
  };
}

afterEach(() => document.body.replaceChildren());

describe("schema-free coach editor bridge", () => {
  it("keeps discarded state application pure and emits an installed transaction once", () => {
    const { editor, transactions } = createHarness(
      "The policy changed during review.",
    );
    const transaction = editor.state.tr
      .insertText("Earlier ", 2)
      .setMeta("apa:external", true);
    const installedState = editor.state.apply(transaction);

    expect(transactions).toEqual([]);

    editor.view.updateState(installedState);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toEqual({
      mapping: transaction.mapping,
      doc: installedState.doc,
      docChanged: true,
      externalCitationRefresh: true,
      citationEnvironmentVersion: 1,
    });

    editor.view.updateState(installedState);
    expect(transactions).toHaveLength(1);
    editor.destroy();
  });

  it("emits one ordered mapping for root and appended transactions", () => {
    const { editor, handle, transactions } = createHarness(
      "The policy changed in many ways during review.",
    );
    const analyzed = analyzeCoachPassages(
      handle.capture("essay-1").passages,
      1,
    );
    if (analyzed.status !== "available") throw new Error("expected analysis");
    const suppression = createCoachSuppression(analyzed.issues[0]!, "dismiss");
    let appendedInsideSuppression: number | null = null;
    const APPENDED = "test:coach-appended-transaction";
    editor.registerPlugin(
      new Plugin({
        appendTransaction(rootTransactions, _oldState, newState) {
          if (
            !rootTransactions.some((transaction) => transaction.docChanged) ||
            rootTransactions.some((transaction) =>
              transaction.getMeta(APPENDED)
            )
          ) return null;
          const position = appendedInsideSuppression ??
            newState.doc.content.size - 2;
          return newState.tr.insertText(
            appendedInsideSuppression === null ? " Tail" : "x",
            position,
          ).setMeta(APPENDED, true);
        },
      }),
    );
    transactions.length = 0;

    editor.view.dispatch(
      editor.state.tr.insertText("Earlier ", 2).setMeta("apa:external", true),
    );

    expect(transactions).toHaveLength(1);
    const firstEvent = transactions[0]!;
    expect(firstEvent.docChanged).toBe(true);
    expect(firstEvent.externalCitationRefresh).toBe(true);
    expect(firstEvent.doc).toBe(editor.state.doc);
    expect(firstEvent.citationEnvironmentVersion).toBe(
      handle.capture("essay-1").citationEnvironmentVersion,
    );
    const shifted = mapCoachSuppression(
      suppression,
      firstEvent.mapping,
      (range) => firstEvent.doc.textBetween(range.from, range.to, "", ""),
    );
    expect(shifted?.editorRange).toEqual({
      from: suppression.editorRange.from + 8,
      to: suppression.editorRange.to + 8,
    });

    transactions.length = 0;
    appendedInsideSuppression = shifted!.editorRange.from + 1;
    editor.view.dispatch(
      editor.state.tr.insertText(" End", editor.state.doc.content.size - 2),
    );

    expect(transactions).toHaveLength(1);
    const secondEvent = transactions[0]!;
    expect(mapCoachSuppression(
      shifted!,
      secondEvent.mapping,
      (range) => secondEvent.doc.textBetween(range.from, range.to, "", ""),
    )).toBeNull();
    editor.destroy();
  });

  it("captures exact passages and reports document and external citation transactions", () => {
    const { editor, handle, transactions } = createHarness(
      "The policy changed in many ways during review.",
    );
    const beforeSchema = Object.keys(editor.schema.nodes);
    const snapshot = handle.capture("essay-1");
    expect(snapshot.passages.map((passage) => passage.text)).toEqual([
      "The policy changed in many ways during review.",
    ]);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.citationEnvironmentVersion).toBe(0);
    editor.commands.insertContentAt(2, "Earlier ");
    expect(handle.capture("essay-1").citationEnvironmentVersion).toBe(0);
    refreshCitations(editor);
    expect(handle.capture("essay-1").citationEnvironmentVersion).toBe(1);
    expect(transactions.some((event) => event.docChanged)).toBe(true);
    expect(transactions.some((event) => event.externalCitationRefresh)).toBe(
      true,
    );
    expect(Object.keys(editor.schema.nodes)).toEqual(beforeSchema);
    editor.destroy();
  });

  it("selects only an exact current repeated range without content or history mutation", () => {
    const { editor, handle } = createHarness(
      "The policy changed in many ways, while the method changed in many ways.",
    );
    const baselineJson = JSON.stringify(editor.getJSON());
    const baselineUndo = undoDepth(editor.state);
    const focus = vi.spyOn(editor.view, "focus").mockImplementation(() => {});
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const analyzed = analyzeCoachPassages(
      handle.capture("essay-1").passages,
      1,
    );
    if (analyzed.status !== "available") throw new Error("expected analysis");
    const second = analyzed.issues.filter((item) =>
      item.issue.observedText === "in many ways"
    )[1]!;
    expect(handle.navigate(second)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(
      dispatch.mock.calls.some(([transaction]) => transaction.scrolledIntoView),
    ).toBe(true);
    expect(editor.state.selection).toMatchObject(second.editorRange);
    expect(JSON.stringify(editor.getJSON())).toBe(baselineJson);
    expect(undoDepth(editor.state)).toBe(baselineUndo);
    expect(handle.getHighlight()).toEqual(second.editorRange);
    editor.destroy();
  });

  it("fails stale navigation without guessing and clears emphasis on selection, source, preview, essay, and teardown", () => {
    const { editor, handle } = createHarness(
      "The policy changed in many ways during review.",
    );
    const analyzed = analyzeCoachPassages(
      handle.capture("essay-1").passages,
      1,
    );
    if (analyzed.status !== "available") throw new Error("expected analysis");
    const issue = analyzed.issues[0]!;
    const selectionBefore = editor.state.selection;
    expect(handle.navigate({ ...issue, editorRange: { from: 30, to: 42 } }))
      .toBe(false);
    expect(editor.state.selection.eq(selectionBefore)).toBe(true);
    expect(handle.navigate(issue)).toBe(true);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)),
    );
    expect(handle.getHighlight()).toBeNull();
    expect(handle.navigate(issue)).toBe(true);
    editor.commands.insertContentAt(issue.editorRange.from, "x");
    expect(handle.getHighlight()).toBeNull();
    refreshCitations(editor);
    expect(handle.getHighlight()).toBeNull();
    const second = createHarness("Various aspects shaped the final review.");
    const secondAnalysis = analyzeCoachPassages(
      second.handle.capture("essay-1").passages,
      1,
    );
    if (secondAnalysis.status !== "available") {
      throw new Error("expected second analysis");
    }
    expect(second.handle.navigate(secondAnalysis.issues[0]!)).toBe(true);
    const enterPreview = () => second.handle.clearHighlight();
    enterPreview();
    expect(second.handle.getHighlight()).toBeNull();
    expect(second.handle.navigate(secondAnalysis.issues[0]!)).toBe(true);
    const switchEssay = () => second.handle.clearHighlight();
    switchEssay();
    expect(second.handle.getHighlight()).toBeNull();
    second.editor.destroy();
    expect(second.handle.getHighlight()).toBeNull();
    expect(second.attachments.at(-1)).toBeNull();
    editor.destroy();
  });

  it("composes return-to-Write with exact controller-to-plugin navigation", async () => {
    const { editor, handle } = createHarness(
      "The policy changed in many ways during review.",
    );
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(handle.capture("essay-1"));
    controller.enterStudy();
    await vi.waitFor(() => expect(controller.getState().status).toBe("issues"));
    let mode: "write" | "study" = "study";
    const baselineJson = JSON.stringify(editor.getJSON());
    const baselineUndo = undoDepth(editor.state);
    const expectedRange = controller.getState().fixed!.issue.editorRange;

    const result = await controller.editCurrentPassage(
      () => {
        mode = "write";
      },
      (issue) => handle.navigate(issue),
    );

    expect(result).toBe("navigated");
    expect(mode).toBe("write");
    expect(editor.state.selection).toMatchObject(expectedRange);
    expect(controller.getState().fixed).toBeNull();
    expect(JSON.stringify(editor.getJSON())).toBe(baselineJson);
    expect(undoDepth(editor.state)).toBe(baselineUndo);
    controller.destroy();
    editor.destroy();
  });
});
