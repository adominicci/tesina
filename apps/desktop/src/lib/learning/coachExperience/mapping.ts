import type { Mapping } from "@tiptap/pm/transform";
import { canonicalDescriptorIdentity, suppressionIdentity } from "./types.ts";
import type {
  CoachSuppression,
  EditorRange,
  MappedCoachIssue,
} from "./types.ts";

export function mapCoachRange(
  range: EditorRange,
  mapping: Mapping,
): EditorRange | null {
  let current = { ...range };
  for (const step of mapping.maps) {
    let touched = false;
    step.forEach((oldStart, oldEnd) => {
      if (oldStart === oldEnd) {
        if (oldStart > current.from && oldStart < current.to) touched = true;
      } else if (oldStart < current.to && oldEnd > current.from) {
        touched = true;
      }
    });
    if (touched) return null;
    const from = step.map(current.from, 1);
    const to = step.map(current.to, -1);
    if (from >= to) return null;
    current = { from, to };
  }
  return current;
}

export function createCoachSuppression(
  mapped: MappedCoachIssue,
  action: CoachSuppression["action"],
): CoachSuppression {
  const suppression: Omit<CoachSuppression, "identity"> = {
    kind: "coach-suppression",
    essayId: mapped.passage.essayId,
    documentLanguage: mapped.passage.documentLanguage,
    citationEnvironmentVersion: mapped.passage.citationEnvironmentVersion,
    editorRange: mapped.editorRange,
    sourceText: mapped.issue.observedText,
    category: mapped.issue.category,
    explanationIdentity: canonicalDescriptorIdentity(mapped.issue.explanation),
    questionIdentity: canonicalDescriptorIdentity(
      mapped.issue.learningQuestion,
    ),
    action,
  };
  return Object.freeze({
    ...suppression,
    identity: suppressionIdentity(suppression),
  });
}

export function mapCoachSuppression(
  suppression: CoachSuppression,
  mapping: Mapping,
  readText: (range: EditorRange) => string,
): CoachSuppression | null {
  const editorRange = mapCoachRange(suppression.editorRange, mapping);
  if (!editorRange || readText(editorRange) !== suppression.sourceText) {
    return null;
  }
  const mapped = { ...suppression, editorRange };
  return Object.freeze({ ...mapped, identity: suppressionIdentity(mapped) });
}

export function suppressionMatchesIssue(
  mapped: MappedCoachIssue,
  suppression: CoachSuppression,
): boolean {
  return mapped.passage.essayId === suppression.essayId &&
    mapped.passage.documentLanguage === suppression.documentLanguage &&
    mapped.passage.citationEnvironmentVersion ===
      suppression.citationEnvironmentVersion &&
    mapped.editorRange.from === suppression.editorRange.from &&
    mapped.editorRange.to === suppression.editorRange.to &&
    mapped.issue.observedText === suppression.sourceText &&
    mapped.issue.category === suppression.category &&
    canonicalDescriptorIdentity(mapped.issue.explanation) ===
      suppression.explanationIdentity &&
    canonicalDescriptorIdentity(mapped.issue.learningQuestion) ===
      suppression.questionIdentity;
}
