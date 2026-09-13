import { invoke } from "@tauri-apps/api/core";

export async function prepareLocalInferenceShutdown(): Promise<void> {
  try {
    await invoke("local_inference_prepare_shutdown");
  } catch {
    throw new Error("local-inference-shutdown-failed");
  }
}
export async function resumeLocalInference(): Promise<void> {
  try {
    await invoke("local_inference_resume");
  } catch {
    throw new Error("local-inference-resume-failed");
  }
}
/** Used at the actual exit boundary, including an explicitly unsaved quit. */
export async function exitAfterInferenceShutdown(
  exit: () => Promise<void>,
): Promise<void> {
  await prepareLocalInferenceShutdown();
  await exit();
}
