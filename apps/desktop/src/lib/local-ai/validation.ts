import { COACH_CATEGORIES } from "../learning/coach/types.ts";
import {
  LOCAL_INFERENCE_ERRORS,
  type LocalInferenceRequest,
  type LocalInferenceResult,
  type SourcePassage,
} from "./types.ts";

function object(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}
function range(from: unknown, to: unknown, source: string): boolean {
  function boundary(offset: number) {
    return !(offset > 0 && /[\uD800-\uDBFF]/.test(source[offset - 1]) &&
      /[\uDC00-\uDFFF]/.test(source[offset] ?? ""));
  }
  return typeof from === "number" && typeof to === "number" &&
    Number.isSafeInteger(from) && Number.isSafeInteger(to) &&
    from >= 0 && from < to && to <= source.length && boundary(from) &&
    boundary(to);
}
function four(value: unknown, valid: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length === 4 && value.every(valid);
}
function spans(value: unknown, sources: SourcePassage[]): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    return false;
  }
  let previousSource = -1;
  let previousEnd = 0;
  return value.every((span: unknown) => {
    if (
      !object(span, ["sourceId", "snapshotId", "from", "to", "unit"]) ||
      span.unit !== "utf16"
    ) return false;
    const index = sources.findIndex((s) =>
      s.sourceId === span.sourceId && s.snapshotId === span.snapshotId
    );
    if (
      index < 0 || !range(span.from, span.to, sources[index].text) ||
      index < previousSource ||
      (index === previousSource && (span.from as number) < previousEnd)
    ) return false;
    previousSource = index;
    previousEnd = span.to as number;
    return true;
  });
}

export function validResult(
  value: unknown,
  request: LocalInferenceRequest,
): value is LocalInferenceResult {
  const identity = request.documentRevision === undefined
    ? "sourceSnapshotId"
    : "documentRevision";
  if (!value || typeof value !== "object") return false;
  const status = (value as Record<string, unknown>).status;
  if (
    !object(value, [
      "requestId",
      identity,
      "task",
      "status",
      status === "ok" ? "output" : "error",
    ]) ||
    value.requestId !== request.requestId || value.task !== request.task ||
    value[identity] !== request[identity]
  ) return false;
  if (status === "error") {
    return LOCAL_INFERENCE_ERRORS.some((code) => code === value.error);
  }
  if (status !== "ok") return false;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) {
    return false;
  }
  const output = value.output;
  if (request.task === "writingCoach") {
    return object(output, ["issues"]) && Array.isArray(output.issues) &&
      output.issues.length <= 32 && output.issues.every((issue: unknown) =>
        object(issue, [
          "from",
          "to",
          "category",
          "explanation",
          "learningQuestion",
          "source",
        ]) &&
        range(issue.from, issue.to, request.input.passage.text) &&
        COACH_CATEGORIES.some((category) =>
          category === issue.category
        ) &&
        text(issue.explanation) && text(issue.learningQuestion) &&
        issue.source === "local-model"
      );
  }
  return object(output, ["questions"]) && Array.isArray(output.questions) &&
    output.questions.length === request.input.questionCount &&
    output.questions.every((question: unknown) => {
      if (
        !object(question, [
          "question",
          "options",
          "correctIndex",
          "explanation",
          "distractorExplanations",
          "provenance",
        ]) ||
        !text(question.question) || !text(question.explanation) ||
        !four(question.options, text) ||
        !four(question.distractorExplanations, text) ||
        ![0, 1, 2, 3].includes(question.correctIndex as number)
      ) return false;
      const p = question.provenance;
      const validSpans = (v: unknown) => spans(v, request.input.sources);
      return object(p, [
        "question",
        "options",
        "explanation",
        "distractorExplanations",
      ]) &&
        validSpans(p.question) && validSpans(p.explanation) &&
        four(p.options, validSpans) &&
        four(p.distractorExplanations, validSpans);
    });
}
