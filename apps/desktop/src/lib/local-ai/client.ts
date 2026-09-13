import { invoke } from "@tauri-apps/api/core";
import type {
  LocalInferenceCapability,
  LocalInferenceError,
  LocalInferenceProvider,
  LocalInferenceRequest,
  LocalInferenceTaskMap,
  ResultFor,
} from "./types.ts";
import { validResult } from "./validation.ts";

function failure<K extends keyof LocalInferenceTaskMap>(
  request: Extract<LocalInferenceRequest, { task: K }>,
  error: LocalInferenceError,
): ResultFor<K> {
  const identity = request.documentRevision === undefined
    ? { sourceSnapshotId: request.sourceSnapshotId }
    : { documentRevision: request.documentRevision };
  // The discriminator and its correlation are copied from the accepted call.
  return {
    ...identity,
    requestId: request.requestId,
    task: request.task,
    status: "error",
    error,
  } as ResultFor<K>;
}

/** The only injected boundary is native IPC; no endpoint or path is accepted. */
export function createLocalInferenceProvider(
  nativeInvoke: typeof invoke = invoke,
): LocalInferenceProvider {
  const cancelled = new Set<string>();
  const pendingCancel = new Map<
    string,
    { acknowledgement: Promise<void>; consumed: boolean }
  >();
  return {
    async capability() {
      let value: LocalInferenceCapability;
      try {
        value = await nativeInvoke<LocalInferenceCapability>(
          "local_inference_capability",
        );
      } catch {
        throw new Error("invalid-response");
      }
      if (
        !value || value.version !== 1 ||
        (value.status === "unavailable"
          ? Object.keys(value).length !== 3 ||
            ![
              "unsupported-platform",
              "unsupported-hardware",
              "sidecar-absent",
              "not-installed",
            ].includes(value.reason)
          : Object.keys(value).length !== 2 ||
            !["ready", "busy"].includes(value.status))
      ) throw new Error("invalid-response");
      return value;
    },
    async run(request) {
      const accepted = structuredClone(request);
      try {
        await pendingCancel.get(accepted.requestId)?.acknowledgement.catch(
          () => {},
        );
        if (cancelled.delete(accepted.requestId)) {
          return failure(accepted, "cancelled");
        }
        const result = await nativeInvoke<unknown>("local_inference_run", {
          request: accepted,
        });
        // After dispatch the native owner alone decides cancellation vs completion.
        return validResult(result, accepted)
          ? result as ResultFor<typeof request.task>
          : failure(accepted, "invalid-response");
      } catch {
        return failure(accepted, "invalid-request");
      } finally {
        cancelled.delete(accepted.requestId);
        const pending = pendingCancel.get(accepted.requestId);
        if (pending) pending.consumed = true;
      }
    },
    async cancel(requestId) {
      if (cancelled.has(requestId)) return;
      const pending = pendingCancel.get(requestId);
      if (pending) return await pending.acknowledgement;
      if (cancelled.size + pendingCancel.size >= 32) throw new Error("busy");
      const record = { acknowledgement: Promise.resolve(), consumed: false };
      record.acknowledgement = nativeInvoke("local_inference_cancel", {
        requestId,
      })
        .then(() => {
          if (!record.consumed) cancelled.add(requestId);
        })
        .catch(() => {
          throw new Error("busy");
        })
        .finally(() => {
          pendingCancel.delete(requestId);
        });
      pendingCancel.set(requestId, record);
      return await record.acknowledgement;
    },
  };
}
