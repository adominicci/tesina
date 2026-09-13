import { describe, expect, it } from "vitest";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import type { WritingCoachIssue } from "../coach/types.ts";
import {
  createCoachSuppression,
  mapCoachRange,
  mapCoachSuppression,
  suppressionMatchesIssue,
} from "./mapping.ts";
import {
  type CoachPassageSnapshot,
  type MappedCoachIssue,
  suppressionIdentity,
} from "./types.ts";

const issue: WritingCoachIssue = {
  from: 0,
  to: 12,
  observedText: "in many ways",
  category: "specificity",
  explanation: {
    id: "coach.specificity.explanation",
    params: { observedText: "in many ways" },
  },
  learningQuestion: {
    id: "coach.specificity.question",
    params: { observedText: "in many ways" },
  },
  source: "deterministic",
};
const passage: CoachPassageSnapshot = {
  kind: "coach-passage-snapshot",
  passageId: "p-1",
  essayId: "essay-1",
  revision: 1,
  documentLanguage: "en",
  citationEnvironmentVersion: 2,
  text: "in many ways",
  offsetMap: Array.from({ length: 13 }, (_, index) => 10 + index),
  protectedSpans: [],
};
const mapped: MappedCoachIssue = {
  kind: "mapped-coach-issue",
  identity: "generation-1-issue",
  generation: 1,
  passage,
  issue,
  editorRange: { from: 10, to: 22 },
};

describe("exact coach transaction mapping", () => {
  it("keeps untouched ranges and shifts them across an earlier unrelated edit", () => {
    expect(mapCoachRange(mapped.editorRange, new Mapping())).toEqual({
      from: 10,
      to: 22,
    });
    expect(
      mapCoachRange(mapped.editorRange, new Mapping([new StepMap([3, 0, 5])])),
    ).toEqual({ from: 15, to: 27 });
  });

  it.each([
    ["inserted", new StepMap([15, 0, 2])],
    ["deleted", new StepMap([14, 3, 0])],
    ["replaced", new StepMap([12, 4, 1])],
  ])(
    "rejects %s source changes instead of splitting or guessing",
    (_name, step) => {
      expect(mapCoachRange(mapped.editorRange, new Mapping([step]))).toBeNull();
    },
  );
});

describe("ephemeral suppression identity", () => {
  it.each(["dismiss", "not-helpful"] as const)(
    "%s remains distinct from mapped generations and shifts only by transaction mapping",
    (action) => {
      const suppression = createCoachSuppression(mapped, action);
      expect(suppression.kind).toBe("coach-suppression");
      expect(suppression.identity).not.toBe(mapped.identity);
      expect(suppression.identity).toBe(suppressionIdentity(suppression));
      expect(
        createCoachSuppression(
          { ...mapped, generation: 9 },
          action === "dismiss" ? "not-helpful" : "dismiss",
        ).identity,
      ).toBe(suppression.identity);
      expect("generation" in suppression).toBe(false);
      const shifted = mapCoachSuppression(
        suppression,
        new Mapping([new StepMap([3, 0, 5])]),
        (range) => range.from === 15 && range.to === 27 ? "in many ways" : "",
      );
      expect(shifted?.editorRange).toEqual({ from: 15, to: 27 });
      expect(shifted?.identity).toBe(suppressionIdentity(shifted!));
      expect(
        suppressionMatchesIssue({
          ...mapped,
          generation: 9,
          editorRange: { from: 15, to: 27 },
        }, shifted!),
      ).toBe(true);
    },
  );

  it("rejects touched, stale, ambiguous, descriptor, language, and citation-environment changes", () => {
    const suppression = createCoachSuppression(mapped, "dismiss");
    expect(
      mapCoachSuppression(
        suppression,
        new Mapping([new StepMap([15, 0, 1])]),
        () => "in many ways",
      ),
    ).toBeNull();
    expect(
      mapCoachSuppression(suppression, new Mapping(), () => "changed text"),
    ).toBeNull();
    expect(
      mapCoachSuppression(suppression, new Mapping(), () => "in many ways"),
    ).not.toBeNull();
    expect(
      suppressionMatchesIssue(
        { ...mapped, editorRange: { from: 40, to: 52 } },
        suppression,
      ),
    ).toBe(false);
    expect(
      suppressionMatchesIssue({
        ...mapped,
        issue: { ...issue, category: "voice" },
      }, suppression),
    ).toBe(false);
    expect(
      suppressionMatchesIssue({
        ...mapped,
        issue: {
          ...issue,
          explanation: {
            ...issue.explanation,
            params: { observedText: "changed" },
          },
        },
      }, suppression),
    ).toBe(false);
    expect(
      suppressionMatchesIssue({
        ...mapped,
        passage: { ...passage, documentLanguage: "es" },
      }, suppression),
    ).toBe(false);
    expect(
      suppressionMatchesIssue({
        ...mapped,
        passage: { ...passage, citationEnvironmentVersion: 3 },
      }, suppression),
    ).toBe(false);
  });
});
