import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ownedProcessStatusWithin,
  terminateOwnedProcess,
} from "./packaged-macos-smoke.ts";

export function readLocalAiProofResult(stdout: string, stderr: string) {
  const fail = () => {
    throw new Error("local-ai-proof-failed");
  };
  if (stderr.length || stdout.length > 64 * 1024) return fail();
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return fail();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== 17 ||
    result.proof !== "local-ai-webview-v1" || result.cases !== 12 ||
    result.genericHttpDenied !== true || result.privateFsDenied !== true ||
    result.privateFsWriteDenials !== 2 ||
    result.cspDenied !== true || result.trapConnections !== 0 ||
    result.cancellations !== 2 || result.nativeEscapeDenied !== true ||
    result.cancellationTableEntries !== 32 ||
    result.cancellationTableSaturated !== true ||
    result.readCancellation !== true || result.completionOrdering !== true ||
    result.freshGeneration !== true ||
    result.pendingCancelWins !== true ||
    result.updaterLifecycle !== true ||
    result.passed !== true
  ) return fail();
  return {
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
}

export function readLocalAiWebviewCapture(stdout: string, stderr: string) {
  try {
    return readLocalAiProofResult(stdout, stderr);
  } catch (error) {
    let stdoutSchemaValid = false;
    try {
      readLocalAiProofResult(stdout, "");
      stdoutSchemaValid = true;
    } catch {
      /* Diagnose independently; never accept or publish the payload. */
    }
    // Pattern evidence only, never verified origin; OS text is never published.
    const postMessage = stderr.length <= 512
      ? /^PostMessage failed ; is the messages queue full\? Error code (0x[0-9A-F]{8}) - [^\p{C}\u2028\u2029]{1,256}\r?\n(?![\s\S])/u
        .exec(stderr)
      : null;
    const postMessageKind = postMessage?.[1] === "0x80070578"
      ? "wry-postmessage-pattern-invalid-window"
      : postMessage?.[1] === "0x80070006"
      ? "wry-postmessage-pattern-invalid-handle"
      : postMessage?.[1] === "0x80070718"
      ? "wry-postmessage-pattern-quota"
      : "wry-postmessage-pattern-other";
    const nativeNoReport =
      "local-ai-webview-proof: no successful native report";
    const stderrKind = stderr === ""
      ? "empty"
      : stderr === `${nativeNoReport}\n` || stderr === `${nativeNoReport}\r\n`
      ? "native-no-report"
      : postMessage
      ? postMessageKind
      : "unknown";
    // Finite source-shape probe only; never retain or publish variable text.
    const wryPrefix =
      "PostMessage failed ; is the messages queue full? Error code ";
    const bounded = stderr.length <= 512;
    const wryFixedPrefixAtStart = bounded && stderr.startsWith(wryPrefix);
    const slot = wryFixedPrefixAtStart
      ? stderr.slice(wryPrefix.length, wryPrefix.length + 10)
      : "";
    const wryCodeShape = slot === ""
      ? "absent"
      : /^0x[0-9A-F]{8}$/.test(slot)
      ? "expected"
      : "different";
    let wrySuffixShape = "not-applicable";
    if (wryFixedPrefixAtStart && wryCodeShape === "expected") {
      const suffix = stderr.slice(wryPrefix.length + 10);
      if (!suffix.startsWith(" - ") || !suffix.endsWith("\n")) {
        wrySuffixShape = "extra-output-or-termination";
      } else {
        const message = suffix.slice(3).replace(/\r?\n$/, "");
        wrySuffixShape = message === ""
          ? "empty"
          : /[\p{C}\u2028\u2029]/u.test(message)
          ? "control-or-line-break"
          : "single-line-nonempty";
      }
    }
    const tauriInvokeKeyLiteralShape = bounded &&
      /^__TAURI_INVOKE_KEY__ expected [^\p{C}\u2028\u2029]* but received [^\p{C}\u2028\u2029]*\r?\n(?![\s\S])/u
        .test(stderr);
    console.error(JSON.stringify({
      proof: "local-ai-webview-capture-failure-v1",
      // UTF-16 code-unit lengths; 65537 is the over-capture-limit sentinel.
      stdoutCodeUnits: Math.min(stdout.length, 65537),
      stderrCodeUnits: Math.min(stderr.length, 65537),
      stdoutSchemaValid,
      stderrKind,
      sourceRoute: {
        wryFixedPrefixAtStart,
        wryCodeShape,
        wrySuffixShape,
        tauriInvokeKeyLiteralShape,
      },
    }));
    throw error;
  }
}

export function readLocalAiNativeOutput(
  stdout: string,
  stderr: string,
  platform = "darwin",
) {
  const lines = stdout.trim().split("\n");
  const marker =
    "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
  if (
    stderr || stdout.length > 64 * 1024 || lines.at(-1) !== marker ||
    !(platform === "windows"
      ? lines.length === 5
      : [1, 3].includes(lines.length)) ||
    !["darwin", "windows"].includes(platform) ||
    (platform === "windows" && lines.length !== 5)
  ) throw new Error("local-ai-native-proof-failed");
  for (const [index, line] of lines.slice(0, -1).entries()) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("local-ai-native-proof-failed");
    }
    if (platform === "windows") {
      if (index === 3) {
        if (
          !value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 23 ||
          value.proof !== "windows-handle-inheritance-v1" ||
          ![
            "created",
            "parentIdentity",
            "nulIdentity",
            "beforeAlive",
            "afterAlive",
            "cleaned",
            "sentinelAlive",
            "sentinelResponsive",
            "sentinelReleased",
            "passed",
          ].every((key) => value[key] === true) ||
          value.inspectionError !== false ||
          !["invalid-handle", "different-object"].includes(value.exclusion) ||
          ![value.ownerPid, value.sentinelPid, value.fakePid].every((n) =>
            Number.isInteger(n) && n > 1 && n <= 4294967295
          ) ||
          new Set([value.ownerPid, value.sentinelPid, value.fakePid]).size !==
            3 ||
          ![
            value.jobFlags,
            value.nulFlags,
            value.canaryFlags,
            value.processFlags,
            value.threadFlags,
          ].every((n) => Number.isInteger(n) && n >= 0 && n <= 3) ||
          (value.jobFlags & 1) !== 0 || (value.processFlags & 1) !== 0 ||
          (value.threadFlags & 1) !== 0 ||
          (value.nulFlags & 1) !== 1 || (value.canaryFlags & 1) !== 1 ||
          !Number.isSafeInteger(value.startedUnixMs) ||
          value.startedUnixMs <= 0 ||
          !Number.isInteger(value.cleanupMs) || value.cleanupMs < 0 ||
          value.cleanupMs >= 5000
        ) throw new Error("local-ai-native-proof-failed");
        continue;
      }
      if (index === 2) {
        if (
          !value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 19 ||
          value.proof !== "windows-creation-quota-v1" ||
          value.created !== false ||
          ![
            "holderMember",
            "startupFailed",
            "markerAbsent",
            "holderSignalled",
            "sentinelAlive",
            "sentinelResponsive",
            "sentinelReleased",
            "passed",
          ].every((key) => value[key] === true) ||
          value.limit !== 1 || value.beforeCount !== 1 ||
          value.afterCount !== 1 || value.stage !== 10 ||
          !Number.isInteger(value.nativeCode) || value.nativeCode >= 0 ||
          value.nativeCode < -2147483648 ||
          ![value.holderPid, value.sentinelPid].every((pid) =>
            Number.isInteger(pid) && pid > 1 && pid <= 4294967295
          ) ||
          value.holderPid === value.sentinelPid ||
          !Number.isSafeInteger(value.startedUnixMs) ||
          value.startedUnixMs <= 0 ||
          !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 ||
          value.elapsedMs >= 5000
        ) throw new Error("local-ai-native-proof-failed");
        continue;
      }
      if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 18 ||
        value.proof !== "windows-parent-death-v1" ||
        value.phase !== ["loading", "read-generation"][index] ||
        ![
          "parentSignalled",
          "fakeSignalled",
          "sentinelAlive",
          "sentinelResponsive",
          "sentinelReleased",
          "passed",
        ].every((key) => value[key] === true) || value.waitError !== false ||
        ![
          value.parentPid,
          value.sentinelPid,
          value.fakePid,
          value.startedUnixMs,
        ].every((n) => Number.isSafeInteger(n) && n > 1) ||
        ![value.parentPid, value.sentinelPid, value.fakePid].every((n) =>
          n <= 4294967295
        ) ||
        new Set([value.parentPid, value.sentinelPid, value.fakePid]).size !==
          3 ||
        ![
          value.creationHigh,
          value.creationLow,
          value.parentExit,
          value.fakeExit,
        ].every((n) => Number.isInteger(n) && n >= 0 && n <= 4294967295) ||
        (value.creationHigh === 0 && value.creationLow === 0) ||
        !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 ||
        value.elapsedMs >= 5000
      ) throw new Error("local-ai-native-proof-failed");
      continue;
    }
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 9 || value.proof !== "parent-death-v1" ||
      value.phase !== ["loading", "read-generation"][index] ||
      value.passed !== true ||
      ![
        value.parentPid,
        value.sentinelPid,
        value.fakePid,
        value.guardianPid,
        value.startedUnixMs,
      ].every((n) => Number.isSafeInteger(n) && n > 1) ||
      !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 ||
      value.elapsedMs >= 5000
    ) throw new Error("local-ai-native-proof-failed");
  }
  return lines;
}

export function readLocalAiNativeQuit(stdout: string, stderr: string) {
  const fail = () => {
    throw new Error("local-ai-native-quit-failed");
  };
  if (stderr || stdout.length > 512) return fail();
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return fail();
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 9 ||
    value.proof !== "local-ai-native-quit-v1" ||
    value.firstNotReady !== true || value.laterReady !== true ||
    value.readyBeforeExit !== true ||
    value.passed !== true || !Number.isInteger(value.exitRequestedCount) ||
    value.exitRequestedCount < 2 || value.exitRequestedCount > 8 ||
    !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 ||
    value.elapsedMs >= 5000 ||
    ![value.fakePid, value.proofPid].every((n) =>
      Number.isInteger(n) && n > 1 && n <= 4294967295
    )
  ) return fail();
  return {
    proof: "local-ai-native-quit-v1",
    firstNotReady: true,
    laterReady: true,
    readyBeforeExit: true,
    exitRequestedCount: value.exitRequestedCount,
    elapsedMs: value.elapsedMs,
    fakePid: value.fakePid,
    proofPid: value.proofPid,
    passed: true,
  };
}

export function readLocalAiNativeFailure(stderr: string, exitCode: number) {
  const fail = () => {
    throw new Error("local-ai-invalid-failure-record");
  };
  if (
    stderr.length > 512 || !Number.isInteger(exitCode) || exitCode === 0 ||
    exitCode < -2147483648 || exitCode > 4294967295
  ) return fail();
  let value;
  try {
    value = JSON.parse(stderr);
  } catch {
    return fail();
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 13 ||
    value.proof !== "local-ai-native-panic-v1" ||
    !Number.isInteger(value.phase) || value.phase < 0 || value.phase > 11 ||
    !Number.isInteger(value.source) || value.source < 0 || value.source > 7 ||
    !Number.isInteger(value.result) || value.result < 0 || value.result > 15 ||
    typeof value.childStarted !== "boolean" ||
    typeof value.fixtureMarker !== "boolean" ||
    !Number.isInteger(value.windowsStage) || value.windowsStage < 0 ||
    value.windowsStage > 11 ||
    !Number.isInteger(value.windowsCode) || value.windowsCode < -2147483648 ||
    value.windowsCode > 2147483647 ||
    !Number.isInteger(value.fakeBind) || value.fakeBind < 0 ||
    value.fakeBind > 3 ||
    !(value.fakeBindCode === null ||
      (Number.isInteger(value.fakeBindCode) &&
        value.fakeBindCode >= -2147483648 &&
        value.fakeBindCode <= 2147483647)) ||
    (value.fakeBind !== 2 && value.fakeBindCode !== null) ||
    ![value.line, value.column].every((n) =>
      Number.isInteger(n) && n >= 0 && n <= 4294967295
    )
  ) return fail();
  const probe = value.transition;
  let transition = null;
  if (probe !== null) {
    if (
      !probe || typeof probe !== "object" || Array.isArray(probe) ||
      Object.keys(probe).length !== 5 || ![1, 2].includes(probe.site) ||
      ![1, 2, 3].includes(probe.initial) ||
      ![1, 2, 3].includes(probe.eventual) ||
      !Number.isInteger(probe.elapsedMs) || probe.elapsedMs < 0 ||
      probe.elapsedMs > 4294967295 ||
      !(probe.exitCode === null ||
        (Number.isInteger(probe.exitCode) && probe.exitCode >= 0 &&
          probe.exitCode <= 4294967295)) ||
      (probe.eventual !== 2 && probe.exitCode !== null)
    ) return fail();
    transition = {
      site: probe.site,
      initial: probe.initial,
      eventual: probe.eventual,
      elapsedMs: probe.elapsedMs,
      exitCode: probe.exitCode,
    };
  }
  return {
    exitCode,
    diagnostic: {
      proof: "local-ai-native-panic-v1",
      phase: value.phase,
      source: value.source,
      line: value.line,
      column: value.column,
      result: value.result,
      childStarted: value.childStarted,
      fixtureMarker: value.fixtureMarker,
      windowsStage: value.windowsStage,
      windowsCode: value.windowsCode,
      fakeBind: value.fakeBind,
      fakeBindCode: value.fakeBindCode,
      transition,
    },
  };
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  cap: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) throw new Error("local-ai-proof-output-limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function command(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  build = false,
) {
  const child = new Deno.Command(executable, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      phase: build ? "build" : "proof",
      executable,
      pid: child.pid,
      startedAt,
      cwd,
    }),
  );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let exited = false;
  const status = child.status.then((status) => {
    exited = true;
    return status;
  });
  try {
    const [result, stdout, stderr] = await Promise.all([
      ownedProcessStatusWithin(status, timeoutMs),
      capture(child.stdout, abort.signal, build ? 1024 * 1024 : 64 * 1024),
      capture(child.stderr, abort.signal, build ? 1024 * 1024 : 64 * 1024),
    ]);
    if (!result || abort.signal.aborted) {
      throw new Error("local-ai-proof-timeout");
    }
    if (!result.success) {
      if (build) console.error(stderr);
      else {
        let diagnostic = null;
        try {
          diagnostic = readLocalAiNativeFailure(stderr, result.code).diagnostic;
        } catch { /* Unrecognized stderr must never be published. */ }
        console.error(
          JSON.stringify({
            proof: "local-ai-process-failure-v1",
            exitCode: result.code,
            diagnostic,
          }),
        );
      }
      throw new Error("local-ai-proof-command-failed");
    }
    return { stdout, stderr, pid: child.pid, startedAt };
  } finally {
    clearTimeout(timer);
    abort.abort();
    // Reuse the existing exact-child SIGTERM/grace/forced-stop owner. Never
    // signal a process by name, port, PID file, or a broad process-tree lookup.
    if (!exited) await terminateOwnedProcess(child);
  }
}

async function digest(path: string) {
  const hash = createHash("sha256");
  const file = await Deno.open(path);
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  if (Deno.build.os !== "darwin" && Deno.build.os !== "windows") {
    throw new Error("local-ai-proof-unsupported-host");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const native = join(root, "apps/desktop/src-tauri");
  const temp = await Deno.makeTempDir({ prefix: "tesina-local-ai-proof-" });
  try {
    const script = join(temp, "proof.js");
    await command(
      Deno.execPath(),
      [
        "run",
        "-A",
        "apps/desktop/src/lib/local-ai/buildProof.ts",
        temp,
      ],
      root,
      120_000,
      true,
    );
    await command(
      "cargo",
      [
        "build",
        "--locked",
        "--features",
        "local-ai-proof",
        "--example",
        "local-ai-native-proof",
        "--example",
        "local-ai-webview-proof",
        "--example",
        "local-ai-fake",
      ],
      native,
      600_000,
      true,
    );
    const suffix = Deno.build.os === "windows" ? ".exe" : "";
    const fake = join(native, "target/debug/examples/local-ai-fake" + suffix);
    const host = join(
      native,
      "target/debug/examples/local-ai-webview-proof" + suffix,
    );
    const processHost = join(
      native,
      "target/debug/examples/local-ai-native-proof" + suffix,
    );
    const processResult = await command(processHost, [fake], native, 90_000);
    const nativeProcessOutput = readLocalAiNativeOutput(
      processResult.stdout,
      processResult.stderr,
      Deno.build.os,
    );
    if (Deno.build.os === "windows") {
      // Publish only parsed, fully validated closed phase records before later UI proof.
      console.log(JSON.stringify({
        proof: "windows-parent-death-checkpoint-v1",
        creation: JSON.parse(nativeProcessOutput[2]),
        inheritance: JSON.parse(nativeProcessOutput[3]),
        phases: nativeProcessOutput.slice(0, 2).map((line) => JSON.parse(line)),
      }));
    }
    const webview = await command(host, [fake, script], native, 70_000);
    const result = readLocalAiWebviewCapture(webview.stdout, webview.stderr);
    const quit = await command(
      host,
      [fake, script, "--native-quit"],
      native,
      20_000,
    );
    const nativeQuit = readLocalAiNativeQuit(quit.stdout, quit.stderr);
    if (nativeQuit.proofPid !== quit.pid) {
      throw new Error("local-ai-native-quit-owner");
    }
    console.log(JSON.stringify({
      ...result,
      fixtureVersion: 1,
      os: Deno.build.os,
      osRelease: Deno.osRelease(),
      arch: Deno.build.arch,
      proofPid: webview.pid,
      startedAt: webview.startedAt,
      commit: Deno.env.get("TESINA_PROOF_COMMIT_SHA") ?? "uncommitted-local",
      proofSha256: await digest(host),
      fakeSha256: await digest(fake),
      scriptSha256: await digest(script),
      nativeProcessOutput,
      nativeQuit,
      excludedClaims: [
        "complete E1-E8 acceptance",
        "real model/runtime",
        "packaged artifact",
        "Windows parent-death/graceful-exit proof",
      ],
    }));
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}
if (import.meta.main) await main();
