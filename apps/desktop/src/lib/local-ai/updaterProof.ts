import { UpdaterStore } from "../state/updater.svelte.ts";
import { operations } from "../persist/operationCoordinator.ts";
import {
  prepareLocalInferenceShutdown,
  resumeLocalInference,
} from "./lifecycle.ts";
import { createLocalInferenceProvider } from "./client.ts";
import type { LocalInferenceRequest } from "./types.ts";

export async function proveUpdaterLifecycle(
  provider: ReturnType<typeof createLocalInferenceProvider>,
  template: LocalInferenceRequest,
  coordinate: (action: string) => Promise<void>,
  acceptedIds: Set<string>,
) {
  const host = document.body.dataset.host;
  if (host !== "macos" && host !== "windows") throw new Error("proof-host");
  for (const fail of [false, true]) {
    await coordinate("arm");
    const request = { ...template, requestId: crypto.randomUUID() };
    const pending = provider.run(request);
    await coordinate("admitted");
    let flushed = false;
    let terminal = false;
    let resumed = false;
    const terminalAction = async () => {
      const result = await pending;
      if (
        !flushed || result.status !== "error" || result.error !== "cancelled" ||
        result.requestId !== request.requestId ||
        result.documentRevision !== 7 ||
        result.task !== "writingCoach"
      ) throw new Error("updater-correlation");
      acceptedIds.add(request.requestId);
      await coordinate("cleaned");
      terminal = true;
      if (fail) throw "proof-update-failure";
    };
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.0.0-proof",
          download: async () => {},
          install: terminalAction,
          downloadAndInstall: async () => {},
        }),
      flushPending: () => {
        flushed = true;
        return Promise.resolve();
      },
      prepareInferenceShutdown: prepareLocalInferenceShutdown,
      relaunch: terminalAction,
      resumeAfterFailedShutdown: async () => {
        await operations.resumeAfterFailedShutdown();
        await resumeLocalInference();
        resumed = true;
      },
      storage: () => null,
      hostOs: () => Promise.resolve(host),
    });
    await store.check();
    const start = performance.now();
    await store.install();
    if (
      !terminal || performance.now() - start >= 5000 ||
      store.status !== (fail ? "error" : "idle") || resumed !== fail
    ) {
      throw new Error("updater-terminal");
    }
    if (!fail) await resumeLocalInference();
  }
  // Native coordinator compares both the new owned PID and private key digest.
  await coordinate("arm");
  const request = { ...template, requestId: crypto.randomUUID() };
  const pending = provider.run(request);
  await coordinate("admitted");
  await coordinate("release");
  const result = await pending;
  if (
    result.status !== "ok" || result.requestId !== request.requestId ||
    result.documentRevision !== 7 || result.task !== "writingCoach"
  ) throw new Error("updater-resume");
  acceptedIds.add(request.requestId);
  await prepareLocalInferenceShutdown();
  await coordinate("finished");
  await resumeLocalInference();
}
