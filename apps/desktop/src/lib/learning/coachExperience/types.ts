import type { DocLocale } from "@tesina/engine";
import type {
  CoachCategory,
  ProtectedSpan,
  WritingCoachIssue,
} from "../coach/types.ts";

export interface EditorRange {
  readonly from: number;
  readonly to: number;
}

export interface CoachPassageSnapshot {
  readonly kind: "coach-passage-snapshot";
  readonly passageId: string;
  readonly essayId: string;
  readonly revision: number;
  readonly documentLanguage: DocLocale;
  readonly citationEnvironmentVersion: number;
  readonly text: string;
  readonly offsetMap: readonly (number | null)[];
  readonly protectedSpans: readonly ProtectedSpan[];
}

export interface MappedCoachIssue {
  readonly kind: "mapped-coach-issue";
  readonly identity: string;
  readonly generation: number;
  readonly passage: CoachPassageSnapshot;
  readonly issue: WritingCoachIssue;
  readonly editorRange: EditorRange;
}

export interface FixedCoachSession {
  readonly kind: "fixed-coach-session";
  readonly issue: MappedCoachIssue;
  readonly position: number;
  readonly total: number;
}

export interface CoachSuppression {
  readonly kind: "coach-suppression";
  readonly identity: string;
  readonly essayId: string;
  readonly documentLanguage: DocLocale;
  readonly citationEnvironmentVersion: number;
  readonly editorRange: EditorRange;
  readonly sourceText: string;
  readonly category: CoachCategory;
  readonly explanationIdentity: string;
  readonly questionIdentity: string;
  readonly action: "dismiss" | "not-helpful";
}

interface EmptyControllerState {
  readonly issues: readonly [];
  readonly fixed: null;
}

export type CoachControllerState =
  | ({ readonly status: "idle" } & EmptyControllerState)
  | {
    readonly status: "analyzing";
    readonly issues: readonly MappedCoachIssue[];
    readonly fixed: FixedCoachSession | null;
  }
  | {
    readonly status: "issues";
    readonly issues: readonly MappedCoachIssue[];
    readonly fixed: FixedCoachSession;
  }
  | ({ readonly status: "no-current-issues" } & EmptyControllerState)
  | ({
    readonly status: "unavailable-for-current-text";
  } & EmptyControllerState);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return "{" +
    Object.keys(record).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(record[key])
    ).join(",") + "}";
}

export function canonicalDescriptorIdentity<P extends object>(
  descriptor: { readonly id: string; readonly params: P },
): string {
  return `${descriptor.id}\0${canonicalJson(descriptor.params)}`;
}

export function mappedIssueIdentity(issue: MappedCoachIssue): string {
  return canonicalJson({
    kind: issue.kind,
    essayId: issue.passage.essayId,
    revision: issue.passage.revision,
    citationEnvironmentVersion: issue.passage.citationEnvironmentVersion,
    passageId: issue.passage.passageId,
    generation: issue.generation,
    category: issue.issue.category,
    from: issue.editorRange.from,
    to: issue.editorRange.to,
    explanation: canonicalDescriptorIdentity(issue.issue.explanation),
    question: canonicalDescriptorIdentity(issue.issue.learningQuestion),
  });
}

export function suppressionIdentity(
  suppression: Pick<
    CoachSuppression,
    | "kind"
    | "essayId"
    | "documentLanguage"
    | "citationEnvironmentVersion"
    | "editorRange"
    | "sourceText"
    | "category"
    | "explanationIdentity"
    | "questionIdentity"
  >,
): string {
  return JSON.stringify({
    kind: suppression.kind,
    essayId: suppression.essayId,
    documentLanguage: suppression.documentLanguage,
    citationEnvironmentVersion: suppression.citationEnvironmentVersion,
    from: suppression.editorRange.from,
    to: suppression.editorRange.to,
    sourceText: suppression.sourceText,
    category: suppression.category,
    explanationIdentity: suppression.explanationIdentity,
    questionIdentity: suppression.questionIdentity,
  });
}
