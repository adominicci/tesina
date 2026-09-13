import type { DocLocale } from "@tesina/engine";
import type { Mapping } from "@tiptap/pm/transform";
import {
  analyzeCoachPassages,
  type CoachPassageAnalysis,
} from "./analysisAdapter.ts";
import {
  type CoachControllerState,
  type CoachPassageSnapshot,
  type CoachSuppression,
  type EditorRange,
  type FixedCoachSession,
  type MappedCoachIssue,
  mappedIssueIdentity,
} from "./types.ts";
import {
  createCoachSuppression,
  mapCoachRange,
  mapCoachSuppression,
  suppressionMatchesIssue,
} from "./mapping.ts";

export interface CoachAnalysisSnapshot {
  readonly essayId: string;
  readonly revision: number;
  readonly documentLanguage: DocLocale;
  readonly citationEnvironmentVersion: number;
  readonly snapshotId: string;
  readonly passages: readonly CoachPassageSnapshot[];
}

export interface WritingCoachControllerOptions {
  readonly analyze?: (
    passages: readonly CoachPassageSnapshot[],
    generation: number,
  ) => CoachPassageAnalysis | Promise<CoachPassageAnalysis>;
}

const emptyState = (
  status: "idle" | "no-current-issues" | "unavailable-for-current-text",
): CoachControllerState => ({ status, issues: [], fixed: null });

const analyzingState = (
  prior: CoachControllerState,
): CoachControllerState => ({
  status: "analyzing",
  issues: prior.issues,
  fixed: prior.fixed,
});

function sameIdentity(
  left: CoachAnalysisSnapshot,
  right: CoachAnalysisSnapshot,
): boolean {
  return left.essayId === right.essayId && left.revision === right.revision &&
    left.documentLanguage === right.documentLanguage &&
    left.citationEnvironmentVersion === right.citationEnvironmentVersion &&
    left.snapshotId === right.snapshotId;
}

function fixedSessionForIssues(
  issues: readonly MappedCoachIssue[],
  prior: FixedCoachSession | null,
): FixedCoachSession {
  let index = 0;
  if (prior !== null) {
    const priorIdentity = createCoachSuppression(prior.issue, "dismiss");
    const matchingIndex = issues.findIndex((issue) =>
      suppressionMatchesIssue(issue, priorIdentity)
    );
    if (matchingIndex >= 0) index = matchingIndex;
  }
  return Object.freeze({
    kind: "fixed-coach-session" as const,
    issue: issues[index]!,
    position: index + 1,
    total: issues.length,
  });
}

export function createWritingCoachController(
  essayId: string,
  options: WritingCoachControllerOptions = {},
) {
  const analyze = options.analyze ?? analyzeCoachPassages;
  let current: CoachAnalysisSnapshot | null = null;
  let state: CoachControllerState = emptyState("idle");
  let armed = false;
  let studyActive = false;
  let destroyed = false;
  let generation = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maximumTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressions: CoachSuppression[] = [];
  const listeners = new Set<(value: CoachControllerState) => void>();

  const setState = (next: CoachControllerState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const clearTimers = () => {
    if (trailingTimer !== null) clearTimeout(trailingTimer);
    if (maximumTimer !== null) clearTimeout(maximumTimer);
    trailingTimer = null;
    maximumTimer = null;
  };

  const publish = (
    captured: CoachAnalysisSnapshot,
    capturedGeneration: number,
    result: CoachPassageAnalysis,
  ) => {
    if (
      destroyed || capturedGeneration !== generation || !current ||
      !sameIdentity(captured, current)
    ) return;
    if (result.status === "unavailable-for-current-text") {
      setState(emptyState("unavailable-for-current-text"));
      return;
    }
    const visibleIssues = result.issues.filter((issue) =>
      !suppressions.some((suppression) =>
        suppressionMatchesIssue(issue, suppression)
      )
    );
    if (visibleIssues.length === 0) {
      setState(emptyState("no-current-issues"));
      return;
    }
    if (!studyActive) {
      setState({ status: "analyzing", issues: visibleIssues, fixed: null });
      return;
    }
    setState({
      status: "issues",
      issues: visibleIssues,
      fixed: fixedSessionForIssues(visibleIssues, state.fixed),
    });
  };

  const publishFailure = (
    captured: CoachAnalysisSnapshot,
    capturedGeneration: number,
  ) => {
    if (
      destroyed || capturedGeneration !== generation || !current ||
      !sameIdentity(captured, current)
    ) return;
    setState(emptyState("unavailable-for-current-text"));
  };

  const run = () => {
    clearTimers();
    if (destroyed || !armed || !current) return;
    const captured = current;
    const capturedGeneration = generation;
    queueMicrotask(() => {
      if (destroyed || capturedGeneration !== generation) return;
      let result: CoachPassageAnalysis | Promise<CoachPassageAnalysis>;
      try {
        result = analyze(captured.passages, capturedGeneration);
      } catch {
        publishFailure(captured, capturedGeneration);
        return;
      }
      Promise.resolve(result).then(
        (value) => publish(captured, capturedGeneration, value),
        () => publishFailure(captured, capturedGeneration),
      );
    });
  };

  const schedule = () => {
    if (!armed || destroyed || !current) return;
    setState(analyzingState(state));
    if (trailingTimer !== null) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(run, 300);
    if (maximumTimer === null) maximumTimer = setTimeout(run, 1_000);
  };

  return {
    getState: (): CoachControllerState => state,
    subscribe(listener: (value: CoachControllerState) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    updateSnapshot(next: CoachAnalysisSnapshot): void {
      if (destroyed || next.essayId !== essayId) return;
      if (current && sameIdentity(current, next)) return;
      const invalidatesFixed = current !== null &&
        (current.documentLanguage !== next.documentLanguage ||
          current.citationEnvironmentVersion !==
            next.citationEnvironmentVersion);
      current = next;
      generation += 1;
      if (invalidatesFixed) {
        suppressions = [];
        setState(emptyState("no-current-issues"));
      }
      if (armed) schedule();
    },
    enterStudy(): void {
      if (destroyed) return;
      studyActive = true;
      if (armed) {
        const currentSnapshot = current;
        const retainedIssuesAreCurrent = currentSnapshot !== null &&
          state.issues.length > 0 &&
          state.issues.every((issue) =>
            issue.generation === generation &&
            currentSnapshot.passages.some((passage) =>
              passage.passageId === issue.passage.passageId &&
              passage.revision === issue.passage.revision &&
              passage.documentLanguage === issue.passage.documentLanguage &&
              passage.citationEnvironmentVersion ===
                issue.passage.citationEnvironmentVersion &&
              passage.text === issue.passage.text
            )
          );
        if (state.fixed === null && retainedIssuesAreCurrent) {
          setState({
            status: "issues",
            issues: state.issues,
            fixed: Object.freeze({
              kind: "fixed-coach-session",
              issue: state.issues[0]!,
              position: 1,
              total: state.issues.length,
            }),
          });
        } else if (
          state.status === "analyzing" && state.issues.length === 0
        ) {
          generation += 1;
          run();
        }
        return;
      }
      armed = true;
      setState(analyzingState(state));
      generation += 1;
      run();
    },
    leaveStudy(): void {
      if (destroyed) return;
      studyActive = false;
      if (state.fixed === null) return;
      setState({ status: "analyzing", issues: state.issues, fixed: null });
    },
    reportExtractionFailure(): void {
      if (destroyed) return;
      generation += 1;
      clearTimers();
      setState(emptyState("unavailable-for-current-text"));
    },
    selectIssue(identity: string): void {
      if (state.status !== "issues") return;
      const index = state.issues.findIndex((issue) =>
        issue.identity === identity
      );
      if (index < 0) return;
      setState({
        ...state,
        fixed: Object.freeze({
          kind: "fixed-coach-session",
          issue: state.issues[index]!,
          position: index + 1,
          total: state.issues.length,
        }),
      });
    },
    nextIssue(): void {
      if (state.status !== "issues" || state.issues.length < 2) return;
      const fixed = state.fixed;
      const currentIndex = state.issues.findIndex((issue) =>
        issue.identity === fixed.issue.identity
      );
      const index = (currentIndex + 1) % state.issues.length;
      this.selectIssue(state.issues[index]!.identity);
    },
    previousIssue(): void {
      if (state.status !== "issues" || state.issues.length < 2) return;
      const fixed = state.fixed;
      const currentIndex = state.issues.findIndex((issue) =>
        issue.identity === fixed.issue.identity
      );
      const index = (currentIndex - 1 + state.issues.length) %
        state.issues.length;
      this.selectIssue(state.issues[index]!.identity);
    },
    invalidateFixedSource(): void {
      if (
        destroyed || state.fixed === null ||
        (state.status !== "issues" && state.status !== "analyzing")
      ) return;
      generation += 1;
      clearTimers();
      setState(
        armed
          ? analyzingState(emptyState("no-current-issues"))
          : emptyState("idle"),
      );
    },
    mapFixedSource(
      mapping: Mapping,
      readText: (range: EditorRange) => string,
      revision: number,
    ): void {
      if (destroyed || state.fixed === null) return;
      const editorRange = mapCoachRange(state.fixed.issue.editorRange, mapping);
      if (
        !editorRange ||
        readText(editorRange) !== state.fixed.issue.issue.observedText
      ) {
        generation += 1;
        setState(
          armed
            ? analyzingState(emptyState("no-current-issues"))
            : emptyState("idle"),
        );
        return;
      }
      const provisional: MappedCoachIssue = {
        ...state.fixed.issue,
        identity: "",
        passage: { ...state.fixed.issue.passage, revision },
        editorRange,
      };
      const issue = Object.freeze({
        ...provisional,
        identity: mappedIssueIdentity(provisional),
      });
      const priorIdentity = state.fixed.issue.identity;
      const issues = state.issues.map((candidate) =>
        candidate.identity === priorIdentity ? issue : candidate
      );
      const mappedFixed = Object.freeze({
        ...state.fixed,
        issue,
      });
      setState({
        ...state,
        issues,
        fixed: fixedSessionForIssues(issues, mappedFixed),
      });
    },
    suppressCurrent(action: CoachSuppression["action"]): void {
      if (state.status !== "issues") return;
      suppressions.push(createCoachSuppression(state.fixed.issue, action));
      const remaining = state.issues.filter((issue) =>
        !suppressions.some((suppression) =>
          suppressionMatchesIssue(issue, suppression)
        )
      );
      if (remaining.length === 0) {
        setState(emptyState("no-current-issues"));
        return;
      }
      setState({
        status: "issues",
        issues: remaining,
        fixed: Object.freeze({
          kind: "fixed-coach-session",
          issue: remaining[0]!,
          position: 1,
          total: remaining.length,
        }),
      });
    },
    mapSuppressions(
      mapping: Mapping,
      readText: (range: EditorRange) => string,
    ): void {
      suppressions = suppressions.flatMap((suppression) => {
        const mapped = mapCoachSuppression(suppression, mapping, readText);
        return mapped ? [mapped] : [];
      });
    },
    getSuppressions(): readonly CoachSuppression[] {
      return Object.freeze(suppressions.map((suppression) =>
        Object.freeze({
          ...suppression,
          editorRange: Object.freeze({ ...suppression.editorRange }),
        })
      ));
    },
    async editCurrentPassage(
      showWrite: () => void | Promise<void>,
      navigate: (issue: MappedCoachIssue) => boolean,
    ): Promise<"navigated" | "stale"> {
      const issue = state.fixed?.issue ?? null;
      this.leaveStudy();
      await showWrite();
      if (destroyed || !issue || !navigate(issue)) {
        if (!destroyed) {
          setState(
            state.status === "analyzing"
              ? analyzingState(emptyState("no-current-issues"))
              : emptyState("no-current-issues"),
          );
        }
        return "stale";
      }
      return "navigated";
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      studyActive = false;
      generation += 1;
      clearTimers();
      current = null;
      suppressions = [];
      setState(emptyState("idle"));
      listeners.clear();
    },
  };
}
