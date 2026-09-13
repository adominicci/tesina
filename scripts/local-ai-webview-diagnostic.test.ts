import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLocalAiProofResult,
  readLocalAiWebviewCapture,
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
const noSourceRoute = {
  wryFixedPrefixAtStart: false,
  wryCodeShape: "absent",
  wrySuffixShape: "not-applicable",
  tauriInvokeKeyLiteralShape: false,
};

afterEach(() => vi.restoreAllMocks());
describe("primary WebView failure diagnostic", () => {
  it("decomposes only bounded fixed source shapes without exposing variable material", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    const prefix =
      "PostMessage failed ; is the messages queue full? Error code ";
    for (
      const [stderr, sourceRoute] of [
        [`${prefix}0x80070578 - PRIVATE\u001bCANARY\n`, {
          wryFixedPrefixAtStart: true,
          wryCodeShape: "expected",
          wrySuffixShape: "control-or-line-break",
          tauriInvokeKeyLiteralShape: false,
        }],
        [
          "__TAURI_INVOKE_KEY__ expected EXPECTED_CANARY but received RECEIVED_CANARY\n",
          {
            wryFixedPrefixAtStart: false,
            wryCodeShape: "absent",
            wrySuffixShape: "not-applicable",
            tauriInvokeKeyLiteralShape: true,
          },
        ],
      ] as const
    ) {
      publish.mockClear();
      expect(() => readLocalAiWebviewCapture(JSON.stringify(passing), stderr))
        .toThrow("local-ai-proof-failed");
      expect(JSON.parse(String(publish.mock.calls[0][0])).sourceRoute).toEqual(
        sourceRoute,
      );
      expect(JSON.stringify(publish.mock.calls)).not.toContain("CANARY");
    }
  });
  it("identifies a complete PostMessage pattern without publishing OS text", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = JSON.stringify(passing);
    const stderr =
      "PostMessage failed ; is the messages queue full? Error code 0x80070578 - OS_MESSAGE_CANARY\n";
    expect(() => readLocalAiWebviewCapture(stdout, stderr)).toThrow(
      "local-ai-proof-failed",
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      proof: "local-ai-webview-capture-failure-v1",
      stdoutCodeUnits: stdout.length,
      stderrCodeUnits: stderr.length,
      stdoutSchemaValid: true,
      stderrKind: "wry-postmessage-pattern-invalid-window",
      sourceRoute: {
        ...noSourceRoute,
        wryFixedPrefixAtStart: true,
        wryCodeShape: "expected",
        wrySuffixShape: "single-line-nonempty",
      },
    }));
    expect(JSON.stringify(publish.mock.calls)).not.toContain("CANARY");
  });
  it("keeps finite source routes bounded and distinguishes empty, malformed and unterminated shapes", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    const prefix =
      "PostMessage failed ; is the messages queue full? Error code ";
    const wry = { ...noSourceRoute, wryFixedPrefixAtStart: true };
    for (
      const [stderr, expected] of [
        [prefix, wry],
        [`${prefix}CODE_CANARY - TEXT_CANARY\n`, {
          ...wry,
          wryCodeShape: "different",
        }],
        [`${prefix}0x80070578 - \n`, {
          ...wry,
          wryCodeShape: "expected",
          wrySuffixShape: "empty",
        }],
        [`${prefix}0x80070578 - TEXT_CANARY`, {
          ...wry,
          wryCodeShape: "expected",
          wrySuffixShape: "extra-output-or-termination",
        }],
        [`${prefix}0x80070578 ! TEXT_CANARY\n`, {
          ...wry,
          wryCodeShape: "expected",
          wrySuffixShape: "extra-output-or-termination",
        }],
        [`${prefix}0x80070578 - FIRST_CANARY\nSECOND_CANARY\n`, {
          ...wry,
          wryCodeShape: "expected",
          wrySuffixShape: "control-or-line-break",
        }],
        [prefix + "X".repeat(513 - prefix.length), noSourceRoute],
        [
          "PREFIX_CANARY__TAURI_INVOKE_KEY__ expected KEY_CANARY but received KEY_CANARY\n",
          noSourceRoute,
        ],
        [
          "__TAURI_INVOKE_KEY__ expected KEY_CANARY but received KEY_CANARY\nEXTRA_CANARY",
          noSourceRoute,
        ],
        [
          "__TAURI_INVOKE_KEY__ expected KEY_CANARY wrong delimiter KEY_CANARY\n",
          noSourceRoute,
        ],
      ] as const
    ) {
      publish.mockClear();
      expect(() => readLocalAiWebviewCapture(JSON.stringify(passing), stderr))
        .toThrow("local-ai-proof-failed");
      const diagnostic = JSON.parse(String(publish.mock.calls[0][0]));
      expect(diagnostic.sourceRoute).toEqual(expected);
      expect(diagnostic.stderrKind).toBe("unknown");
      expect(Object.keys(diagnostic)).toHaveLength(6);
      expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
      expect(JSON.stringify(diagnostic).length).toBeLessThan(512);
    }
  });
  it("keeps code categories closed and extra or control output unknown", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    const prefix =
      "PostMessage failed ; is the messages queue full? Error code ";
    const valid = `${prefix}0x80070578 - OS_CANARY\n`;
    for (
      const [stderr, kind] of [
        [
          `${prefix}0x80070006 - OS_CANARY\r\n`,
          "wry-postmessage-pattern-invalid-handle",
        ],
        [`${prefix}0x80070718 - OS_CANARY\n`, "wry-postmessage-pattern-quota"],
        [`${prefix}0x8007ABCD - OS_CANARY\n`, "wry-postmessage-pattern-other"],
        [`PREFIX_CANARY${valid}`, "unknown"],
        [`${valid}SUFFIX_CANARY`, "unknown"],
        [`${valid}\n`, "unknown"],
        [`${valid}${valid}`, "unknown"],
        [valid.replace("OS_CANARY", "OS\u001bCANARY"), "unknown"],
        [valid.replace("OS_CANARY", "OS\u2028CANARY"), "unknown"],
        [valid.replace("OS_CANARY", "X".repeat(257)), "unknown"],
        [valid.replace("0x80070578", "0x8007abcd"), "unknown"],
        [valid.slice(0, -1), "unknown"],
      ]
    ) {
      publish.mockClear();
      expect(() => readLocalAiWebviewCapture(JSON.stringify(passing), stderr))
        .toThrow("local-ai-proof-failed");
      expect(JSON.parse(String(publish.mock.calls[0][0])).stderrKind).toBe(
        kind,
      );
      expect(JSON.stringify(publish.mock.calls)).not.toContain("CANARY");
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });
  it("still rejects stderr while reporting valid stdout without its payload", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = JSON.stringify(passing);
    const stderr = "PRIVATE_SOURCE_KEY_PATH_CANARY";
    expect(() => readLocalAiProofResult(stdout, stderr)).toThrow(
      "local-ai-proof-failed",
    );
    expect(() => readLocalAiWebviewCapture(stdout, stderr)).toThrow(
      "local-ai-proof-failed",
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      proof: "local-ai-webview-capture-failure-v1",
      stdoutCodeUnits: stdout.length,
      stderrCodeUnits: stderr.length,
      stdoutSchemaValid: true,
      stderrKind: "unknown",
      sourceRoute: noSourceRoute,
    }));
    expect(JSON.stringify(publish.mock.calls)).not.toContain(stderr);
  });
  it("publishes nothing on success and never sanitizes invalid stdout into a pass", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readLocalAiWebviewCapture(JSON.stringify(passing), "")).toEqual(
      passing,
    );
    expect(publish).not.toHaveBeenCalled();
    const stdout = JSON.stringify({ ...passing, content: "OUTPUT_CANARY" });
    expect(() => readLocalAiWebviewCapture(stdout, "")).toThrow(
      "local-ai-proof-failed",
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      proof: "local-ai-webview-capture-failure-v1",
      stdoutCodeUnits: stdout.length,
      stderrCodeUnits: 0,
      stdoutSchemaValid: false,
      stderrKind: "empty",
      sourceRoute: noSourceRoute,
    }));
    expect(JSON.stringify(publish.mock.calls)).not.toContain("OUTPUT_CANARY");
  });
  it("classifies only the complete fixed host message and caps numeric lengths", () => {
    const publish = vi.spyOn(console, "error").mockImplementation(() => {});
    for (
      const [stderr, kind, sourceRoute = noSourceRoute] of [
        [
          "local-ai-webview-proof: no successful native report\n",
          "native-no-report",
        ],
        [
          "local-ai-webview-proof: no successful native report\r\n",
          "native-no-report",
        ],
        [
          "local-ai-webview-proof: no successful native report\nKEY_CANARY",
          "unknown",
        ],
        [
          "PostMessage failed ; is the messages queue full? Error code OS_CANARY",
          "unknown",
          {
            ...noSourceRoute,
            wryFixedPrefixAtStart: true,
            wryCodeShape: "different",
          },
        ],
        ["SECRET_CANARY".repeat(6000), "unknown"],
      ] as const
    ) {
      publish.mockClear();
      const stdout = "OUTPUT_CANARY".repeat(6000);
      expect(() => readLocalAiWebviewCapture(stdout, stderr)).toThrow(
        "local-ai-proof-failed",
      );
      expect(publish).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        proof: "local-ai-webview-capture-failure-v1",
        stdoutCodeUnits: 65537,
        stderrCodeUnits: Math.min(stderr.length, 65537),
        stdoutSchemaValid: false,
        stderrKind: kind,
        sourceRoute,
      }));
      expect(JSON.stringify(publish.mock.calls)).not.toContain("CANARY");
      expect(String(publish.mock.calls[0][0]).length).toBeLessThan(512);
    }
  });
});
