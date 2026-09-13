import { analyzeWriting } from "../coach/rules.ts";
import { mapSnapshotRange } from "./extraction.ts";
import {
  type CoachPassageSnapshot,
  type MappedCoachIssue,
  mappedIssueIdentity,
} from "./types.ts";

export type CoachPassageAnalysis =
  | {
    readonly status: "available";
    readonly issues: readonly MappedCoachIssue[];
  }
  | {
    readonly status: "unavailable-for-current-text";
    readonly issues: readonly [];
  };

export function analyzeCoachPassages(
  passages: readonly CoachPassageSnapshot[],
  generation: number,
): CoachPassageAnalysis {
  const mapped: MappedCoachIssue[] = [];
  for (const passage of passages) {
    const issues = analyzeWriting({
      text: passage.text,
      documentLanguage: passage.documentLanguage,
      documentStart: 0,
      protectedSpans: passage.protectedSpans,
    });
    for (const issue of issues) {
      if (passage.text.slice(issue.from, issue.to) !== issue.observedText) {
        return { status: "unavailable-for-current-text", issues: [] };
      }
      const editorRange = mapSnapshotRange(passage, issue.from, issue.to);
      if (!editorRange) {
        return { status: "unavailable-for-current-text", issues: [] };
      }
      const provisional: MappedCoachIssue = {
        kind: "mapped-coach-issue",
        identity: "",
        generation,
        passage,
        issue,
        editorRange,
      };
      mapped.push(Object.freeze({
        ...provisional,
        identity: mappedIssueIdentity(provisional),
      }));
    }
  }
  return { status: "available", issues: Object.freeze(mapped) };
}
