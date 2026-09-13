import { afterEach, describe, expect, it, vi } from "vitest";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import {
  type CoachAnalysisSnapshot,
  createWritingCoachController,
} from "./controller.ts";
import { analyzeCoachPassages } from "./analysisAdapter.ts";
import type { CoachPassageSnapshot } from "./types.ts";

function snapshot(
  revision: number,
  text = "The policy changed in many ways during review.",
  overrides: Partial<CoachAnalysisSnapshot> = {},
): CoachAnalysisSnapshot {
  const passage: CoachPassageSnapshot = {
    kind: "coach-passage-snapshot",
    passageId: `essay-1:${revision}:1`,
    essayId: "essay-1",
    revision,
    documentLanguage: overrides.documentLanguage ?? "en",
    citationEnvironmentVersion: overrides.citationEnvironmentVersion ?? 1,
    text,
    offsetMap: Array.from({ length: text.length + 1 }, (_, index) => 2 + index),
    protectedSpans: [],
  };
  return {
    essayId: "essay-1",
    revision,
    documentLanguage: "en",
    citationEnvironmentVersion: 1,
    snapshotId: `snapshot-${revision}`,
    passages: [passage],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("essay-scoped writing coach scheduling", () => {
  it("notifies and detaches a mounted Study view across controller states", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    const states: string[] = [];
    const unsubscribe = controller.subscribe((state) =>
      states.push(state.status)
    );
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["idle", "analyzing", "issues"]);
    unsubscribe();
    controller.updateSnapshot(snapshot(2));
    expect(states).toEqual(["idle", "analyzing", "issues"]);
    controller.destroy();
  });

  it("stays idle before Study and analyzes the current snapshot immediately on first entry", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getState().status).toBe("idle");

    controller.enterStudy();
    expect(controller.getState().status).toBe("analyzing");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().status).toBe("issues");
    controller.destroy();
  });

  it("uses a 300 ms trailing timer and the latest snapshot", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);

    controller.updateSnapshot(
      snapshot(2, "The draft changed in many ways during review."),
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(controller.getState().status).toBe("analyzing");
    controller.updateSnapshot(
      snapshot(3, "Various aspects shaped the final review."),
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(controller.getState().status).toBe("analyzing");
    await vi.advanceTimersByTimeAsync(1);
    const state = controller.getState();
    expect(state.status).toBe("issues");
    if (state.status === "issues") {
      expect(state.issues[0]?.passage.revision).toBe(3);
      expect(state.issues[0]?.issue.observedText).toBe("Various aspects");
    }
    controller.destroy();
  });

  it("runs by 1,000 ms during continuous changes and clears timers on destroy", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.updateSnapshot(snapshot(2));
    for (const revision of [3, 4, 5]) {
      await vi.advanceTimersByTimeAsync(250);
      controller.updateSnapshot(snapshot(revision));
    }
    await vi.advanceTimersByTimeAsync(249);
    expect(controller.getState().status).toBe("analyzing");
    await vi.advanceTimersByTimeAsync(1);
    const state = controller.getState();
    expect(state.status).toBe("issues");
    if (state.status === "issues") {
      expect(state.issues[0]?.passage.revision).toBe(5);
    }

    controller.updateSnapshot(snapshot(6));
    controller.destroy();
    await vi.runAllTimersAsync();
    expect(controller.getState().status).toBe("idle");
  });
});

describe("stale analysis rejection", () => {
  it("converts oversized synchronous analysis and rejected adapters to unavailable", async () => {
    vi.useFakeTimers();
    const oversized = createWritingCoachController("essay-1");
    oversized.updateSnapshot(snapshot(1, "x".repeat(65_537)));
    oversized.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    expect(oversized.getState().status).toBe(
      "unavailable-for-current-text",
    );
    oversized.destroy();

    const rejected = createWritingCoachController("essay-1", {
      analyze: () => Promise.reject(new Error("adapter unavailable")),
    });
    rejected.updateSnapshot(snapshot(1));
    rejected.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected.getState().status).toBe(
      "unavailable-for-current-text",
    );
    rejected.destroy();
  });

  it("does not let an older rejected adapter clobber a newer generation", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (reason: Error) => void;
    let resolveSecond!: (value: {
      status: "available";
      issues: [];
    }) => void;
    const analyze = vi.fn()
      .mockImplementationOnce(() =>
        new Promise((_resolve, reject) => (rejectFirst = reject))
      )
      .mockImplementationOnce(() =>
        new Promise((resolve) => (resolveSecond = resolve))
      );
    const controller = createWritingCoachController("essay-1", { analyze });
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);

    controller.updateSnapshot(snapshot(2));
    await vi.advanceTimersByTimeAsync(300);
    rejectFirst(new Error("stale adapter failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().status).toBe("analyzing");

    resolveSecond({ status: "available", issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().status).toBe("no-current-issues");
    controller.destroy();
  });

  it.each([
    ["revision", { revision: 2, snapshotId: "snapshot-2" }],
    ["language", {
      documentLanguage: "es" as const,
      snapshotId: "snapshot-es",
    }],
    ["citation environment", {
      citationEnvironmentVersion: 2,
      snapshotId: "snapshot-citation",
    }],
    ["snapshot", { snapshotId: "replacement" }],
  ])("rejects an older generation after %s changes", async (_label, change) => {
    vi.useFakeTimers();
    const pending: Array<
      (
        value: ReturnType<
          typeof import("./analysisAdapter.ts")["analyzeCoachPassages"]
        >,
      ) => void
    > = [];
    const controller = createWritingCoachController("essay-1", {
      analyze: () => new Promise((resolve) => pending.push(resolve)),
    });
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.updateSnapshot(snapshot(1, undefined, change));
    pending.shift()?.({ status: "available", issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().status).toBe("analyzing");
    controller.destroy();
  });

  it("fails closed on extraction failure, essay mismatch, external refresh, and teardown", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.reportExtractionFailure();
    expect(controller.getState().status).toBe("unavailable-for-current-text");
    controller.updateSnapshot(snapshot(2, undefined, { essayId: "essay-2" }));
    expect(controller.getState().status).toBe("unavailable-for-current-text");
    controller.updateSnapshot(
      snapshot(3, undefined, { citationEnvironmentVersion: 3 }),
    );
    expect(controller.getState().status).toBe("analyzing");
    controller.destroy();
    expect(controller.getState().status).toBe("idle");
  });
});

describe("fixed question-led sessions", () => {
  it("does not retain a fixed passage absent from refreshed results", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const first = controller.getState();
    if (first.status !== "issues") throw new Error("expected issues");
    const fixed = first.fixed;

    controller.updateSnapshot(
      snapshot(2, "Various aspects shaped a separate paragraph."),
    );
    expect(controller.getState().fixed).toBe(fixed);
    await vi.advanceTimersByTimeAsync(300);
    const updated = controller.getState();
    expect(updated.status).toBe("issues");
    if (updated.status === "issues") {
      expect(updated.fixed.issue).toBe(updated.issues[0]);
      expect(updated.fixed.issue.passage.text).toBe(
        "Various aspects shaped a separate paragraph.",
      );
      expect(updated.issues[0]?.passage.revision).toBe(2);
    }
    controller.destroy();
  });

  it("uses explicit deterministic selection and wraps only with multiple issues", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    const text =
      "It is important to note that the policy changed in many ways during review.";
    controller.updateSnapshot(snapshot(1, text));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const initial = controller.getState();
    if (initial.status !== "issues") throw new Error("expected issues");
    expect(initial.issues.map((issue) => issue.issue.category)).toEqual([
      "voice",
      "specificity",
    ]);
    controller.nextIssue();
    expect(controller.getState().fixed?.position).toBe(2);
    controller.nextIssue();
    expect(controller.getState().fixed?.position).toBe(1);
    controller.previousIssue();
    expect(controller.getState().fixed?.position).toBe(2);
    controller.selectIssue(initial.issues[0]!.identity);
    expect(controller.getState().fixed?.position).toBe(1);
    controller.destroy();

    const single = createWritingCoachController("essay-1");
    single.updateSnapshot(snapshot(1));
    single.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const fixed = single.getState().fixed;
    single.nextIssue();
    single.previousIssue();
    expect(single.getState().fixed).toBe(fixed);
    single.destroy();
  });

  it("invalidates fixed sessions on source, language, citation, essay, and lifecycle changes", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().fixed).not.toBeNull();
    controller.invalidateFixedSource();
    expect(controller.getState().fixed).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    controller.updateSnapshot(
      snapshot(2, undefined, { documentLanguage: "es" }),
    );
    expect(controller.getState().fixed).toBeNull();
    controller.updateSnapshot(
      snapshot(3, undefined, { citationEnvironmentVersion: 2 }),
    );
    expect(controller.getState().fixed).toBeNull();
    controller.updateSnapshot(snapshot(4, undefined, { essayId: "essay-2" }));
    expect(controller.getState().fixed).toBeNull();
    controller.destroy();
    expect(controller.getState()).toEqual({
      status: "idle",
      issues: [],
      fixed: null,
    });
  });

  it("clears only the fixed selection when leaving Study and starts re-entry at the first remaining issue", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(
      1,
      "It is important to note that the policy changed in many ways in order to complete review.",
    ));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.suppressCurrent("dismiss");
    controller.nextIssue();
    const prior = controller.getState().fixed;
    const suppressions = controller.getSuppressions();
    expect(prior?.position).toBe(2);

    controller.leaveStudy();
    expect(controller.getState().fixed).toBeNull();
    expect(controller.getSuppressions()).toEqual(suppressions);
    controller.updateSnapshot(snapshot(
      1,
      "It is important to note that the policy changed in many ways in order to complete review.",
    ));

    controller.enterStudy();
    expect(controller.getState().fixed?.position).toBe(1);
    expect(controller.getState().fixed).not.toBe(prior);
    expect(controller.getSuppressions()).toEqual(suppressions);
    controller.destroy();
  });

  it("does not restore old-revision issues while replacement analysis is pending", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState().fixed?.issue.passage.revision).toBe(1);

    controller.leaveStudy();
    controller.updateSnapshot(
      snapshot(2, "Various aspects shaped the revised policy."),
    );
    controller.enterStudy();

    expect(controller.getState().status).toBe("analyzing");
    expect(controller.getState().fixed).toBeNull();
    expect(controller.getState().issues[0]?.passage.revision).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState().status).toBe("issues");
    expect(controller.getState().fixed?.issue.passage.revision).toBe(2);
    expect(controller.getState().fixed?.issue.issue.observedText).toBe(
      "Various aspects",
    );
    controller.destroy();
  });

  it("maps a fixed source across unrelated edits and rejects touched text", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const before = controller.getState().fixed!;
    controller.mapFixedSource(
      new Mapping([new StepMap([1, 0, 5])]),
      () => "in many ways",
      2,
    );
    expect(controller.getState().fixed?.issue.editorRange).toEqual({
      from: 26,
      to: 38,
    });
    expect(controller.getState().fixed?.issue.passage.text).toBe(
      before.issue.passage.text,
    );
    expect(controller.getState().fixed?.issue.passage.revision).toBe(2);
    controller.mapFixedSource(
      new Mapping([new StepMap([30, 0, 1])]),
      () => "in many ways",
      3,
    );
    expect(controller.getState().fixed).toBeNull();
    controller.destroy();
  });

  it("keeps deterministic navigation aligned after mapping the selected source", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    const text =
      "It is important to note that the policy changed in many ways in order to complete review.";
    controller.updateSnapshot(snapshot(1, text));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const initial = controller.getState();
    if (initial.status !== "issues") throw new Error("expected issues");
    expect(initial.issues).toHaveLength(3);
    controller.selectIssue(initial.issues[1]!.identity);

    controller.mapFixedSource(
      new Mapping([new StepMap([1, 0, 5])]),
      () => initial.issues[1]!.issue.observedText,
      2,
    );

    const mapped = controller.getState();
    if (mapped.status !== "issues") throw new Error("expected issues");
    expect(mapped.fixed.issue).toBe(mapped.issues[1]);
    expect(mapped.fixed.position).toBe(2);
    controller.nextIssue();
    expect(controller.getState().fixed?.position).toBe(3);
    controller.previousIssue();
    expect(controller.getState().fixed?.position).toBe(2);
    controller.destroy();
  });

  it("restores Study after navigating a harmlessly mapped current issue", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const initial = controller.getState();
    if (initial.status !== "issues") throw new Error("expected issues");

    controller.mapFixedSource(
      new Mapping(),
      () => initial.fixed.issue.issue.observedText,
      1,
    );
    expect(
      await controller.editCurrentPassage(() => {}, () => true),
    ).toBe("navigated");

    controller.enterStudy();
    expect(controller.getState().status).toBe("issues");
    expect(controller.getState().fixed?.issue).toBe(
      controller.getState().issues[0],
    );
    controller.destroy();
  });

  it("rebinds refreshed navigation to a matching current issue or the first visible issue", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    const text =
      "It is important to note that the policy changed in many ways in order to complete review.";
    controller.updateSnapshot(snapshot(1, text));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const initial = controller.getState();
    if (initial.status !== "issues") throw new Error("expected issues");
    controller.selectIssue(initial.issues[1]!.identity);

    controller.updateSnapshot(snapshot(2, text));
    await vi.advanceTimersByTimeAsync(300);
    const refreshed = controller.getState();
    if (refreshed.status !== "issues") throw new Error("expected issues");
    expect(refreshed.fixed.issue).toBe(refreshed.issues[1]);
    expect(refreshed.fixed.position).toBe(2);
    controller.nextIssue();
    expect(controller.getState().fixed?.position).toBe(3);

    controller.updateSnapshot(snapshot(
      3,
      "The policy changed in many ways during review.",
    ));
    await vi.advanceTimersByTimeAsync(300);
    const fallback = controller.getState();
    if (fallback.status !== "issues") throw new Error("expected issues");
    expect(fallback.fixed.issue).toBe(fallback.issues[0]);
    expect(fallback.fixed.position).toBe(1);
    controller.destroy();
  });

  it("returns to Write before exact navigation and clears a stale fixed session", async () => {
    vi.useFakeTimers();
    const analyze = vi.fn(analyzeCoachPassages);
    const controller = createWritingCoachController("essay-1", { analyze });
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    const fixed = controller.getState().fixed!;
    const calls: string[] = [];

    expect(
      await controller.editCurrentPassage(
        () => {
          calls.push("write");
        },
        (issue) => {
          calls.push("navigate");
          expect(issue).toBe(fixed.issue);
          return true;
        },
      ),
    ).toBe("navigated");
    expect(calls).toEqual(["write", "navigate"]);
    expect(controller.getState().fixed).toBeNull();

    controller.enterStudy();
    expect(controller.getState().fixed).not.toBe(fixed);

    expect(
      await controller.editCurrentPassage(
        () => {
          calls.push("write-stale");
        },
        () => {
          calls.push("reject-stale");
          return false;
        },
      ),
    ).toBe("stale");
    expect(calls.slice(-2)).toEqual(["write-stale", "reject-stale"]);
    expect(controller.getState().fixed).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(analyze).toHaveBeenCalledTimes(1);

    controller.enterStudy();
    expect(controller.getState().status).toBe("analyzing");
    await vi.advanceTimersByTimeAsync(0);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe("issues");
    expect(controller.getState().fixed).not.toBeNull();
    controller.destroy();
  });
});

describe("session-only suppressions", () => {
  it("returns an immutable suppression view that cannot mutate controller state", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.suppressCurrent("dismiss");

    const exposed = controller.getSuppressions();
    const expectedRange = { ...exposed[0]!.editorRange };
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(Reflect.set(exposed[0]!.editorRange, "from", 0)).toBe(false);
    expect(Reflect.deleteProperty(exposed, "0")).toBe(false);
    expect(controller.getSuppressions()[0]?.editorRange).toEqual(expectedRange);
    controller.destroy();
  });

  it.each(["dismiss", "not-helpful"] as const)(
    "%s hides the current issue with no callback or generation identity",
    async (action) => {
      vi.useFakeTimers();
      const controller = createWritingCoachController("essay-1");
      controller.updateSnapshot(snapshot(1));
      controller.enterStudy();
      await vi.advanceTimersByTimeAsync(0);
      controller.suppressCurrent(action);
      expect(controller.getState().status).toBe("no-current-issues");
      expect(controller.getSuppressions()).toHaveLength(1);
      expect("generation" in controller.getSuppressions()[0]!).toBe(false);
      controller.destroy();
      expect(controller.getSuppressions()).toEqual([]);
    },
  );

  it("maps an unchanged suppression across an earlier edit and removes it when touched", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.suppressCurrent("dismiss");
    controller.mapSuppressions(
      new Mapping([new StepMap([1, 0, 5])]),
      () => "in many ways",
    );
    expect(controller.getSuppressions()[0]?.editorRange).toEqual({
      from: 26,
      to: 38,
    });
    const shifted = snapshot(2);
    controller.updateSnapshot({
      ...shifted,
      passages: shifted.passages.map((passage) => ({
        ...passage,
        offsetMap: passage.offsetMap.map((position) =>
          position === null ? null : position + 5
        ),
      })),
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState().status).toBe("no-current-issues");

    controller.mapSuppressions(
      new Mapping([new StepMap([30, 0, 1])]),
      () => "in many ways",
    );
    expect(controller.getSuppressions()).toEqual([]);
    controller.destroy();
  });

  it("clears suppressions on language and citation-environment changes", async () => {
    vi.useFakeTimers();
    const controller = createWritingCoachController("essay-1");
    controller.updateSnapshot(snapshot(1));
    controller.enterStudy();
    await vi.advanceTimersByTimeAsync(0);
    controller.suppressCurrent("dismiss");
    controller.updateSnapshot(
      snapshot(2, undefined, { documentLanguage: "es" }),
    );
    expect(controller.getSuppressions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    controller.suppressCurrent("not-helpful");
    controller.updateSnapshot(
      snapshot(3, undefined, { citationEnvironmentVersion: 4 }),
    );
    expect(controller.getSuppressions()).toEqual([]);
    controller.destroy();
  });
});
