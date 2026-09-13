// Included only in the nonshipping platform proof example's separately built assets.
import { invoke } from "@tauri-apps/api/core";
import {
  BaseDirectory,
  exists,
  readFile,
  remove,
  writeFile,
} from "@tauri-apps/plugin-fs";
import { createLocalInferenceProvider } from "./client.ts";
import type { LocalInferenceRequest } from "./types.ts";
import { proveUpdaterLifecycle } from "./updaterProof.ts";

const provider = createLocalInferenceProvider();
async function prove() {
  let cases = 0;
  const acceptedIds = new Set<string>();
  // A permitted command must execute, so an unregistered FS plugin cannot make
  // all forbidden-path attempts look like successful security assertions.
  await exists("lt05-nonexistent-public-proof", {
    baseDir: BaseDirectory.AppData,
  });
  let privateFs = true;
  for (const baseDir of [BaseDirectory.AppData, BaseDirectory.AppCache]) {
    try {
      await readFile(".tesina-native/lt05-proof", { baseDir });
      privateFs = false;
    } catch (error) {
      if (!/forbidden|denied|not allowed/i.test(String(error))) {
        privateFs = false;
      }
    }
  }
  if (!privateFs) throw new Error("private-fs");
  let privateFsWriteDenials = 0;
  for (const baseDir of [BaseDirectory.AppData, BaseDirectory.AppCache]) {
    const path = `.tesina-native/lt05-write-${crypto.randomUUID()}.bin`;
    let created = false;
    let forbidden = false;
    try {
      await writeFile(path, new Uint8Array([0x4c, 0x54, 0x30, 0x35]), {
        baseDir,
        createNew: true,
      });
      created = true;
    } catch (error) {
      // Locked plugin's path-scope error, not missing parent/command or bad input.
      forbidden = /^forbidden path:/i.test(String(error));
    }
    if (created) {
      // createNew guarantees this exact random file was created by this attempt.
      await remove(path, { baseDir });
    }
    if (!forbidden) throw new Error("private-fs-write");
    privateFsWriteDenials++;
  }
  let csp = false;
  const trap = document.body.dataset.trap!;
  document.addEventListener("securitypolicyviolation", (event) => {
    if (
      event.violatedDirective === "connect-src" && event.blockedURI === trap
    ) csp = true;
  });
  try {
    await fetch(trap);
    throw new Error("direct-fetch");
  } catch { /* CSP report must independently prove the cause. */ }
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!csp) throw new Error("csp");
  const cancellationRequest: LocalInferenceRequest = {
    requestId: crypto.randomUUID(),
    documentRevision: 7,
    task: "writingCoach",
    input: {
      documentLanguage: "en",
      passage: { sourceId: "p", snapshotId: "s", text: "Fixture" },
    },
  };
  let nativeEscape = true;
  for (
    const operation of [
      () => invoke("reference_fetch", { request: { url: trap, kind: "html" } }),
      () =>
        invoke("local_inference_run", {
          request: {
            ...cancellationRequest,
            modelPath: "/private/FORBIDDEN_PROOF",
          },
        }),
    ]
  ) {
    try {
      await operation();
      nativeEscape = false;
    } catch (error) {
      if (error !== "invalid-request") nativeEscape = false;
    }
  }
  if (!nativeEscape) throw new Error("native-escape");
  let cancellations = 0;
  // Raw cancel first ensures the subsequent provider call reaches native dedup,
  // rather than being satisfied by the provider's local pre-dispatch guard.
  await invoke("local_inference_cancel", {
    requestId: cancellationRequest.requestId,
  });
  acceptedIds.add(cancellationRequest.requestId);
  const early = await provider.run(cancellationRequest);
  if (early.status !== "error" || early.error !== "cancelled") {
    throw new Error("early-cancel");
  }
  cancellations++;
  const activeRequest = {
    ...cancellationRequest,
    requestId: crypto.randomUUID(),
  };
  const pending = provider.run(activeRequest);
  await new Promise((resolve) => setTimeout(resolve, 20));
  if ((await provider.capability()).status !== "busy") {
    throw new Error("active-capability");
  }
  const concurrent = await provider.run({
    ...cancellationRequest,
    requestId: crypto.randomUUID(),
  });
  if (concurrent.status !== "error" || concurrent.error !== "busy") {
    throw new Error("concurrent-run");
  }
  await provider.cancel(activeRequest.requestId);
  const cancelled = await pending;
  if (cancelled.status !== "error" || cancelled.error !== "cancelled") {
    throw new Error("startup-cancel");
  }
  cancellations++;
  await invoke("local_inference_prepare_shutdown");
  await invoke("local_inference_resume");
  acceptedIds.add(activeRequest.requestId);
  for (const documentLanguage of ["en", "es"] as const) {
    for (
      const identity of [{ documentRevision: 7 }, {
        sourceSnapshotId: "snapshot",
      }] as const
    ) {
      for (const task of ["writingCoach", "groundedQuiz"] as const) {
        for (
          const questionCount
            of (task === "writingCoach" ? [5] : [5, 10]) as (5 | 10)[]
        ) {
          const source = {
            sourceId: "passage",
            snapshotId: "snapshot",
            text: "Árbol 🌱 e\u0301",
          };
          const correlation = { requestId: crypto.randomUUID(), ...identity };
          const request: LocalInferenceRequest = task === "writingCoach"
            ? {
              ...correlation,
              task,
              input: { documentLanguage, passage: source },
            }
            : {
              ...correlation,
              task,
              input: { documentLanguage, sources: [source], questionCount },
            };
          const result = await provider.run(request);
          if (
            result.status !== "ok" || result.task !== task ||
            result.requestId !== request.requestId
          ) throw new Error("task-result");
          if (
            "documentRevision" in identity
              ? result.documentRevision !== 7
              : result.sourceSnapshotId !== "snapshot"
          ) throw new Error("identity");
          if (result.task === "writingCoach") {
            const issues = result.output.issues;
            if (
              issues.length !== 2 || issues[0].from !== 6 ||
              issues[0].to !== 8 || issues[1].from !== 9 ||
              issues[1].to !== 11 || issues[1].explanation !== "e\u0301"
            ) throw new Error("unicode-coach");
          } else {
            if (result.output.questions.length !== questionCount) {
              throw new Error("question-count");
            }
            const first = result.output.questions[0];
            const spans = first.provenance.question;
            if (
              first.question !== "Árbol 🌱 e\u0301?" || spans.length !== 2 ||
              spans[0].from !== 6 || spans[0].to !== 8 || spans[1].from !== 9 ||
              spans[1].to !== 11 || spans.some((span) =>
                span.unit !== "utf16" || span.sourceId !== "passage" ||
                span.snapshotId !== "snapshot"
              )
            ) {
              throw new Error("unicode-quiz");
            }
          }
          await invoke("local_inference_prepare_shutdown");
          await invoke("local_inference_resume");
          acceptedIds.add(request.requestId);
          cases++;
        }
      }
    }
  }
  let denied = false;
  try {
    await invoke("plugin:http|fetch", {
      client: 1,
      options: { url: "http://127.0.0.1:1/" },
    });
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("generic-http");
  const coordinate = (action: string) =>
    invoke<void>("local_inference_proof_coordinate", { action });
  await coordinate("arm");
  const readRequest = {
    ...cancellationRequest,
    requestId: crypto.randomUUID(),
  };
  let terminals = 0;
  const terminalCount = () => terminals;
  const reading = provider.run(readRequest).then((result) => {
    terminals++;
    return result;
  });
  await coordinate("admitted");
  const foreignId = crypto.randomUUID();
  await provider.cancel(foreignId);
  acceptedIds.add(foreignId);
  if (
    terminalCount() !== 0 || (await provider.capability()).status !== "busy"
  ) {
    throw new Error("foreign-read-cancel");
  }
  const cancelAt = performance.now();
  await provider.cancel(readRequest.requestId);
  const readResult = await reading;
  if (
    readResult.status !== "error" || readResult.error !== "cancelled" ||
    readResult.requestId !== readRequest.requestId ||
    readResult.documentRevision !== 7 || readResult.task !== "writingCoach" ||
    terminalCount() !== 1
  ) throw new Error("read-cancel");
  acceptedIds.add(readRequest.requestId);
  await invoke("local_inference_prepare_shutdown");
  await coordinate("cleaned");
  if (performance.now() - cancelAt >= 5000) throw new Error("read-cleanup");
  await invoke("local_inference_resume");
  await coordinate("arm");
  const nextRequest = {
    ...cancellationRequest,
    requestId: crypto.randomUUID(),
  };
  const completing = provider.run(nextRequest);
  await coordinate("admitted");
  await coordinate("release");
  const complete = await completing;
  if (
    complete.status !== "ok" || complete.task !== "writingCoach" ||
    complete.requestId !== nextRequest.requestId ||
    complete.documentRevision !== 7 || complete.output.issues.length !== 0
  ) throw new Error("explicit-completion");
  acceptedIds.add(nextRequest.requestId);
  await provider.cancel(nextRequest.requestId);
  // Query native dedup directly: a new provider-local pre-dispatch tombstone
  // must not stand in for the native completed-record authority.
  const duplicateComplete = await invoke<{
    status: string;
    error: string;
    requestId: string;
  }>("local_inference_run", { request: nextRequest });
  if (
    duplicateComplete.status !== "error" ||
    duplicateComplete.error !== "busy" ||
    duplicateComplete.requestId !== nextRequest.requestId ||
    terminalCount() !== 1
  ) throw new Error("completed-cancel-noop");
  await invoke("local_inference_prepare_shutdown");
  await coordinate("finished");
  await invoke("local_inference_resume");
  await coordinate("arm-terminal");
  const raceRequest = {
    ...cancellationRequest,
    requestId: crypto.randomUUID(),
  };
  let raceTerminals = 0;
  const raceTerminalCount = () => raceTerminals;
  const race = provider.run(raceRequest).then((result) => {
    raceTerminals++;
    return result;
  });
  await coordinate("terminal-ready");
  if (raceTerminalCount() !== 0) throw new Error("premature-terminal");
  const raceCancelAt = performance.now();
  await provider.cancel(raceRequest.requestId);
  // Native coordination requires this exact held request to remain active with
  // its cancellation signal set before releasing the successful proxy outcome.
  await coordinate("release-cancelled-terminal");
  const raceResult = await race;
  if (
    raceResult.status !== "error" || raceResult.error !== "cancelled" ||
    raceResult.requestId !== raceRequest.requestId ||
    raceResult.documentRevision !== 7 || raceResult.task !== "writingCoach" ||
    raceTerminalCount() !== 1
  ) throw new Error("pending-cancel-wins");
  acceptedIds.add(raceRequest.requestId);
  await invoke("local_inference_prepare_shutdown");
  await coordinate("terminal-cleaned");
  if (performance.now() - raceCancelAt >= 5000) throw new Error("race-cleanup");
  await invoke("local_inference_resume");
  await invoke("local_inference_cancel", { requestId: raceRequest.requestId });
  const raceDuplicate = await invoke<{
    status: string;
    error: string;
    requestId: string;
  }>("local_inference_run", { request: raceRequest });
  if (
    raceDuplicate.status !== "error" || raceDuplicate.error !== "busy" ||
    raceDuplicate.requestId !== raceRequest.requestId ||
    raceTerminalCount() !== 1
  ) throw new Error("race-completed-noop");
  // Count only acknowledged native records, never provider-local tombstones.
  await proveUpdaterLifecycle(
    provider,
    cancellationRequest,
    coordinate,
    acceptedIds,
  );
  for (let attempt = 0; acceptedIds.size < 32 && attempt < 33; attempt++) {
    const requestId = crypto.randomUUID();
    await invoke("local_inference_cancel", { requestId });
    acceptedIds.add(requestId);
  }
  if (acceptedIds.size !== 32) throw new Error("cancellation-capacity");
  const overflowId = crypto.randomUUID();
  let overflowDenied = false;
  try {
    await invoke("local_inference_cancel", { requestId: overflowId });
  } catch (error) {
    overflowDenied = error === "busy";
  }
  if (!overflowDenied) throw new Error("cancellation-overflow");
  // At capacity, every earlier acknowledgement must still be an accepted no-op.
  for (const requestId of acceptedIds) {
    await invoke("local_inference_cancel", { requestId });
  }
  const saturated = await provider.run({
    ...cancellationRequest,
    requestId: overflowId,
  });
  if (
    saturated.status !== "error" || saturated.error !== "busy" ||
    saturated.requestId !== overflowId || saturated.task !== "writingCoach" ||
    saturated.documentRevision !== 7 ||
    (await provider.capability()).status !== "ready"
  ) throw new Error("cancellation-saturated-run");
  await invoke("local_inference_prepare_shutdown");
  await invoke("local_inference_proof_report", {
    cases,
    denied,
    privateFs,
    privateFsWriteDenials,
    csp,
    cancellations,
    nativeEscape,
    cancellationTableEntries: acceptedIds.size,
    cancellationTableSaturated: true,
    readCancellation: true,
    completionOrdering: true,
    freshGeneration: true,
    pendingCancelWins: true,
    updaterLifecycle: true,
    passed: true,
  });
}
prove().catch(async () => {
  await invoke("local_inference_prepare_shutdown").catch(() => {});
  await invoke("local_inference_proof_report", {
    cases: 0,
    denied: false,
    privateFs: false,
    privateFsWriteDenials: 0,
    csp: false,
    cancellations: 0,
    nativeEscape: false,
    cancellationTableEntries: 0,
    cancellationTableSaturated: false,
    readCancellation: false,
    completionOrdering: false,
    freshGeneration: false,
    pendingCancelWins: false,
    updaterLifecycle: false,
    passed: false,
  });
});
