import { describe, expect, it, vi } from "vitest";
import { createLocalInferenceProvider } from "./client.ts";
import type {
  LocalInferenceRequest,
  LocalInferenceResult,
  ResultFor,
} from "./types.ts";

const request = {
  requestId: "f98b4102-986b-4abc-9bb4-b760f7b136b7",
  documentRevision: 7,
  task: "writingCoach" as const,
  input: {
    documentLanguage: "es" as const,
    passage: { sourceId: "p", snapshotId: "s", text: "Árbol 🌱" },
  },
};

describe("local inference client", () => {
  it("returns a task-specific result with exact caller correlation", async () => {
    const invoke = vi.fn().mockResolvedValue({
      requestId: request.requestId,
      documentRevision: 7,
      task: "writingCoach",
      status: "ok",
      output: { issues: [] },
    });
    const result = await createLocalInferenceProvider(invoke).run(request);
    expect(result).toEqual({
      requestId: "f98b4102-986b-4abc-9bb4-b760f7b136b7",
      documentRevision: 7,
      task: "writingCoach",
      status: "ok",
      output: { issues: [] },
    });
    expect(invoke).toHaveBeenCalledWith("local_inference_run", { request });
  });
  it.each([
    { documentRevision: 8 },
    { requestId: "foreign" },
    { task: "groundedQuiz" },
    { sourceSnapshotId: "s" },
    { output: { questions: [] } },
    { extra: "sensitive" },
    { status: "error", error: "raw sensitive error" },
  ])("discards mismatched or untrusted native result %j", async (override) => {
    const invoke = vi.fn().mockResolvedValue({
      requestId: request.requestId,
      documentRevision: 7,
      task: "writingCoach",
      status: "ok",
      output: { issues: [] },
      ...override,
    });
    await expect(createLocalInferenceProvider(invoke).run(request)).resolves
      .toEqual({
        requestId: request.requestId,
        documentRevision: 7,
        task: "writingCoach",
        status: "error",
        error: "invalid-response",
      });
  });
  it("honors cancellation before dispatch without retaining source content", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const provider = createLocalInferenceProvider(invoke);
    await provider.cancel(request.requestId);
    expect(await provider.run(request)).toMatchObject({
      status: "error",
      error: "cancelled",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "es"] as const)(
    "preserves snapshot errors in %s",
    async (documentLanguage) => {
      const { documentRevision: _revision, ...rest } = request;
      const snapshotRequest = {
        ...rest,
        sourceSnapshotId: "s",
        input: { ...request.input, documentLanguage },
      };
      const result = {
        requestId: request.requestId,
        sourceSnapshotId: "s",
        task: "writingCoach",
        status: "error",
        error: "not-installed",
      };
      expect(
        await createLocalInferenceProvider(vi.fn().mockResolvedValue(result))
          .run(snapshotRequest),
      ).toEqual(result);
    },
  );
  it("does not accept a failed cancellation, including when run races its acknowledgement", async () => {
    let rejectCancel!: (reason: unknown) => void;
    const invoke = vi.fn().mockImplementation((command) =>
      command === "local_inference_cancel"
        ? new Promise((_resolve, reject) => {
          rejectCancel = reject;
        })
        : Promise.resolve({
          requestId: request.requestId,
          documentRevision: 7,
          task: "writingCoach",
          status: "ok",
          output: { issues: [] },
        })
    );
    const provider = createLocalInferenceProvider(invoke);
    const cancel = provider.cancel(request.requestId);
    const failed = expect(cancel).rejects.toThrow("busy");
    const run = provider.run(request);
    rejectCancel("native busy");
    await failed;
    expect(await run).toMatchObject({ status: "ok" });
  });
  it("bounds accepted pre-dispatch cancellation without forgetting older IDs", async () => {
    const provider = createLocalInferenceProvider(
      vi.fn().mockResolvedValue(undefined),
    );
    for (let i = 0; i < 32; i++) {
      await provider.cancel(
        `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
      );
    }
    await expect(provider.cancel(request.requestId)).rejects.toThrow("busy");
    expect(
      await provider.run({
        ...request,
        requestId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toMatchObject({ error: "cancelled" });
    await expect(provider.cancel(request.requestId)).resolves.toBeUndefined();
  });
  it("does not retain a late cancel acknowledgement after its active run already terminated", async () => {
    let finishRun!: (value: unknown) => void;
    let acceptCancel!: () => void;
    const invoke = vi.fn().mockImplementation((command) =>
      command === "local_inference_cancel"
        ? new Promise<void>((resolve) => {
          acceptCancel = resolve;
        })
        : new Promise((resolve) => {
          finishRun = resolve;
        })
    );
    const provider = createLocalInferenceProvider(invoke);
    const run = provider.run(request);
    await Promise.resolve();
    const cancel = provider.cancel(request.requestId);
    finishRun({
      requestId: request.requestId,
      documentRevision: 7,
      task: "writingCoach",
      status: "error",
      error: "cancelled",
    });
    expect(await run).toMatchObject({ error: "cancelled" });
    acceptCancel();
    await cancel;
    invoke.mockResolvedValue({
      requestId: request.requestId,
      documentRevision: 7,
      task: "writingCoach",
      status: "error",
      error: "busy",
    });
    expect(await provider.run(request)).toMatchObject({ error: "busy" });
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("preserves an already-decided native success when a completed-ID cancel is a no-op", async () => {
    let deliverRun!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementation((command) =>
      command === "local_inference_cancel"
        ? Promise.resolve()
        : new Promise((resolve) => {
          deliverRun = resolve;
        })
    );
    const provider = createLocalInferenceProvider(invoke);
    const run = provider.run(request);
    await Promise.resolve();
    await provider.cancel(request.requestId);
    deliverRun({
      requestId: request.requestId,
      documentRevision: 7,
      task: "writingCoach",
      status: "ok",
      output: { issues: [] },
    });
    expect(await run).toMatchObject({ status: "ok", output: { issues: [] } });
  });
  it.each([{ version: 2, status: "ready" }, {
    version: 1,
    status: "unavailable",
    reason: "secret",
  }, { version: 1, status: "ready", path: "private" }])(
    "rejects an unrecognized capability %j",
    async (value) => {
      await expect(
        createLocalInferenceProvider(vi.fn().mockResolvedValue(value))
          .capability(),
      ).rejects.toThrow("invalid-response");
    },
  );
  it("never exposes raw native capability errors", async () => {
    await expect(
      createLocalInferenceProvider(
        vi.fn().mockRejectedValue(new Error("/private/PAPER_CANARY")),
      ).capability(),
    ).rejects.toThrow(/^invalid-response$/);
  });
});

// These are checked by svelte-check, not inferred from runtime mock behavior.
function compileTimeContract() {
  // @ts-expect-error Exactly one correlation axis.
  const dual: LocalInferenceRequest = { ...request, sourceSnapshotId: "s" };
  const cross: LocalInferenceRequest = {
    ...request,
    // @ts-expect-error Quiz input cannot be paired with writingCoach.
    input: { documentLanguage: "en", sources: [], questionCount: 5 },
  };
  const result: LocalInferenceResult = {
    ...request,
    status: "ok",
    // @ts-expect-error Wrong task output.
    output: { questions: [] },
  };
  const quiz: ResultFor<"groundedQuiz"> = {
    requestId: "id",
    documentRevision: 1,
    task: "groundedQuiz",
    status: "ok",
    output: { questions: [] },
  };
  // @ts-expect-error A quiz result cannot satisfy a writing-coach result.
  const wrong: ResultFor<"writingCoach"> = quiz;
  return [dual, cross, result, wrong];
}
void compileTimeContract;
