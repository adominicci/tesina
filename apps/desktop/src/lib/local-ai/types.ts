import type { DocLocale } from "@tesina/engine";
import type { CoachCategory } from "../learning/coach/types.ts";

export type InferenceCorrelation =
  | { requestId: string; documentRevision: number; sourceSnapshotId?: never }
  | { requestId: string; documentRevision?: never; sourceSnapshotId: string };

export interface SourcePassage {
  sourceId: string;
  snapshotId: string;
  text: string;
}
export interface SourceSpan {
  sourceId: string;
  snapshotId: string;
  from: number;
  to: number;
  unit: "utf16";
}
type Four<T> = [T, T, T, T];
export interface GroundedQuestion {
  question: string;
  options: Four<string>;
  correctIndex: 0 | 1 | 2 | 3;
  explanation: string;
  distractorExplanations: Four<string>;
  provenance: {
    question: SourceSpan[];
    options: Four<SourceSpan[]>;
    explanation: SourceSpan[];
    distractorExplanations: Four<SourceSpan[]>;
  };
}
export interface WritingCoachRequest {
  documentLanguage: DocLocale;
  passage: SourcePassage;
}
export interface WritingCoachResult {
  issues: {
    from: number;
    to: number;
    category: CoachCategory;
    explanation: string;
    learningQuestion: string;
    source: "local-model";
  }[];
}
export interface GroundedQuizRequest {
  documentLanguage: DocLocale;
  sources: SourcePassage[];
  questionCount: 5 | 10;
}
export interface GroundedQuizResult {
  questions: GroundedQuestion[];
}
export interface LocalInferenceTaskMap {
  writingCoach: { request: WritingCoachRequest; result: WritingCoachResult };
  groundedQuiz: { request: GroundedQuizRequest; result: GroundedQuizResult };
}
export type LocalInferenceRequest = {
  [K in keyof LocalInferenceTaskMap]: InferenceCorrelation & {
    task: K;
    input: LocalInferenceTaskMap[K]["request"];
  };
}[keyof LocalInferenceTaskMap];
export const LOCAL_INFERENCE_ERRORS = [
  "unsupported-platform",
  "unsupported-hardware",
  "sidecar-absent",
  "not-installed",
  "busy",
  "cancelled",
  "invalid-request",
  "invalid-response",
  "startup-failed",
  "timeout",
  "out-of-memory",
  "crash",
  "shutting-down",
] as const;
export type LocalInferenceError = typeof LOCAL_INFERENCE_ERRORS[number];
export type LocalInferenceResult = {
  [K in keyof LocalInferenceTaskMap]:
    & InferenceCorrelation
    & { task: K }
    & (
      | { status: "ok"; output: LocalInferenceTaskMap[K]["result"] }
      | { status: "error"; error: LocalInferenceError }
    );
}[keyof LocalInferenceTaskMap];
export type ResultFor<K extends keyof LocalInferenceTaskMap> = Extract<
  LocalInferenceResult,
  { task: K }
>;
export type LocalInferenceCapability =
  & { version: 1 }
  & (
    | { status: "ready" | "busy" }
    | {
      status: "unavailable";
      reason:
        | "unsupported-platform"
        | "unsupported-hardware"
        | "sidecar-absent"
        | "not-installed";
    }
  );
export interface LocalInferenceProvider {
  capability(): Promise<LocalInferenceCapability>;
  run<K extends keyof LocalInferenceTaskMap>(
    request: Extract<LocalInferenceRequest, { task: K }>,
  ): Promise<ResultFor<K>>;
  cancel(requestId: string): Promise<void>;
}
