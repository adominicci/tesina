import { type Content, Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { sectionExtensions } from "./sections.ts";
import { type CitationEnv, createCitationExtension } from "./citation.ts";
import { OrderedListStyleAttr } from "./lists.ts";
import { blockExtensions, createApaEquationExtension } from "./blocks.ts";
import { defaultDoc, ensureSectionedDoc } from "./migrate.ts";
import {
  createReferenceDecorationExtension,
  type ReferenceDecorationEnv,
} from "./referenceDecoration.ts";
import { ApaPresentationDecoration } from "./presentationDecoration.ts";
import { createPaginationExtension } from "./pagination/extension.ts";
import type { PaginationEnvironment } from "./pagination/types.ts";
import {
  createApaCheckExtension,
  type PositionedApaIssue,
} from "./apaCheck.ts";
import {
  type CoachEditorBridge,
  createCoachEditorExtension,
} from "$lib/learning/coachExperience/editorPlugin.ts";

export interface CreateEditorArgs {
  element: HTMLElement;
  /** ProseMirror doc JSON from a saved essay; empty sectioned doc when absent. */
  content?: unknown;
  /** A just-created paper starts at its title-page task, outside ProseMirror. */
  newlyCreated: boolean;
  /** Live library + document language; mutated by the app, see citation.ts. */
  citationEnv: CitationEnv;
  /** Derived references page rendered as editor chrome before appendices. */
  referenceEnv: ReferenceDecorationEnv;
  /** Explicitly null only for layout-free schema/unit fixtures. */
  paginationEnv: PaginationEnvironment | null;
  onUpdate?: (docJson: unknown, words: number) => void;
  /** Live APA structure issues, re-emitted after every doc change. */
  onApaIssues?: (issues: PositionedApaIssue[]) => void;
  /** Opens the LaTeX dialog pre-filled with an equation's current LaTeX, from
   * its pencil menu. External callback threaded into the schema, same shape
   * as `citationEnv`: the app layer owns the dialog, the node view doesn't. */
  onEditEquation?: (pos: number, latex: string) => void;
  /** Optional schema-free deterministic Study bridge owned by EditorScreen. */
  coachBridge?: CoachEditorBridge;
}

export function countWords(doc: PMNode): number {
  const text = doc.textBetween(0, doc.content.size, " ", " ").trim();
  return text === "" ? 0 : text.split(/\s+/).length;
}

/**
 * The M2 editor: APA-relevant marks and blocks only, on top of Tesina's
 * sectioned document (`sectionAbstract? sectionBody sectionAppendix*`).
 * Elements APA papers never contain (code, horizontal rules, strikethrough)
 * are disabled at the schema level so they cannot arrive via paste either.
 * Citations, figures, and footnotes land in later M2 iterations.
 */
export function createTesinaEditor(
  {
    element,
    content,
    newlyCreated,
    citationEnv,
    referenceEnv,
    paginationEnv,
    onUpdate,
    onApaIssues,
    onEditEquation,
    coachBridge,
  }: CreateEditorArgs,
): Editor {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        document: false,
        heading: { levels: [1, 2, 3, 4, 5] },
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
      }),
      ...sectionExtensions,
      OrderedListStyleAttr,
      ...blockExtensions,
      createApaEquationExtension(onEditEquation ?? (() => {})),
      createCitationExtension(citationEnv),
      ...(coachBridge
        ? [createCoachEditorExtension(coachBridge, citationEnv)]
        : []),
      ApaPresentationDecoration,
      createReferenceDecorationExtension(referenceEnv),
      ...(paginationEnv ? [createPaginationExtension(paginationEnv)] : []),
      ...(onApaIssues ? [createApaCheckExtension(onApaIssues)] : []),
    ],
    content: (content !== undefined
      ? ensureSectionedDoc(content)
      : defaultDoc()) as Content,
    autofocus: newlyCreated ? false : "end",
    onUpdate({ editor }) {
      onUpdate?.(editor.getJSON(), countWords(editor.state.doc));
    },
  });
}
