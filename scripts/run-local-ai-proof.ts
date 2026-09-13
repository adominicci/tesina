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

export function readLocalAiNativeOutput(stdout: string, stderr: string) {
  const lines = stdout.trim().split("\n");
  const marker =
    "local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending";
  if (
    stderr || stdout.length > 64 * 1024 || lines.at(-1) !== marker ||
    ![1, 3].includes(lines.length)
  ) throw new Error("local-ai-native-proof-failed");
  for (const [index, line] of lines.slice(0, -1).entries()) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("local-ai-native-proof-failed");
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
    Object.keys(value).length !== 12 ||
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
    );
    const webview = await command(host, [fake, script], native, 70_000);
    const result = readLocalAiProofResult(webview.stdout, webview.stderr);
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
