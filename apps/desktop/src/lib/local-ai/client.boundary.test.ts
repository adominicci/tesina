import { expect, it, vi } from "vitest";
import { createLocalInferenceProvider } from "./client.ts";
import type { GroundedQuestion, LocalInferenceRequest } from "./types.ts";

const span = {
  sourceId: "p",
  snapshotId: "s",
  from: 0,
  to: 2,
  unit: "utf16" as const,
};
const question: GroundedQuestion = {
  question: "¿🌱?",
  options: ["A", "B", "C", "D"],
  correctIndex: 3,
  explanation: "e\u0301",
  distractorExplanations: ["a", "b", "c", "d"],
  provenance: {
    question: [span],
    options: [[span], [span], [span], [span]],
    explanation: [span],
    distractorExplanations: [[span], [span], [span], [span]],
  },
};

it("accepts both quiz counts/languages/identity axes and discards any mismatched or partial draft", async () => {
  for (const documentLanguage of ["en", "es"] as const) {
    for (const questionCount of [5, 10] as const) {
      for (
        const identity of [{ documentRevision: 7 }, { sourceSnapshotId: "s" }]
      ) {
        const request: LocalInferenceRequest = {
          ...identity,
          requestId: "f98b4102-986b-4abc-9bb4-b760f7b136b7",
          task: "groundedQuiz",
          input: {
            documentLanguage,
            questionCount,
            sources: [{ sourceId: "p", snapshotId: "s", text: "🌱 e\u0301" }],
          },
        };
        const result = {
          ...identity,
          requestId: request.requestId,
          task: "groundedQuiz",
          status: "ok",
          output: {
            questions: Array.from(
              { length: questionCount },
              () => structuredClone(question),
            ),
          },
        };
        const native = vi.fn().mockResolvedValue(result);
        const client = createLocalInferenceProvider(native);
        expect(await client.run(request)).toEqual(result);
        const malformed = [
          { ...result, requestId: "foreign" },
          { ...result, task: "writingCoach" },
          {
            ...result,
            ...("documentRevision" in identity
              ? { documentRevision: 8 }
              : { sourceSnapshotId: "foreign" }),
          },
          { ...result, extra: "CANARY" },
          {
            ...result,
            output: { questions: result.output.questions.slice(1) },
          },
          { ...result, status: "error", error: "crash" },
        ];
        const wrongSpan = structuredClone(result);
        wrongSpan.output.questions[questionCount - 1].provenance.options[3][0]
          .from = 1;
        malformed.push(wrongSpan);
        for (const bad of malformed) {
          native.mockResolvedValueOnce(bad);
          expect(await client.run(request)).toEqual({
            ...identity,
            requestId: request.requestId,
            task: "groundedQuiz",
            status: "error",
            error: "invalid-response",
          });
        }
      }
    }
  }
});

it("preserves every closed unavailable reason and exposes no extra capability authority", async () => {
  const native = vi.fn();
  const client = createLocalInferenceProvider(native);
  for (
    const reason of [
      "unsupported-platform",
      "unsupported-hardware",
      "sidecar-absent",
      "not-installed",
    ]
  ) {
    const capability = { version: 1, status: "unavailable", reason };
    native.mockResolvedValueOnce(capability);
    expect(await client.capability()).toEqual(capability);
  }
  for (const status of ["ready", "busy"]) {
    native.mockResolvedValueOnce({ version: 1, status });
    expect(await client.capability()).toEqual({ version: 1, status });
  }
  for (
    const bad of [
      null,
      [],
      { version: 1, status: "unavailable", reason: "crash" },
      { version: 1, status: "ready", endpoint: "CANARY" },
      {
        version: 1,
        status: "unavailable",
        reason: "not-installed",
        detail: "CANARY",
      },
    ]
  ) {
    native.mockResolvedValueOnce(bad);
    await expect(client.capability()).rejects.toThrow(/^invalid-response$/);
  }
  expect(
    native.mock.calls.every(([command]) =>
      command === "local_inference_capability"
    ),
  ).toBe(true);
});
