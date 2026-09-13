import { describe, expect, it } from "vitest";
import type { CoachPassageSnapshot } from "./types.ts";
import { analyzeCoachPassages } from "./analysisAdapter.ts";

function passage(
  passageId: string,
  text: string,
  editorStart: number,
  protectedSpans: CoachPassageSnapshot["protectedSpans"] = [],
): CoachPassageSnapshot {
  return {
    kind: "coach-passage-snapshot",
    passageId,
    essayId: "essay-1",
    revision: 3,
    documentLanguage: "en",
    citationEnvironmentVersion: 2,
    text,
    offsetMap: Array.from(
      { length: text.length + 1 },
      (_, index) => editorStart + index,
    ),
    protectedSpans,
  };
}

describe("deterministic passage analysis adapter", () => {
  it("analyzes passages independently and preserves passage then engine order", () => {
    const firstText = "The policy changed in many ways during review.";
    const secondText =
      "Various aspects shaped the final decision during review.";
    const result = analyzeCoachPassages([
      passage("p-1", firstText, 20),
      passage("p-2", secondText, 120),
    ], 4);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected issues");
    expect(result.issues.map((item) => item.passage.passageId)).toEqual([
      "p-1",
      "p-2",
    ]);
    expect(result.issues.map((item) => item.issue.observedText)).toEqual([
      "in many ways",
      "Various aspects",
    ]);
    expect(result.issues.map((item) => item.editorRange)).toEqual([
      {
        from: 20 + firstText.indexOf("in many ways"),
        to: 20 + firstText.indexOf("in many ways") + 12,
      },
      { from: 120, to: 135 },
    ]);
    expect(result.issues.every((item) => item.generation === 4)).toBe(true);
  });

  it("forwards structural protection and fails the whole generation on an invalid mapping", () => {
    const text = "The policy changed in many ways during review.";
    const from = text.indexOf("in many ways");
    const protectedResult = analyzeCoachPassages([
      passage("protected", text, 10, [{
        from,
        to: from + 12,
        kind: "source-title",
      }]),
    ], 1);
    expect(protectedResult).toEqual({ status: "available", issues: [] });

    const invalid = passage("invalid", text, 10);
    const invalidResult = analyzeCoachPassages([{
      ...invalid,
      offsetMap: invalid.offsetMap.with(from, null),
    }], 2);
    expect(invalidResult).toEqual({
      status: "unavailable-for-current-text",
      issues: [],
    });
  });

  it("adapts real deterministic output for all six categories", () => {
    const fill = Array.from({ length: 43 }, (_, index) => `term${index}`).join(
      " ",
    );
    const texts = [
      "The policy changed in many ways during review.",
      "The report clearly proves that daily practice improves every measured outcome.",
      `${fill} because although while.`,
      "The committee met in order to compare the records.",
      "Careful local evidence supports revision today; careful local evidence supports revision tomorrow.",
      "It is important to note that the evening section retained more students.",
    ];
    const result = analyzeCoachPassages(
      texts.map((text, index) => passage(`p-${index}`, text, index * 1_000)),
      6,
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected issues");
    expect(new Set(result.issues.map((item) => item.issue.category))).toEqual(
      new Set([
        "specificity",
        "evidence",
        "clarity",
        "economy",
        "repetition",
        "voice",
      ]),
    );
  });
});
