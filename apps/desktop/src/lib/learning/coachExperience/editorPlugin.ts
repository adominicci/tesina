import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import {
  type CitationEnv,
  citationEnvironmentVersion,
  renderCitationText,
} from "$lib/editor/citation.ts";
import { extractCoachPassages } from "./extraction.ts";
import type { CoachAnalysisSnapshot } from "./controller.ts";
import type { EditorRange, MappedCoachIssue } from "./types.ts";

export interface CoachEditorTransaction {
  readonly mapping: Mapping;
  readonly doc: PMNode;
  readonly docChanged: boolean;
  readonly externalCitationRefresh: boolean;
  readonly citationEnvironmentVersion: number;
}

export interface CoachEditorHandle {
  capture(essayId: string): CoachAnalysisSnapshot;
  navigate(issue: MappedCoachIssue): boolean;
  clearHighlight(): void;
  getHighlight(): EditorRange | null;
}

export interface CoachEditorBridge {
  readonly currentRevision: () => number;
  readonly attach: (handle: CoachEditorHandle | null) => void;
  readonly onTransaction?: (event: CoachEditorTransaction) => void;
}

interface CoachPluginState {
  readonly highlight: EditorRange | null;
  readonly decorations: DecorationSet;
  readonly pendingTransaction: CoachEditorTransaction | null;
}

const coachPluginKey = new PluginKey<CoachPluginState>("tesinaWritingCoach");
const SET_HIGHLIGHT = "tesina:coach-highlight";
const CLEAR_HIGHLIGHT = "tesina:coach-clear-highlight";

function pluginState(
  doc: PMNode,
  highlight: EditorRange | null,
  pendingTransaction: CoachEditorTransaction | null = null,
): CoachPluginState {
  return {
    highlight,
    pendingTransaction,
    decorations: highlight
      ? DecorationSet.create(doc, [Decoration.inline(
        highlight.from,
        highlight.to,
        {
          class: "writing-coach-source-emphasis",
          "data-coach-emphasis": "true",
        },
      )])
      : DecorationSet.empty,
  };
}

export function createCoachEditorExtension(
  bridge: CoachEditorBridge,
  citationEnv: CitationEnv,
) {
  return Extension.create({
    name: "tesinaWritingCoachBridge",
    addProseMirrorPlugins() {
      return [
        new Plugin<CoachPluginState>({
          key: coachPluginKey,
          state: {
            init: (_config, state) => pluginState(state.doc, null),
            apply: (transaction, prior, _oldState, newState) => {
              const requested = transaction.getMeta(SET_HIGHLIGHT) as
                | EditorRange
                | undefined;
              const clear = transaction.getMeta(CLEAR_HIGHLIGHT) ||
                transaction.docChanged || transaction.getMeta("apa:external") ||
                (transaction.selectionSet && !requested);
              const highlight = requested ?? (clear ? null : prior.highlight);
              const appended = transaction.getMeta("appendedTransaction") !==
                undefined;
              const mapping = new Mapping();
              if (appended && prior.pendingTransaction) {
                mapping.appendMapping(prior.pendingTransaction.mapping);
              }
              mapping.appendMapping(transaction.mapping);
              const pendingTransaction: CoachEditorTransaction = {
                mapping,
                doc: newState.doc,
                docChanged: transaction.docChanged ||
                  (appended && prior.pendingTransaction?.docChanged === true),
                externalCitationRefresh: Boolean(
                  transaction.getMeta("apa:external") ||
                    (appended &&
                      prior.pendingTransaction?.externalCitationRefresh),
                ),
                citationEnvironmentVersion: citationEnvironmentVersion(
                  newState,
                ),
              };
              return pluginState(newState.doc, highlight, pendingTransaction);
            },
          },
          props: {
            decorations: (state) => coachPluginKey.getState(state)?.decorations,
          },
          view: (view) => {
            let capturedEssayId: string | null = null;
            let emittedTransaction: CoachEditorTransaction | null = null;
            const handle: CoachEditorHandle = {
              capture(essayId) {
                capturedEssayId = essayId;
                const revision = bridge.currentRevision();
                const version = citationEnvironmentVersion(view.state);
                const passages = extractCoachPassages({
                  doc: view.state.doc,
                  essayId,
                  revision,
                  documentLanguage: citationEnv.locale,
                  citationEnvironmentVersion: version,
                  renderCitation: (node, position) =>
                    renderCitationText(view.state, citationEnv, node, position),
                });
                return {
                  essayId,
                  revision,
                  documentLanguage: citationEnv.locale,
                  citationEnvironmentVersion: version,
                  snapshotId: `${essayId}:${revision}:${version}`,
                  passages,
                };
              },
              navigate(issue) {
                const range = issue.editorRange;
                if (
                  capturedEssayId !== issue.passage.essayId ||
                  bridge.currentRevision() !== issue.passage.revision ||
                  citationEnvironmentVersion(view.state) !==
                    issue.passage.citationEnvironmentVersion ||
                  range.from < 0 || range.to > view.state.doc.content.size ||
                  view.state.doc.textBetween(range.from, range.to, "", "") !==
                    issue.issue.observedText
                ) return false;
                const transaction = view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, range.from, range.to),
                  )
                  .setMeta(SET_HIGHLIGHT, range)
                  .setMeta("addToHistory", false)
                  .scrollIntoView();
                view.dispatch(transaction);
                view.focus();
                return true;
              },
              clearHighlight() {
                if (!coachPluginKey.getState(view.state)?.highlight) return;
                view.dispatch(
                  view.state.tr.setMeta(CLEAR_HIGHLIGHT, true).setMeta(
                    "addToHistory",
                    false,
                  ),
                );
              },
              getHighlight() {
                return coachPluginKey.getState(view.state)?.highlight ?? null;
              },
            };
            bridge.attach(handle);
            return {
              update: (updatedView) => {
                const pending = coachPluginKey.getState(updatedView.state)
                  ?.pendingTransaction ?? null;
                if (pending && pending !== emittedTransaction) {
                  emittedTransaction = pending;
                  bridge.onTransaction?.({
                    ...pending,
                    doc: updatedView.state.doc,
                    citationEnvironmentVersion: citationEnvironmentVersion(
                      updatedView.state,
                    ),
                  });
                }
              },
              destroy: () => bridge.attach(null),
            };
          },
        }),
      ];
    },
  });
}
