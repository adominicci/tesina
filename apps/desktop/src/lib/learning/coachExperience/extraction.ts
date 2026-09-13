import type { Node as PMNode } from "@tiptap/pm/model";
import { type DocLocale, NODE_NAMES } from "@tesina/engine";
import type { CoachPassageSnapshot, EditorRange } from "./types.ts";

export interface CoachExtractionInput {
  readonly doc: PMNode;
  readonly essayId: string;
  readonly revision: number;
  readonly documentLanguage: DocLocale;
  readonly citationEnvironmentVersion: number;
  readonly renderCitation: (node: PMNode, position: number) => string;
}

const ELIGIBLE_SECTIONS = new Set([
  "sectionAbstract",
  NODE_NAMES.sectionBody,
  "sectionAppendix",
]);
const EXCLUDED_ANCESTORS = new Set([
  NODE_NAMES.apaTable,
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "figure",
]);

function isEligibleParagraph(doc: PMNode, position: number): boolean {
  const resolved = doc.resolve(position);
  const ancestors = Array.from(
    { length: resolved.depth + 1 },
    (_, depth) => resolved.node(depth).type.name,
  );
  return ancestors.some((name) => ELIGIBLE_SECTIONS.has(name)) &&
    !ancestors.some((name) => EXCLUDED_ANCESTORS.has(name));
}

function extractParagraph(
  paragraph: PMNode,
  paragraphPosition: number,
  input: CoachExtractionInput,
): CoachPassageSnapshot {
  let text = "";
  const offsetMap: Array<number | null> = [];
  const protectedSpans: Array<{
    from: number;
    to: number;
    kind: "citation" | "source-title";
  }> = [];

  const appendMapped = (
    value: string,
    position: number,
    protect: "citation" | "source-title" | null,
  ) => {
    const from = text.length;
    text += value;
    for (let index = 0; index <= value.length; index += 1) {
      const boundary = protect === "citation" && index > 0 &&
          index < value.length
        ? null
        : position + (protect === "citation" ? Math.min(index, 1) : index);
      offsetMap[from + index] = boundary;
    }
    if (protect && value.length > 0) {
      protectedSpans.push({ from, to: text.length, kind: protect });
    }
  };

  paragraph.forEach((node, offset) => {
    const position = paragraphPosition + 1 + offset;
    if (node.isText) {
      appendMapped(
        node.text ?? "",
        position,
        node.marks.some((mark) => mark.type.name === "link")
          ? "source-title"
          : null,
      );
    } else if (node.type.name === "hardBreak") {
      appendMapped("\n", position, null);
    } else if (node.type.name === "citation") {
      appendMapped(input.renderCitation(node, position), position, "citation");
    }
  });

  return Object.freeze({
    kind: "coach-passage-snapshot" as const,
    passageId: `${input.essayId}:${input.revision}:${paragraphPosition}`,
    essayId: input.essayId,
    revision: input.revision,
    documentLanguage: input.documentLanguage,
    citationEnvironmentVersion: input.citationEnvironmentVersion,
    text,
    offsetMap: Object.freeze(offsetMap),
    protectedSpans: Object.freeze(
      protectedSpans.map((span) => Object.freeze(span)),
    ),
  });
}

export function extractCoachPassages(
  input: CoachExtractionInput,
): readonly CoachPassageSnapshot[] {
  const passages: CoachPassageSnapshot[] = [];
  input.doc.descendants((node, position) => {
    if (
      node.type.name === "paragraph" &&
      isEligibleParagraph(input.doc, position)
    ) {
      passages.push(extractParagraph(node, position, input));
      return false;
    }
    return true;
  });
  return Object.freeze(passages);
}

export function mapSnapshotRange(
  passage: CoachPassageSnapshot,
  from: number,
  to: number,
): EditorRange | null {
  if (
    !Number.isInteger(from) || !Number.isInteger(to) || from < 0 ||
    from >= to || to > passage.text.length
  ) return null;
  const editorFrom = passage.offsetMap[from];
  const editorTo = passage.offsetMap[to];
  if (
    editorFrom === null || editorFrom === undefined || editorTo === null ||
    editorTo === undefined
  ) return null;
  for (let index = from; index <= to; index += 1) {
    if (passage.offsetMap[index] !== editorFrom + index - from) return null;
  }
  return { from: editorFrom, to: editorTo };
}
