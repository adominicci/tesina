import { describe, expect, it } from "vitest";
import {
  readLocalAiNativeFailure,
  readLocalAiNativeOutput,
  readLocalAiNativeQuit,
  readLocalAiProofResult,
} from "./run-local-ai-proof.ts";

const passing = {
  proof: "local-ai-webview-v1",
  cases: 12,
  genericHttpDenied: true,
  privateFsDenied: true,
  privateFsWriteDenials: 2,
  cspDenied: true,
  trapConnections: 0,
  cancellations: 2,
  nativeEscapeDenied: true,
  cancellationTableEntries: 32,
  cancellationTableSaturated: true,
  readCancellation: true,
  completionOrdering: true,
  freshGeneration: true,
  pendingCancelWins: true,
  updaterLifecycle: true,
  passed: true,
};
describe("local inference native proof result", () => {
  it("requires ordered actual quit readiness before Exit", () => {
    const record = {
      proof: "local-ai-native-quit-v1",
      firstNotReady: true,
      laterReady: true,
      readyBeforeExit: true,
      exitRequestedCount: 2,
      elapsedMs: 20,
      fakePid: 123,
      proofPid: 456,
      passed: true,
    };
    expect(readLocalAiNativeQuit(JSON.stringify(record), "")).toEqual(record);
    for (
      const changed of [
        { firstNotReady: false },
        { laterReady: false },
        { readyBeforeExit: false },
        { exitRequestedCount: 1 },
        { elapsedMs: 5000 },
        { passed: false },
        { extra: true },
      ]
    ) {
      expect(() =>
        readLocalAiNativeQuit(JSON.stringify({ ...record, ...changed }), "")
      ).toThrow("local-ai-native-quit-failed");
    }
    expect(() => readLocalAiNativeQuit("", "")).toThrow(
      "local-ai-native-quit-failed",
    );
    expect(() => readLocalAiNativeQuit(JSON.stringify(record), "raw")).toThrow(
      "local-ai-native-quit-failed",
    );
  });
  it("accepts only a closed bounded native panic location and numeric exit", () => {
    const diagnostic = {
      proof: "local-ai-native-panic-v1",
      phase: 6,
      source: 1,
      line: 400,
      column: 5,
      result: 3,
      childStarted: false,
      fixtureMarker: false,
      windowsStage: 10,
      windowsCode: -2147024894,
      fakeBind: 2,
      fakeBindCode: 10022,
      transition: {
        site: 2,
        initial: 1,
        eventual: 2,
        elapsedMs: 1,
        exitCode: 23,
      },
    };
    expect(readLocalAiNativeFailure(JSON.stringify(diagnostic), 101)).toEqual({
      exitCode: 101,
      diagnostic,
    });
    for (
      const changed of [
        { phase: 12 },
        { source: 8 },
        { line: -1 },
        { column: 0.5 },
        { payload: "SOURCE_CANARY" },
        { source: "/private/paper" },
        { result: 20 },
        { childStarted: 1 },
        { fixtureMarker: "false" },
        { windowsStage: 12 },
        { windowsCode: 2147483648 },
        { fakeBind: 4 },
        { fakeBindCode: "RAW_ERROR" },
        { fakeBindCode: 2147483648 },
        {
          transition: {
            site: 3,
            initial: 1,
            eventual: 2,
            elapsedMs: 1,
            exitCode: 23,
          },
        },
        {
          transition: {
            site: 2,
            initial: 1,
            eventual: 2,
            elapsedMs: -1,
            exitCode: 23,
          },
        },
        {
          transition: {
            site: 2,
            initial: 1,
            eventual: 1,
            elapsedMs: 250,
            exitCode: 23,
          },
        },
        {
          transition: {
            site: 2,
            initial: 1,
            eventual: 2,
            elapsedMs: 1,
            exitCode: 23,
            raw: "SECRET",
          },
        },
      ]
    ) {
      expect(() =>
        readLocalAiNativeFailure(
          JSON.stringify({ ...diagnostic, ...changed }),
          101,
        )
      ).toThrow("local-ai-invalid-failure-record");
    }
    expect(
      readLocalAiNativeFailure(
        JSON.stringify({
          ...diagnostic,
          fakeBind: 0,
          fakeBindCode: null,
          transition: null,
        }),
        101,
      ).diagnostic.fakeBindCode,
    ).toBeNull();
    for (
      const stderr of [
        "",
        "SOURCE_CANARY",
        `${JSON.stringify(diagnostic)}\nKEY_CANARY`,
        "x".repeat(513),
      ]
    ) {
      expect(() => readLocalAiNativeFailure(stderr, 101)).toThrow(
        "local-ai-invalid-failure-record",
      );
    }
    for (const exitCode of [0, 1.5, NaN, 2 ** 32]) {
      expect(() =>
        readLocalAiNativeFailure(JSON.stringify(diagnostic), exitCode)
      ).toThrow("local-ai-invalid-failure-record");
    }
    expect(() =>
      readLocalAiNativeOutput(
        "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending",
        JSON.stringify(diagnostic),
      )
    ).toThrow("local-ai-native-proof-failed");
  });
  it("requires the structured actual webview outcomes, not only process exit", () => {
    expect(readLocalAiProofResult(JSON.stringify(passing), "")).toEqual(
      passing,
    );
    for (
      const changed of [
        { passed: false },
        { cases: 0 },
        { trapConnections: 1 },
        { cancellations: 0 },
        { nativeEscapeDenied: false },
        { privateFsWriteDenials: 1 },
        { privateFsWriteDenials: undefined },
        { cancellationTableEntries: 31 },
        { cancellationTableEntries: undefined },
        { cancellationTableSaturated: false },
        { cancellationTableSaturated: undefined },
        { readCancellation: false },
        { readCancellation: undefined },
        { completionOrdering: false },
        { completionOrdering: undefined },
        { freshGeneration: false },
        { freshGeneration: undefined },
        { pendingCancelWins: false },
        { pendingCancelWins: undefined },
        { updaterLifecycle: false },
        { updaterLifecycle: undefined },
      ]
    ) {
      expect(() =>
        readLocalAiProofResult(JSON.stringify({ ...passing, ...changed }), "")
      ).toThrow("local-ai-proof-failed");
    }
  });
  it("rejects absent reports and output outside the bounded report", () => {
    for (
      const stdout of [
        "",
        "{}",
        `${JSON.stringify(passing)}\nSOURCE_CANARY`,
        "x".repeat(128 * 1024),
      ]
    ) {
      expect(() => readLocalAiProofResult(stdout, "")).toThrow(
        "local-ai-proof-failed",
      );
    }
    expect(() =>
      readLocalAiProofResult(JSON.stringify(passing), "PAPER_CANARY")
    ).toThrow("local-ai-proof-failed");
  });
  it("does not publish arbitrary native stdout even when a success marker follows", () => {
    const marker =
      "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
    expect(readLocalAiNativeOutput(marker, "")).toEqual([marker]);
    const phase = (name: string) =>
      JSON.stringify({
        proof: "parent-death-v1",
        phase: name,
        parentPid: 123,
        sentinelPid: 124,
        fakePid: 125,
        guardianPid: 126,
        startedUnixMs: 1789305752568,
        elapsedMs: 40,
        passed: true,
      });
    expect(
      readLocalAiNativeOutput(
        `${phase("loading")}\n${phase("read-generation")}\n${marker}`,
        "",
      ),
    ).toHaveLength(3);
    for (
      const bad of [
        phase("unknown"),
        phase("loading").replace('"elapsedMs":40', '"elapsedMs":5000'),
        phase("loading").replace('"passed":true', '"passed":false'),
      ]
    ) {
      expect(() =>
        readLocalAiNativeOutput(
          `${bad}\n${phase("read-generation")}\n${marker}`,
          "",
        )
      ).toThrow("local-ai-native-proof-failed");
    }
    for (
      const extra of ["SOURCE_CANARY", "a".repeat(64), "/private/model.gguf"]
    ) {
      expect(() => readLocalAiNativeOutput(`${extra}\n${marker}`, "")).toThrow(
        "local-ai-native-proof-failed",
      );
    }
  });
});
