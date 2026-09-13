import { expect, it } from "vitest";
import { readLocalAiNativeOutput } from "./run-local-ai-proof.ts";

const marker =
  "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
const death = {
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
const quota = {
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
const previous = [death, { ...death, phase: "read-generation" }, quota].map((
  value,
) => JSON.stringify(value));
it("requires the Windows kernel handle inheritance case, not only quota/death", () => {
  expect(() =>
    readLocalAiNativeOutput([...previous, marker].join("\n"), "", "windows")
  ).toThrow();
});
it("requires positive identity, closed exclusion and exact cleanup evidence", () => {
  const output = (change = {}) =>
    [...previous, JSON.stringify({ ...inherited, ...change }), marker].join(
      "\n",
    );
  expect(readLocalAiNativeOutput(output(), "", "windows")).toHaveLength(5);
  expect(
    readLocalAiNativeOutput(
      output({ exclusion: "different-object" }),
      "",
      "windows",
    ),
  ).toHaveLength(5);
  for (
    const change of [
      { created: false },
      { parentIdentity: false },
      { nulIdentity: false },
      { beforeAlive: false },
      { afterAlive: false },
      { inspectionError: true },
      { cleaned: false },
      { cleanupMs: 5000 },
      { jobFlags: 1 },
      { nulFlags: 0 },
      { canaryFlags: 0 },
      { processFlags: 1 },
      { threadFlags: 1 },
      { threadFlags: 4294967296 },
      { exclusion: "same-object" },
      { exclusion: "api-error" },
      { exclusion: "unknown" },
      { ownerPid: 301 },
      { sentinelAlive: false },
      { sentinelResponsive: false },
      { sentinelReleased: false },
      { passed: false },
      { fakePid: 4294967296 },
      { extra: "PRIVATE_CANARY" },
    ]
  ) {
    expect(() => readLocalAiNativeOutput(output(change), "", "windows"))
      .toThrow();
  }
  expect(() => readLocalAiNativeOutput(output(), "PRIVATE_CANARY", "windows"))
    .toThrow();
  expect(() => readLocalAiNativeOutput(output(), "", "darwin")).toThrow();
});
