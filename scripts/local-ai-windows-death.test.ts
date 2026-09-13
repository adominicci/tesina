import { expect, it } from "vitest";
import { readLocalAiNativeOutput } from "./run-local-ai-proof.ts";
const inherited = {
  proof: "windows-handle-inheritance-v1",
  ownerPid: 300,
  sentinelPid: 301,
  startedUnixMs: 1700000000000,
  created: true,
  fakePid: 302,
  jobFlags: 0,
  nulFlags: 1,
  canaryFlags: 1,
  processFlags: 0,
  threadFlags: 0,
  parentIdentity: true,
  nulIdentity: true,
  exclusion: "invalid-handle",
  beforeAlive: true,
  afterAlive: true,
  inspectionError: false,
  cleaned: true,
  cleanupMs: 25,
  sentinelAlive: true,
  sentinelResponsive: true,
  sentinelReleased: true,
  passed: true,
};
const creation = {
  proof: "windows-creation-quota-v1",
  created: false,
  holderPid: 201,
  sentinelPid: 202,
  startedUnixMs: 1700000000000,
  limit: 1,
  beforeCount: 1,
  afterCount: 1,
  holderMember: true,
  startupFailed: true,
  stage: 10,
  nativeCode: -2147024891,
  markerAbsent: true,
  holderSignalled: true,
  elapsedMs: 20,
  sentinelAlive: true,
  sentinelResponsive: true,
  sentinelReleased: true,
  passed: true,
};

const marker =
  "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
it("requires both Windows owned-parent-death records rather than accepting no coverage", () => {
  expect(() => readLocalAiNativeOutput(marker, "", "windows")).toThrow(
    "local-ai-native-proof-failed",
  );
});

const record = {
  proof: "windows-parent-death-v1",
  phase: "loading",
  parentPid: 101,
  sentinelPid: 102,
  fakePid: 103,
  creationHigh: 1,
  creationLow: 2,
  startedUnixMs: 1700000000000,
  elapsedMs: 25,
  parentSignalled: true,
  fakeSignalled: true,
  sentinelAlive: true,
  sentinelResponsive: true,
  sentinelReleased: true,
  waitError: false,
  parentExit: 1,
  fakeExit: 1,
  passed: true,
};
const output = (changed: Record<string, unknown> = {}) =>
  [
    JSON.stringify({ ...record, ...changed }),
    JSON.stringify({ ...record, phase: "read-generation" }),
    JSON.stringify(creation),
    JSON.stringify(inherited),
    marker,
  ].join("\n");
it("accepts only two ordered Windows handle proofs with live responsive sentinel", () => {
  expect(readLocalAiNativeOutput(output(), "", "windows")).toHaveLength(5);
  for (
    const changed of [
      { parentSignalled: false },
      { fakeSignalled: false },
      { sentinelAlive: false },
      { sentinelResponsive: false },
      { sentinelReleased: false },
      { waitError: true },
      { elapsedMs: 5000 },
      { elapsedMs: -1 },
      { passed: false },
      { phase: "read-generation" },
      { proof: "parent-death-v1" },
      { fakePid: 101 },
      { guardianPid: 104 },
      { creationHigh: 0, creationLow: 0 },
      { parentExit: null },
      { fakeExit: 4294967296 },
      { fakePid: 4294967296 },
    ]
  ) {
    expect(() => readLocalAiNativeOutput(output(changed), "", "windows"))
      .toThrow("local-ai-native-proof-failed");
  }
  expect(() => readLocalAiNativeOutput(output(), "RAW_CANARY", "windows"))
    .toThrow();
  expect(() => readLocalAiNativeOutput(output(), "", "darwin")).toThrow();
  expect(() => readLocalAiNativeOutput(output(), "", "linux")).toThrow();
  expect(() =>
    readLocalAiNativeOutput(output() + "\nRAW_CANARY", "", "windows")
  ).toThrow();
  expect(() =>
    readLocalAiNativeOutput(
      JSON.stringify(record) + "\n" + marker,
      "",
      "windows",
    )
  ).toThrow();
});
