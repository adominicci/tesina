import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const proofDir = dirname(fileURLToPath(import.meta.url));
const source = await readFile(
  resolve(proofDir, "nativeManualProof.ts"),
  "utf8",
);
const runner = await readFile(
  resolve(proofDir, "runNativeManualProof.ts"),
  "utf8",
);
const automatedRunner = await readFile(
  resolve(proofDir, "runNativeProof.ts"),
  "utf8",
);
const nativeHost = await readFile(
  resolve(proofDir, "../../../../../src-tauri/examples/webview2-proof-host.rs"),
  "utf8",
);
const nativeInputDriver = await readFile(
  resolve(
    proofDir,
    "../../../../../src-tauri/examples/support/windows-native-input.rs",
  ),
  "utf8",
).catch(() => "");
const cargoManifest = await readFile(
  resolve(proofDir, "../../../../../src-tauri/Cargo.toml"),
  "utf8",
);

describe("visible native manual-proof contract", () => {
  it("waits for native selection collapse before the separate paste chord", () => {
    expect(source).toContain(
      'editor.on("selectionUpdate", inspectDrivenCollapse)',
    );
    expect(source).toContain("selection.from !== evidence.selectionTo");
    expect(source).toContain(
      "JSON.stringify(editor.getJSON()) !== copiedDocumentJson",
    );
    expect(source).toContain('stage: "collapsed"');
    const pasteSender = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn send_paste("),
      nativeInputDriver.indexOf("fn activate_composition_layout("),
    );
    expect(pasteSender).not.toContain("VK_RIGHT");
    expect(pasteSender).toContain("VK_V");
    expect(source).toContain("Native input acknowledgement failed:");
  });

  it("keeps serde JSON values and macros in the Windows host module scope", () => {
    const windowsHostModule = nativeHost.slice(
      nativeHost.indexOf("mod windows_host {"),
      nativeHost.indexOf("fn main()", nativeHost.indexOf("mod windows_host {")),
    );
    expect(windowsHostModule).toContain("use serde_json::{json, Value};");
  });

  it("records native composition diagnostics plus trusted outcome, undo, clipboard, and drag paths", () => {
    expect(source).toContain('addEventListener("compositionstart"');
    expect(source).toContain('addEventListener("compositionend"');
    expect(source).toContain('addEventListener("copy"');
    expect(source).toContain('addEventListener("paste"');
    expect(source).not.toContain('addEventListener("keyup"');
    expect(source).toContain('addEventListener("mousedown"');
    expect(source).toContain('addEventListener("mouseup"');
    expect(source).toContain('event.key === "Dead"');
    expect(source).toContain("event.ctrlKey");
    expect(source).toContain(
      "evidence.rightKeys <= evidence.pasteRightKeys",
    );
    expect(source).toContain("!editor.isFocused");
    expect(source).toContain(
      "JSON.stringify(editor.getJSON()) !== pasteDocumentJson",
    );
    expect(source).toContain('kind: "caret-outcome"');
    expect(source).toContain('kind: "dead-key-outcome"');
    expect(source).toContain('kind: "undo-outcome"');
    expect(source).toContain("JSON.stringify(editor.getJSON())");
    expect(source).toContain(
      'editor.on("transaction", inspectDrivenTransaction)',
    );
    expect(source).toContain(
      'editor.on("selectionUpdate", inspectDrivenCaret)',
    );
    expect(source).toContain('insertedText === "é"');
    expect(source).toContain("selectionRestored");
    expect(source).toContain('stage: "dead-key"');
    expect(source).toContain('stage: "caret"');
    expect(source).toContain('stage: "dead-keydown"');
    expect(source).toContain('stage: "undo"');
    expect(source).toContain("deadKeyAckStage: deadKeyAcknowledgementPosted");
    const deadKeyDownHandler = source.slice(
      source.indexOf('addEventListener("keydown"'),
      source.indexOf('addEventListener("compositionstart"'),
    );
    expect(deadKeyDownHandler).toContain('event.key === "Dead"');
    expect(deadKeyDownHandler).not.toContain('event.code === "Quote"');
    expect(source).toContain("deadKeyCode: evidence.deadKeyCode");
    expect(deadKeyDownHandler).toContain("deadKeyAcknowledgementPosted");
    expect(deadKeyDownHandler).toContain('stage: "dead-keydown"');
    expect(deadKeyDownHandler).not.toContain('addEventListener("keyup"');
    const compositionEndHandler = source.slice(
      source.indexOf('addEventListener("compositionend"'),
      source.indexOf('addEventListener("copy"'),
    );
    expect(compositionEndHandler).not.toContain("postNativeInput");
    expect(compositionEndHandler).not.toContain("finish(");
    expect(source).toContain("event.isTrusted");
    expect(source).toContain("postNativeInput");
    expect(source).not.toMatch(
      /dispatchEvent|new\s+(?:Input|Composition|Clipboard|Mouse)Event/,
    );
  });

  it("uses only the audited Win32 OS paths for driven Windows evidence", () => {
    expect(nativeHost).toContain("windows_native_input");
    expect(nativeInputDriver).toContain("SendInput");
    expect(nativeInputDriver).toContain("OpenClipboard");
    expect(nativeInputDriver).toContain("GetClipboardData");
    expect(nativeInputDriver).toContain("CloseClipboard");
    expect(nativeInputDriver).toContain("LoadKeyboardLayoutW");
    expect(nativeInputDriver).toContain("ToUnicodeEx");
    expect(nativeInputDriver).toContain("00020409");
    expect(nativeInputDriver).toContain("DriverAction::MoveCaret =>");
    expect(nativeInputDriver).toContain("DriverAction::ComposeCharacter =>");
    expect(nativeInputDriver).toContain("DriverAction::Undo =>");
    expect(nativeInputDriver).toContain(
      'self.send_control_chord(VK_Z, "undo")',
    );
    const moveCaretBranch = nativeInputDriver.slice(
      nativeInputDriver.indexOf("DriverAction::MoveCaret =>"),
      nativeInputDriver.indexOf("DriverAction::DeadKey =>"),
    );
    expect(moveCaretBranch.indexOf("self.require_focus()?")).toBeLessThan(
      moveCaretBranch.indexOf("self.activate_composition_layout()?"),
    );
    expect(
      moveCaretBranch.indexOf("self.activate_composition_layout()?"),
    ).toBeLessThan(
      moveCaretBranch.indexOf("self.send_right_arrow()?"),
    );
    const deadKeyBranch = nativeInputDriver.slice(
      nativeInputDriver.indexOf("DriverAction::DeadKey =>"),
      nativeInputDriver.indexOf("DriverAction::ComposeCharacter =>"),
    );
    expect(deadKeyBranch.indexOf("self.require_focus()?")).toBeLessThan(
      deadKeyBranch.indexOf("self.send_dead_key_press()?"),
    );
    expect(deadKeyBranch).not.toContain("activate_composition_layout");
    expect(nativeInputDriver).toMatch(
      /fn send_right_arrow[\s\S]*\(VK_RIGHT, false\)[\s\S]*\(VK_RIGHT, true\)/,
    );
    const deadKeyPress = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn send_dead_key_press"),
      nativeInputDriver.indexOf("fn send_composition_character"),
    );
    expect(deadKeyPress.indexOf("dead_key_pending = true")).toBeLessThan(
      deadKeyPress.indexOf("self.send_key_sequence"),
    );
    expect(deadKeyPress).toContain("(VK_OEM_7, false)");
    expect(deadKeyPress).not.toContain("VK_E");
    const compositionCharacter = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn send_composition_character"),
      nativeInputDriver.indexOf("fn perform_cleanup_action"),
    );
    expect(compositionCharacter).toContain("(VK_E, false)");
    expect(compositionCharacter).not.toContain("VK_OEM_7");
    expect(compositionCharacter).not.toContain("VK_RIGHT");
    const undoBranch = nativeInputDriver.slice(
      nativeInputDriver.indexOf("DriverAction::Undo =>"),
      nativeInputDriver.indexOf("DriverAction::Complete =>"),
    );
    expect(undoBranch.indexOf("dead_key_pending = false")).toBeLessThan(
      undoBranch.indexOf("self.send_control_chord"),
    );
    expect(`${nativeHost}\n${nativeInputDriver}`).not.toMatch(
      /execute_script|dispatchEvent/,
    );
    expect(cargoManifest).toContain('windows-sys = { version = "=0.61.2"');
  });

  it("drains the native event loop before injecting input and settling its queued result", () => {
    expect(nativeHost).toContain("struct PendingNativeInput<T>");
    expect(nativeHost).toContain(
      "let mut pending_native_input = PendingNativeInput::<Value>::default()",
    );
    const nativeInputMessage = nativeHost.slice(
      nativeHost.indexOf('Some("native-input") =>'),
      nativeHost.indexOf('Some("result") =>'),
    );
    expect(nativeInputMessage).toContain(
      'pending_native_input.queue(envelope["payload"].clone())',
    );
    expect(nativeInputMessage).not.toContain("driver.advance");

    const resultMessage = nativeHost.slice(
      nativeHost.indexOf('Some("result") =>'),
      nativeHost.indexOf("Event::MainEventsCleared =>"),
    );
    expect(resultMessage).toMatch(
      /pending_native_input\s*\.queue_result\(envelope\["payload"\]\.clone\(\)\)/,
    );
    expect(resultMessage).not.toContain("driver.advance");

    const drainedEvents = nativeHost.slice(
      nativeHost.indexOf("Event::MainEventsCleared =>"),
      nativeHost.indexOf("Event::UserEvent(HostEvent::Deadline) =>"),
    );
    expect(drainedEvents).toContain("pending_native_input.take()");
    expect(drainedEvents).toContain("driver.advance(&payload)");
    expect(drainedEvents).toContain(
      "pending_native_input.take_result_if_drained()",
    );
    expect(drainedEvents.indexOf("driver.advance(&payload)")).toBeLessThan(
      drainedEvents.indexOf("pending_native_input.take_result_if_drained()"),
    );
    expect(
      drainedEvents.indexOf("pending_native_input.take_result_if_drained()"),
    ).toBeLessThan(drainedEvents.indexOf("settle_result("));
    expect(drainedEvents).not.toMatch(/sleep|dispatchEvent|execute_script/);

    const resultSettlement = nativeHost.slice(
      nativeHost.indexOf("fn settle_result("),
      nativeHost.indexOf("pub fn run()"),
    );
    expect(resultSettlement).toContain("if !driver.is_complete()");
    expect(resultSettlement).toContain(
      "settle_incomplete_result(control_flow, input_driver, result)",
    );
    expect(nativeHost).toContain("incomplete_driver_result_error(&result)");
    expect(nativeHost).toContain('"pageResult": result');
    const driverCompletionGuard = resultSettlement.slice(
      resultSettlement.indexOf("if let Some(driver)"),
      resultSettlement.indexOf("if let Err(error) = driver.cleanup()"),
    );
    expect(driverCompletionGuard).not.toContain('result["passed"]');
  });

  it("wires the shared fail-closed cleanup executor into the native driver", () => {
    expect(nativeInputDriver).toContain("snapshot_clipboard");
    expect(nativeInputDriver).toContain("restore_clipboard_snapshot");
    expect(nativeInputDriver).not.toContain(
      "read_clipboard_text(self.hwnd).ok()",
    );
    expect(nativeInputDriver).toContain(
      "execute_cleanup(&mut self.cleanup_state",
    );
    expect(nativeInputDriver).toContain(
      "perform_cleanup_action(hwnd, action, state)",
    );
    expect(nativeInputDriver).toContain("CleanupAction::RestoreCursor =>");
    expect(nativeInputDriver).toContain("CleanupAction::RestoreClipboard =>");
    expect(nativeInputDriver).toContain("CleanupAction::ClearDeadKeyState =>");
    expect(nativeInputDriver).toContain("clear_dead_key_state(layout.target)");
    const deadKeyCleanup = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn clear_dead_key_state"),
      nativeInputDriver.indexOf("fn virtual_desktop"),
    );
    expect(deadKeyCleanup).toContain("MAPVK_VK_TO_VSC");
    expect(deadKeyCleanup).toContain("VK_SPACE as u32");
    expect(deadKeyCleanup).toContain("count == 1");
    expect(deadKeyCleanup).toMatch(/translated\.len\(\) as i32,\s+0,\s+layout/);
    expect(nativeInputDriver).toContain(
      "restore_clipboard_snapshot(hwnd, clipboard)",
    );
    const layoutMethod = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn activate_composition_layout"),
      nativeInputDriver.indexOf("fn send_dead_key_press"),
    );
    expect(
      layoutMethod.indexOf("self.cleanup_state.layout = Some"),
    ).toBeGreaterThan(-1);
    expect(
      layoutMethod.indexOf("self.cleanup_state.layout = Some"),
    ).toBeLessThan(layoutMethod.indexOf("LoadKeyboardLayoutW"));
  });

  it("waits conditionally for the exact Win32 clipboard commit before paste", () => {
    const pasteBranch = nativeInputDriver.slice(
      nativeInputDriver.indexOf("DriverAction::Paste =>"),
      nativeInputDriver.indexOf("DriverAction::MoveCaret =>"),
    );
    expect(pasteBranch).toContain("wait_for_exact_clipboard_text");
    expect(pasteBranch).not.toContain("read_clipboard_text");

    const readiness = nativeInputDriver.slice(
      nativeInputDriver.indexOf("fn wait_for_exact_clipboard_text"),
      nativeInputDriver.indexOf("fn restore_clipboard_snapshot"),
    );
    expect(readiness).toContain("CLIPBOARD_READINESS_TIMEOUT");
    expect(readiness).toContain("CLIPBOARD_POLL_INTERVAL");
    expect(readiness).toContain("Instant::now()");
    expect(readiness).toContain("thread::sleep");
    expect(readiness).toContain("poll_exact_clipboard_text");
    expect(readiness.indexOf("read_clipboard_text")).toBeLessThan(
      readiness.indexOf("thread::sleep"),
    );
    expect(readiness).not.toMatch(/execute_script|dispatchEvent/);
    expect(nativeInputDriver).toContain("lastMismatchUtf16");
    expect(nativeInputDriver).toContain("lastError");
  });

  it("uses the same direct platform host and bounded cleanup lifecycle", () => {
    expect(runner).toContain("nativeHostCommand(process.platform");
    expect(runner).toContain("executeBoundedProcess");
    expect(runner).toContain("runProofLifecycle");
    expect(runner).toContain("cleanupProofRun");
    expect(runner).not.toMatch(/playwright|chromium/i);
  });

  it("preserves the distinct native-host timeout exit code after cleanup", () => {
    expect(nativeHost).toMatch(
      /settle_failure\(\s*control_flow,\s*&mut input_driver,\s*124,\s*"WebView2 proof timed out"/,
    );
  });

  it("settles driven input before the outer force-kill can bypass cleanup", () => {
    expect(source).toContain(
      'evidenceMode === "windows-driven" ? 40_000 : 240_000',
    );
    expect(nativeHost).toMatch(
      /host_deadline = if drive_native_input\s*\{\s*AUTOMATED_HOST_DEADLINE/,
    );
    expect(nativeHost).toContain(
      "const AUTOMATED_HOST_DEADLINE: Duration = Duration::from_secs(45)",
    );
    expect(automatedRunner).toContain("outerNativeHostProcess");
  });
});
