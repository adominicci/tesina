import { describe, expect, expectTypeOf, it } from "vitest";
import type { WritingCoachIssue } from "../coach/types.ts";
import {
  canonicalDescriptorIdentity,
  type CoachControllerState,
  type CoachPassageSnapshot,
  type CoachSuppression,
  type FixedCoachSession,
  type MappedCoachIssue,
  mappedIssueIdentity,
} from "./types.ts";

const engineIssue: WritingCoachIssue = {
  from: 1,
  to: 3,
  observedText: "\u{1F600}",
  category: "specificity",
  explanation: {
    id: "coach.specificity.explanation",
    params: { observedText: "\u{1F600}" },
  },
  learningQuestion: {
    id: "coach.specificity.question",
    params: { observedText: "\u{1F600}" },
  },
  source: "deterministic",
};

const passage: CoachPassageSnapshot = {
  kind: "coach-passage-snapshot",
  passageId: "essay-1:4:12",
  essayId: "essay-1",
  revision: 4,
  documentLanguage: "es",
  citationEnvironmentVersion: 12,
  text: "A\u{1F600}e\u0301",
  offsetMap: [10, 11, 12, 13, 14, 15],
  protectedSpans: [],
};

const mappedIssue: MappedCoachIssue = {
  kind: "mapped-coach-issue",
  identity: "mapped",
  generation: 7,
  passage,
  issue: engineIssue,
  editorRange: { from: 11, to: 12 },
};

describe("writing coach experience contracts", () => {
  it("represents exact UTF-16 boundaries and distinct state identities", () => {
    expect(passage.text.length).toBe(5);
    expect(passage.offsetMap).toEqual([10, 11, 12, 13, 14, 15]);
    expectTypeOf<MappedCoachIssue>().not.toMatchTypeOf<CoachSuppression>();

    const fixed: FixedCoachSession = {
      kind: "fixed-coach-session",
      issue: mappedIssue,
      position: 1,
      total: 1,
    };
    const state: CoachControllerState = {
      status: "issues",
      issues: [mappedIssue],
      fixed,
    };
    expect(state.status).toBe("issues");
    expect(fixed.issue.kind).toBe("mapped-coach-issue");
  });

  it("uses generation for mapped issues and canonical descriptor parameters", () => {
    const nextGeneration: MappedCoachIssue = {
      ...mappedIssue,
      generation: 8,
    };
    expect(mappedIssueIdentity(mappedIssue)).not.toBe(
      mappedIssueIdentity(nextGeneration),
    );
    expect(
      canonicalDescriptorIdentity({
        id: "coach.specificity.explanation",
        params: { z: "last", observedText: "\u{1F600}", a: "first" },
      }),
    ).toBe(
      canonicalDescriptorIdentity({
        id: "coach.specificity.explanation",
        params: { a: "first", observedText: "\u{1F600}", z: "last" },
      }),
    );
  });
});
