import { expect, it } from "vitest";
import { readLocalAiNativeOutput } from "./run-local-ai-proof.ts";

export const creation = {
  created: false,
  proof: "windows-creation-quota-v1",
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
export const death = {
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
const marker =
  "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
const records = [
  JSON.stringify(death),
  JSON.stringify({ ...death, phase: "read-generation" }),
];
it("requires actual Windows creation-quota coverage in addition to parent death", () => {
  expect(() =>
    readLocalAiNativeOutput([...records, marker].join("\n"), "", "windows")
  ).toThrow();
});
it("accepts only bounded closed successful quota-rejection evidence", () => {
  const output = (value: unknown) =>
    [...records, JSON.stringify(value), marker].join("\n");
  expect(readLocalAiNativeOutput(output(creation), "", "windows")).toHaveLength(
    4,
  );
  for (
    const change of [
      { created: true },
      { startupFailed: false },
      { holderMember: false },
      { markerAbsent: false },
      { holderSignalled: false },
      { sentinelAlive: false },
      { sentinelResponsive: false },
      { sentinelReleased: false },
      { passed: false },
      { limit: 2 },
      { beforeCount: 0 },
      { afterCount: 2 },
      { stage: 3 },
      { nativeCode: 0 },
      { nativeCode: 2147483648 },
      { elapsedMs: 5000 },
      { holderPid: 4294967296 },
      { sentinelPid: 201 },
      { extra: "RAW_CANARY" },
      { proof: "parent-death-v1" },
    ]
  ) {
    expect(() =>
      readLocalAiNativeOutput(output({ ...creation, ...change }), "", "windows")
    ).toThrow();
  }
  expect(() =>
    readLocalAiNativeOutput(output(creation), "RAW_CANARY", "windows")
  ).toThrow();
  expect(() => readLocalAiNativeOutput(output(creation), "", "darwin"))
    .toThrow();
});
