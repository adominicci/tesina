import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
import {
  exitAfterInferenceShutdown,
  resumeLocalInference,
} from "./lifecycle.ts";

it("prepares native cleanup before every actual exit, including quit without saving", async () => {
  const events: string[] = [];
  native.mockImplementation((command) => {
    events.push(command);
    return Promise.resolve();
  });
  await exitAfterInferenceShutdown(() => {
    events.push("exit");
    return Promise.resolve();
  });
  expect(events).toEqual(["local_inference_prepare_shutdown", "exit"]);
});
it("does not cross the explicit exit boundary if native cleanup fails", async () => {
  native.mockRejectedValueOnce("private native data");
  const exit = vi.fn();
  await expect(exitAfterInferenceShutdown(exit)).rejects.toThrow(
    "local-inference-shutdown-failed",
  );
  expect(exit).not.toHaveBeenCalled();
  native.mockResolvedValueOnce(undefined);
  await resumeLocalInference();
  expect(native).toHaveBeenLastCalledWith("local_inference_resume");
});
