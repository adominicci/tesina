import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NODE_NAMES } from "@tesina/engine";
import {
  blockExtensions,
  createApaEquationExtension,
} from "$lib/editor/blocks.ts";
import { createCitationExtension } from "$lib/editor/citation.ts";
import { OrderedListStyleAttr } from "$lib/editor/lists.ts";
import { sectionExtensions } from "$lib/editor/sections.ts";
import { extractCoachPassages, mapSnapshotRange } from "./extraction.ts";

const schema = getSchema([
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
  createApaEquationExtension(() => {}),
  createCitationExtension({ refsById: new Map(), locale: "en" }),
]);

function extract(doc: PMNode, language: "en" | "es" = "en", version = 3) {
  return extractCoachPassages({
    doc,
    essayId: "essay-1",
    revision: 9,
    documentLanguage: language,
    citationEnvironmentVersion: version,
    renderCitation: () =>
      language === "en" ? "(Rivera & Soto, 2024)" : "(Rivera y Soto, 2024)",
  });
}

describe("eligible coach passage extraction", () => {
  it("uses structural eligibility and protection without text-shape heuristics", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "sectionAbstract",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Abstract prose" }],
            },
            {
              type: NODE_NAMES.keywordsLine,
              content: [{ type: "text", text: "Excluded keywords" }],
            },
          ],
        },
        {
          type: NODE_NAMES.sectionBody,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Plain https://example.test and 10.1000/plain. ",
                },
                {
                  type: "text",
                  marks: [{
                    type: "link",
                    attrs: { href: "https://linked.test" },
                  }],
                  text: "Linked source",
                },
              ],
            },
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Excluded heading" }],
            },
            {
              type: "bulletList",
              content: [{
                type: "listItem",
                content: [{
                  type: "paragraph",
                  content: [{ type: "text", text: "List prose" }],
                }],
              }],
            },
            {
              type: "blockquote",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Quoted prose" }],
              }],
            },
            {
              type: NODE_NAMES.apaTable,
              content: [
                {
                  type: NODE_NAMES.tableTitle,
                  content: [{ type: "text", text: "Excluded table title" }],
                },
                {
                  type: "table",
                  content: [{
                    type: "tableRow",
                    content: [{
                      type: "tableCell",
                      content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: "Excluded cell" }],
                      }],
                    }],
                  }],
                },
                {
                  type: "tableNote",
                  content: [{ type: "text", text: "Excluded table note" }],
                },
              ],
            },
            {
              type: "figure",
              content: [
                {
                  type: NODE_NAMES.figureTitle,
                  content: [{ type: "text", text: "Excluded figure title" }],
                },
                {
                  type: "figureImage",
                  attrs: { src: "", alt: "Excluded image label" },
                },
                {
                  type: "figureNote",
                  content: [{ type: "text", text: "Excluded figure note" }],
                },
              ],
            },
            { type: "apaEquation", attrs: { latex: "x=1" } },
          ],
        },
        {
          type: "sectionAppendix",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Appendix prose" }],
          }],
        },
      ],
    });

    const passages = extract(doc);
    expect(passages.map((passage) => passage.text)).toEqual([
      "Abstract prose",
      "Plain https://example.test and 10.1000/plain. Linked source",
      "List prose",
      "Quoted prose",
      "Appendix prose",
    ]);
    const linked = passages[1]!;
    expect(linked.protectedSpans).toEqual([{
      from: linked.text.indexOf("Linked source"),
      to: linked.text.length,
      kind: "source-title",
    }]);
    expect(schema.marks.link).toBeDefined();
    expect(schema.nodes.identifier).toBeUndefined();
    expect(schema.marks.identifier).toBeUndefined();
  });

  it("preserves UTF-16 positions, hard breaks, repeated text, and rejects invalid boundaries", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: NODE_NAMES.sectionBody,
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "A😀é repeated" },
            { type: "hardBreak" },
            { type: "text", text: "repeated" },
          ],
        }],
      }],
    });
    const [passage] = extract(doc);
    expect(passage.text).toBe("A😀é repeated\nrepeated");
    expect(passage.offsetMap).toHaveLength(passage.text.length + 1);
    expect(passage.offsetMap.slice(0, 6)).toEqual([2, 3, 4, 5, 6, 7]);
    const second = passage.text.lastIndexOf("repeated");
    expect(mapSnapshotRange(passage, second, second + 8)).toEqual({
      from: passage.offsetMap[second],
      to: passage.offsetMap[second + 8],
    });
    expect(
      mapSnapshotRange(
        { ...passage, offsetMap: passage.offsetMap.with(second, null) },
        second,
        second + 8,
      ),
    ).toBeNull();
    expect(mapSnapshotRange(passage, -1, 2)).toBeNull();
    expect(mapSnapshotRange(passage, 0, passage.text.length + 1)).toBeNull();
  });

  it("preserves and fully protects locale-rendered citations with versioned unnavigable interiors", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: NODE_NAMES.sectionBody,
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "Evidence " },
            {
              type: "citation",
              attrs: {
                items: [{ refId: "r1" }, { refId: "r2" }],
                mode: "parenthetical",
              },
            },
            { type: "text", text: " remains." },
          ],
        }],
      }],
    });
    const english = extract(doc, "en", 4)[0]!;
    const spanish = extract(doc, "es", 5)[0]!;
    expect(english.text).toBe("Evidence (Rivera & Soto, 2024) remains.");
    expect(spanish.text).toBe("Evidence (Rivera y Soto, 2024) remains.");
    expect(english.citationEnvironmentVersion).toBe(4);
    expect(spanish.citationEnvironmentVersion).toBe(5);
    const protectedSpan = english.protectedSpans[0]!;
    expect(english.text.slice(protectedSpan.from, protectedSpan.to)).toBe(
      "(Rivera & Soto, 2024)",
    );
    expect(english.offsetMap[protectedSpan.from]).toBeTypeOf("number");
    expect(english.offsetMap[protectedSpan.from + 1]).toBeNull();
    expect(english.offsetMap[protectedSpan.to]).toBeTypeOf("number");
    expect(mapSnapshotRange(english, protectedSpan.from + 1, protectedSpan.to))
      .toBeNull();
  });
});
