import { describe, expect, it } from "vitest";
import {
  readLocalAiNativeOutput,
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
  passed: true,
};
describe("local inference native proof result", () => {
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
