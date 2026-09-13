use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct InputPoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReadyGeometry {
    pub(crate) viewport_width: f64,
    pub(crate) viewport_height: f64,
    pub(crate) device_pixel_ratio: f64,
    pub(crate) gap_top: f64,
    pub(crate) gap_bottom: f64,
    pub(crate) drag_start: InputPoint,
    pub(crate) drag_end: InputPoint,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DriverAction {
    Drag(ReadyGeometry),
    Copy,
    CollapseSelection,
    Paste,
    MoveCaret,
    DeadKey,
    ComposeCharacter,
    Undo,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DriverStage {
    AwaitingReady,
    AwaitingDrag,
    AwaitingCopy,
    AwaitingCollapse,
    AwaitingPaste,
    AwaitingCaret,
    AwaitingDeadKeyAcknowledgement,
    AwaitingDeadKeyOutcome,
    AwaitingUndo,
    Complete,
}

#[derive(Debug)]
pub(crate) struct DriverProtocol {
    stage: DriverStage,
    selected_text: Option<String>,
    document_size: Option<u64>,
    selection_position: Option<u64>,
}

impl DriverProtocol {
    pub(crate) fn new() -> Self {
        Self {
            stage: DriverStage::AwaitingReady,
            selected_text: None,
            document_size: None,
            selection_position: None,
        }
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.stage == DriverStage::Complete
    }

    pub(crate) fn selected_text(&self) -> Option<&str> {
        self.selected_text.as_deref()
    }

    pub(crate) fn advance(&mut self, value: &Value) -> Result<DriverAction, String> {
        let message = value
            .as_object()
            .ok_or_else(|| "native input payload must be an object".to_string())?;
        if message.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("native input protocol version must be 1".into());
        }
        let stage = message
            .get("stage")
            .and_then(Value::as_str)
            .ok_or_else(|| "native input payload is missing stage".to_string())?;
        match (self.stage, stage) {
            (DriverStage::AwaitingReady, "ready") => {
                let viewport = object_field(value, "viewport")?;
                let viewport_width = positive_number(viewport, "width", "viewport.width")?;
                let viewport_height = positive_number(viewport, "height", "viewport.height")?;
                let device_pixel_ratio =
                    positive_number(value, "devicePixelRatio", "devicePixelRatio")?;
                let gap = object_field(value, "gap")?;
                let gap_top = finite_number(gap, "top", "gap.top")?;
                let gap_bottom = finite_number(gap, "bottom", "gap.bottom")?;
                if gap_top < 0.0 || gap_bottom <= gap_top || gap_bottom >= viewport_height {
                    return Err("gap must be ordered inside the viewport".into());
                }
                let drag_start = point_field(value, "dragStart")?;
                let drag_end = point_field(value, "dragEnd")?;
                for (label, point) in [("dragStart", drag_start), ("dragEnd", drag_end)] {
                    if point.x < 0.0
                        || point.x >= viewport_width
                        || point.y < 0.0
                        || point.y >= viewport_height
                    {
                        return Err(format!("{label} must be inside the viewport"));
                    }
                }
                if drag_start.y >= gap_top || drag_end.y <= gap_bottom {
                    return Err("drag points must straddle the gap".into());
                }
                self.stage = DriverStage::AwaitingDrag;
                Ok(DriverAction::Drag(ReadyGeometry {
                    viewport_width,
                    viewport_height,
                    device_pixel_ratio,
                    gap_top,
                    gap_bottom,
                    drag_start,
                    drag_end,
                }))
            }
            (DriverStage::AwaitingDrag, "drag") => {
                let selection_from = document_position(value, "selectionFrom")?;
                let selection_to = document_position(value, "selectionTo")?;
                let gap_position = document_position(value, "gapPosition")?;
                if !(selection_from < gap_position && gap_position < selection_to) {
                    return Err("selection must cross the pagination gap".into());
                }
                let selected_text = nonempty_text(value, "selectedText")?.to_owned();
                self.selected_text = Some(selected_text);
                self.selection_position = Some(selection_to);
                self.stage = DriverStage::AwaitingCopy;
                Ok(DriverAction::Copy)
            }
            (DriverStage::AwaitingCopy, "copy") => {
                let selected_text = nonempty_text(value, "selectedText")?;
                if self.selected_text() != Some(selected_text) {
                    return Err("copied text does not match the drag selection".into());
                }
                self.document_size = Some(document_position(value, "documentSize")?);
                self.stage = DriverStage::AwaitingCollapse;
                Ok(DriverAction::CollapseSelection)
            }
            (DriverStage::AwaitingCollapse, "collapsed") => {
                let document_size = document_position(value, "documentSize")?;
                let selection_position = document_position(value, "selectionPos")?;
                if self.document_size != Some(document_size)
                    || self.selection_position != Some(selection_position)
                {
                    return Err(
                        "copied selection did not collapse at its end in the unchanged document"
                            .into(),
                    );
                }
                self.stage = DriverStage::AwaitingPaste;
                Ok(DriverAction::Paste)
            }
            (DriverStage::AwaitingPaste, "paste") => {
                let pasted_text = nonempty_text(value, "pastedText")?;
                if self.selected_text() != Some(pasted_text) {
                    return Err("pasted text does not match the copied selection".into());
                }
                let before = document_position(value, "beforeSize")?;
                let after = document_position(value, "afterSize")?;
                let selection_position = document_position(value, "selectionPos")?;
                if self.document_size != Some(before)
                    || after.saturating_sub(before) != pasted_text.encode_utf16().count() as u64
                    || selection_position > after
                {
                    return Err("paste did not add the exact clipboard text".into());
                }
                self.document_size = Some(after);
                self.selection_position = Some(selection_position);
                self.stage = DriverStage::AwaitingCaret;
                Ok(DriverAction::MoveCaret)
            }
            (DriverStage::AwaitingCaret, "caret") => {
                let document_size = document_position(value, "documentSize")?;
                let before = document_position(value, "beforePos")?;
                let after = document_position(value, "afterPos")?;
                if self.document_size != Some(document_size)
                    || self.selection_position != Some(before)
                    || before.checked_add(1) != Some(after)
                    || after > document_size
                {
                    return Err(
                        "caret did not advance exactly one position in the unchanged document"
                            .into(),
                    );
                }
                self.selection_position = Some(after);
                self.stage = DriverStage::AwaitingDeadKeyAcknowledgement;
                Ok(DriverAction::DeadKey)
            }
            (DriverStage::AwaitingDeadKeyAcknowledgement, "dead-keydown") => {
                let document_size = document_position(value, "documentSize")?;
                let insertion_pos = document_position(value, "insertionPos")?;
                if self.document_size != Some(document_size)
                    || self.selection_position != Some(insertion_pos)
                {
                    return Err(
                        "trusted dead key changed the document or acknowledged caret".into(),
                    );
                }
                self.stage = DriverStage::AwaitingDeadKeyOutcome;
                Ok(DriverAction::ComposeCharacter)
            }
            (DriverStage::AwaitingDeadKeyOutcome, "dead-key") => {
                if nonempty_text(value, "data")? != "é" {
                    return Err("dead-key data must be the audited NFC character".into());
                }
                let before = document_position(value, "beforeSize")?;
                let after = document_position(value, "afterSize")?;
                let insertion_pos = document_position(value, "insertionPos")?;
                if self.document_size != Some(before)
                    || before.checked_add(1) != Some(after)
                    || self.selection_position != Some(insertion_pos)
                {
                    return Err("dead-key input did not add exactly one authored character".into());
                }
                self.stage = DriverStage::AwaitingUndo;
                Ok(DriverAction::Undo)
            }
            (DriverStage::AwaitingUndo, "undo") => {
                let document_size = document_position(value, "documentSize")?;
                if self.document_size != Some(document_size)
                    || value.get("documentRestored").and_then(Value::as_bool) != Some(true)
                    || value.get("selectionRestored").and_then(Value::as_bool) != Some(true)
                {
                    return Err(
                        "native undo did not restore exact document and selection identity".into(),
                    );
                }
                self.stage = DriverStage::Complete;
                Ok(DriverAction::Complete)
            }
            _ => Err(format!(
                "unexpected native input stage {stage} while {:?}",
                self.stage
            )),
        }
    }
}

fn object_field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, String> {
    value
        .get(name)
        .filter(|field| field.is_object())
        .ok_or_else(|| format!("{name} must be an object"))
}

fn finite_number(value: &Value, name: &str, label: &str) -> Result<f64, String> {
    let parsed = value
        .get(name)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{label} must be finite"))?;
    Ok(parsed)
}

fn positive_number(value: &Value, name: &str, label: &str) -> Result<f64, String> {
    let parsed = finite_number(value, name, label)?;
    if parsed <= 0.0 {
        return Err(format!("{label} must be positive"));
    }
    Ok(parsed)
}

fn point_field(value: &Value, name: &str) -> Result<InputPoint, String> {
    let point = object_field(value, name)?;
    Ok(InputPoint {
        x: finite_number(point, "x", &format!("{name}.x"))?,
        y: finite_number(point, "y", &format!("{name}.y"))?,
    })
}

fn document_position(value: &Value, name: &str) -> Result<u64, String> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{name} must be a non-negative integer"))
}

fn nonempty_text<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{name} must be nonempty"))
}

pub(crate) fn normalize_absolute_coordinate(point: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    let relative = i64::from(point.saturating_sub(origin)).clamp(0, i64::from(extent - 1));
    ((relative * 65_535 + i64::from((extent - 1) / 2)) / i64::from(extent - 1)) as i32
}

pub(crate) fn require_complete_input(
    expected: u32,
    actual: u32,
    label: &str,
) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{label} SendInput accepted {actual} of {expected} records"
        ))
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ClipboardReadinessDiagnostics {
    attempts: usize,
    empty_reads: usize,
    mismatch_reads: usize,
    error_reads: usize,
    last_mismatch_utf16: Option<usize>,
    last_error: Option<String>,
}

impl ClipboardReadinessDiagnostics {
    fn summary(&self) -> String {
        format!(
            "attempts={}, empty={}, mismatches={}, errors={}, lastMismatchUtf16={}, lastError={}",
            self.attempts,
            self.empty_reads,
            self.mismatch_reads,
            self.error_reads,
            self.last_mismatch_utf16
                .map_or_else(|| "none".to_string(), |length| length.to_string()),
            self.last_error.as_deref().unwrap_or("none"),
        )
    }
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

pub(crate) fn poll_exact_clipboard_text(
    expected: &str,
    timeout_ms: u64,
    poll_interval_ms: u64,
    mut read: impl FnMut() -> Result<String, String>,
    mut now_ms: impl FnMut() -> u64,
    mut wait: impl FnMut(u64),
) -> Result<ClipboardReadinessDiagnostics, String> {
    let expected = normalize_newlines(expected);
    let mut diagnostics = ClipboardReadinessDiagnostics::default();
    let started_ms = now_ms();
    loop {
        let elapsed_ms = now_ms().saturating_sub(started_ms);
        if diagnostics.attempts > 0 && elapsed_ms >= timeout_ms {
            return Err(format!(
                "Win32 clipboard did not reach the exact copied selection within {timeout_ms} ms ({})",
                diagnostics.summary(),
            ));
        }
        diagnostics.attempts += 1;
        let exact = match read() {
            Ok(observed) => {
                let observed = normalize_newlines(&observed);
                if observed == expected {
                    true
                } else {
                    if observed.is_empty() {
                        diagnostics.empty_reads += 1;
                    } else {
                        diagnostics.mismatch_reads += 1;
                        diagnostics.last_mismatch_utf16 = Some(observed.encode_utf16().count());
                    }
                    false
                }
            }
            Err(error) => {
                diagnostics.error_reads += 1;
                diagnostics.last_error = Some(error);
                false
            }
        };
        let elapsed_ms = now_ms().saturating_sub(started_ms);
        if exact && elapsed_ms <= timeout_ms {
            return Ok(diagnostics);
        }
        if elapsed_ms >= timeout_ms {
            return Err(format!(
                "Win32 clipboard did not reach the exact copied selection within {timeout_ms} ms ({})",
                diagnostics.summary(),
            ));
        }
        wait(poll_interval_ms.min(timeout_ms - elapsed_ms));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClipboardSnapshotKind {
    Empty,
}

pub(crate) fn classify_clipboard_snapshot(
    format_count: i32,
) -> Result<ClipboardSnapshotKind, String> {
    match format_count {
        0 => Ok(ClipboardSnapshotKind::Empty),
        count if count > 0 => Err(
            "Win32 clipboard must be empty before native input proof so every format can be restored exactly"
                .into(),
        ),
        _ => Err("CountClipboardFormats returned an invalid result".into()),
    }
}

pub(crate) fn pending_key_releases(events: &[(u16, bool)], accepted: u32) -> Vec<u16> {
    let mut pending = Vec::new();
    for (key, key_up) in events.iter().take(accepted as usize) {
        if *key_up {
            pending.retain(|pending_key| pending_key != key);
        } else if !pending.contains(key) {
            pending.push(*key);
        }
    }
    pending
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CleanupAction {
    MouseUp,
    KeyUp(u16),
    ClearDeadKeyState,
    RestoreKeyboardLayout,
    RestoreCursor,
    RestoreClipboard,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CleanupState<L, C, B> {
    mouse_down: bool,
    pending_key_releases: Vec<u16>,
    dead_key_pending: bool,
    layout: Option<L>,
    cursor: Option<C>,
    clipboard: Option<B>,
}

impl<L, C, B> Default for CleanupState<L, C, B> {
    fn default() -> Self {
        Self {
            mouse_down: false,
            pending_key_releases: Vec::new(),
            dead_key_pending: false,
            layout: None,
            cursor: None,
            clipboard: None,
        }
    }
}

impl<L, C, B> CleanupState<L, C, B> {
    pub(crate) fn is_clean(&self) -> bool {
        cleanup_actions(self).is_empty()
    }

    fn mark_succeeded(&mut self, action: CleanupAction) {
        match action {
            CleanupAction::MouseUp => self.mouse_down = false,
            CleanupAction::KeyUp(key) => {
                self.pending_key_releases
                    .retain(|pending_key| *pending_key != key);
            }
            CleanupAction::ClearDeadKeyState => self.dead_key_pending = false,
            CleanupAction::RestoreKeyboardLayout => self.layout = None,
            CleanupAction::RestoreCursor => self.cursor = None,
            CleanupAction::RestoreClipboard => self.clipboard = None,
        }
    }
}

pub(crate) fn cleanup_actions<L, C, B>(state: &CleanupState<L, C, B>) -> Vec<CleanupAction> {
    let mut actions = Vec::new();
    if state.mouse_down {
        actions.push(CleanupAction::MouseUp);
    }
    actions.extend(
        state
            .pending_key_releases
            .iter()
            .copied()
            .map(CleanupAction::KeyUp),
    );
    if state.dead_key_pending {
        actions.push(CleanupAction::ClearDeadKeyState);
    }
    if state.layout.is_some() {
        actions.push(CleanupAction::RestoreKeyboardLayout);
    }
    if state.cursor.is_some() {
        actions.push(CleanupAction::RestoreCursor);
    }
    if state.clipboard.is_some() {
        actions.push(CleanupAction::RestoreClipboard);
    }
    actions
}

pub(crate) fn execute_cleanup<L, C, B>(
    state: &mut CleanupState<L, C, B>,
    mut perform: impl FnMut(CleanupAction, &CleanupState<L, C, B>) -> Result<(), String>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for action in cleanup_actions(state) {
        if action == CleanupAction::RestoreKeyboardLayout && state.dead_key_pending {
            continue;
        }
        match perform(action, state) {
            Ok(()) => state.mark_succeeded(action),
            Err(error) => errors.push(error),
        }
    }
    errors
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        classify_clipboard_snapshot, execute_cleanup, normalize_absolute_coordinate,
        pending_key_releases, poll_exact_clipboard_text, require_complete_input, CleanupAction,
        CleanupState, ClipboardSnapshotKind, DriverAction, DriverProtocol, InputPoint,
        ReadyGeometry,
    };
    use serde_json::Value;
    use std::{
        ffi::c_void,
        mem::size_of,
        ptr, thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND, POINT},
        Graphics::Gdi::ClientToScreen,
        System::{
            DataExchange::{
                CloseClipboard, CountClipboardFormats, EmptyClipboard, GetClipboardData,
                OpenClipboard,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::CF_UNICODETEXT,
            StationsAndDesktops::{
                CloseDesktop, GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW,
                OpenInputDesktop, DESKTOP_READOBJECTS, UOI_FLAGS, UOI_IO, USEROBJECTFLAGS,
            },
            Threading::GetCurrentThreadId,
        },
        UI::{
            Input::KeyboardAndMouse::{
                ActivateKeyboardLayout, GetAsyncKeyState, GetKeyboardLayout, LoadKeyboardLayoutW,
                MapVirtualKeyExW, SendInput, ToUnicodeEx, HKL, INPUT, INPUT_0, INPUT_KEYBOARD,
                INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KLF_ACTIVATE, KLF_SETFORPROCESS,
                MAPVK_VK_TO_CHAR, MAPVK_VK_TO_VSC, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
                MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE_NOCOALESCE,
                MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, VK_C, VK_CONTROL, VK_E, VK_LBUTTON,
                VK_LCONTROL, VK_LWIN, VK_MENU, VK_OEM_7, VK_RCONTROL, VK_RIGHT, VK_RWIN, VK_SHIFT,
                VK_SPACE, VK_V, VK_Z,
            },
            WindowsAndMessaging::{
                GetClientRect, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo,
                GetSystemMetrics, GetWindowThreadProcessId, IsChild, SendMessageTimeoutW,
                SetCursorPos, SetForegroundWindow, GUITHREADINFO, SMTO_ABORTIFHUNG,
                SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
                WM_INPUTLANGCHANGEREQUEST, WSF_VISIBLE,
            },
        },
    };

    const US_INTERNATIONAL_KLID: [u16; 9] = [
        b'0' as u16,
        b'0' as u16,
        b'0' as u16,
        b'2' as u16,
        b'0' as u16,
        b'4' as u16,
        b'0' as u16,
        b'9' as u16,
        0,
    ];
    const CLIPBOARD_READINESS_TIMEOUT: Duration = Duration::from_millis(1_000);
    const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(10);

    enum ClipboardSnapshot {
        Empty,
    }

    #[derive(Clone, Copy)]
    struct KeyboardLayoutSnapshot {
        original: HKL,
        target: HKL,
        focus: HWND,
        thread_id: u32,
    }

    type NativeCleanupState = CleanupState<KeyboardLayoutSnapshot, POINT, ClipboardSnapshot>;

    pub(crate) struct WindowsNativeInputDriver {
        hwnd: HWND,
        device_scale: f64,
        protocol: DriverProtocol,
        cleanup_state: NativeCleanupState,
        cleaned: bool,
    }

    impl WindowsNativeInputDriver {
        pub(crate) fn new(hwnd: HWND, device_scale: f64) -> Result<Self, String> {
            if hwnd.is_null() || !device_scale.is_finite() || device_scale <= 0.0 {
                return Err("Windows native input driver received an invalid window".into());
            }
            Ok(Self {
                hwnd,
                device_scale,
                protocol: DriverProtocol::new(),
                cleanup_state: CleanupState::default(),
                cleaned: false,
            })
        }

        pub(crate) fn is_complete(&self) -> bool {
            self.protocol.is_complete() && self.cleaned
        }

        pub(crate) fn advance(&mut self, payload: &Value) -> Result<(), String> {
            if self.cleaned {
                return Err("Windows native input driver already settled".into());
            }
            match self.protocol.advance(payload)? {
                DriverAction::Drag(geometry) => {
                    self.preflight()?;
                    let clipboard = snapshot_clipboard(self.hwnd)?;
                    self.cleanup_state.clipboard = Some(clipboard);
                    self.send_drag(&geometry)?;
                }
                DriverAction::Copy => {
                    self.require_focus()?;
                    self.send_control_chord(VK_C, "copy")?;
                }
                DriverAction::CollapseSelection => {
                    self.require_focus()?;
                    self.send_key_sequence(
                        &[(VK_RIGHT, false), (VK_RIGHT, true)],
                        "collapse selection",
                    )?;
                }
                DriverAction::Paste => {
                    self.require_focus()?;
                    let expected = self
                        .protocol
                        .selected_text()
                        .ok_or_else(|| "native input selection is unavailable".to_string())?;
                    wait_for_exact_clipboard_text(self.hwnd, expected)?;
                    self.send_paste()?;
                }
                DriverAction::MoveCaret => {
                    self.require_focus()?;
                    self.activate_composition_layout()?;
                    self.send_right_arrow()?;
                }
                DriverAction::DeadKey => {
                    self.require_focus()?;
                    self.send_dead_key_press()?;
                }
                DriverAction::ComposeCharacter => {
                    self.require_focus()?;
                    self.send_composition_character()?;
                }
                DriverAction::Undo => {
                    self.cleanup_state.dead_key_pending = false;
                    self.require_focus()?;
                    self.send_control_chord(VK_Z, "undo")?;
                }
                DriverAction::Complete => self.cleanup()?,
            }
            Ok(())
        }

        pub(crate) fn cleanup(&mut self) -> Result<(), String> {
            if self.cleaned {
                return Ok(());
            }
            let hwnd = self.hwnd;
            let errors = execute_cleanup(&mut self.cleanup_state, |action, state| {
                perform_cleanup_action(hwnd, action, state)
            });
            self.cleaned = errors.is_empty() && self.cleanup_state.is_clean();
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn preflight(&mut self) -> Result<(), String> {
            require_interactive_input_desktop()?;
            require_input_released()?;
            self.require_focus()?;
            let mut cursor = POINT::default();
            if unsafe { GetCursorPos(&mut cursor) } == 0 {
                return Err("GetCursorPos failed during native input preflight".into());
            }
            self.cleanup_state.cursor = Some(cursor);
            Ok(())
        }

        fn require_focus(&self) -> Result<(HWND, u32), String> {
            unsafe {
                let _ = SetForegroundWindow(self.hwnd);
                if GetForegroundWindow() != self.hwnd {
                    return Err("visible WebView2 host could not obtain foreground focus".into());
                }
                let host_thread = GetWindowThreadProcessId(self.hwnd, ptr::null_mut());
                if host_thread == 0 {
                    return Err("WebView2 host window thread is unavailable".into());
                }
                let mut info = GUITHREADINFO {
                    cbSize: size_of::<GUITHREADINFO>() as u32,
                    ..Default::default()
                };
                if GetGUIThreadInfo(host_thread, &mut info) == 0
                    || info.hwndFocus.is_null()
                    || (info.hwndFocus != self.hwnd && IsChild(self.hwnd, info.hwndFocus) == 0)
                {
                    return Err("visible WebView2 editor does not own keyboard focus".into());
                }
                let focus_thread = GetWindowThreadProcessId(info.hwndFocus, ptr::null_mut());
                if focus_thread == 0 {
                    return Err("focused WebView2 input thread is unavailable".into());
                }
                Ok((info.hwndFocus, focus_thread))
            }
        }

        fn send_drag(&mut self, geometry: &ReadyGeometry) -> Result<(), String> {
            if (geometry.device_pixel_ratio - self.device_scale).abs() > 0.05 {
                return Err(format!(
                    "WebView2 device scale mismatch: page={} host={}",
                    geometry.device_pixel_ratio, self.device_scale
                ));
            }
            let mut client = windows_sys::Win32::Foundation::RECT::default();
            if unsafe { GetClientRect(self.hwnd, &mut client) } == 0 {
                return Err("GetClientRect failed for the WebView2 host".into());
            }
            let expected_width = (geometry.viewport_width * self.device_scale).round() as i32;
            let expected_height = (geometry.viewport_height * self.device_scale).round() as i32;
            if (client.right - expected_width).abs() > 3
                || (client.bottom - expected_height).abs() > 3
            {
                return Err("page viewport does not match the visible WebView2 client area".into());
            }
            let start = self.screen_point(geometry.drag_start)?;
            let end = self.screen_point(geometry.drag_end)?;
            let (virtual_x, virtual_y, virtual_width, virtual_height) = virtual_desktop()?;
            let mut inputs = Vec::with_capacity(23);
            inputs.push(absolute_mouse_move(
                start,
                virtual_x,
                virtual_y,
                virtual_width,
                virtual_height,
                false,
            ));
            inputs.push(mouse_input(0, 0, MOUSEEVENTF_LEFTDOWN));
            for step in 1..=20 {
                let ratio = f64::from(step) / 20.0;
                let point = POINT {
                    x: (f64::from(start.x) + f64::from(end.x - start.x) * ratio).round() as i32,
                    y: (f64::from(start.y) + f64::from(end.y - start.y) * ratio).round() as i32,
                };
                inputs.push(absolute_mouse_move(
                    point,
                    virtual_x,
                    virtual_y,
                    virtual_width,
                    virtual_height,
                    true,
                ));
            }
            inputs.push(mouse_input(0, 0, MOUSEEVENTF_LEFTUP));
            let actual = unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    size_of::<INPUT>() as i32,
                )
            };
            self.cleanup_state.mouse_down = actual >= 2 && actual < inputs.len() as u32;
            require_complete_input(inputs.len() as u32, actual, "mouse drag")
        }

        fn screen_point(&self, point: InputPoint) -> Result<POINT, String> {
            let mut origin = POINT::default();
            if unsafe { ClientToScreen(self.hwnd, &mut origin) } == 0 {
                return Err("ClientToScreen failed for the WebView2 host".into());
            }
            Ok(POINT {
                x: origin.x + (point.x * self.device_scale).round() as i32,
                y: origin.y + (point.y * self.device_scale).round() as i32,
            })
        }

        fn send_control_chord(&mut self, key: u16, label: &str) -> Result<(), String> {
            self.send_key_sequence(
                &[
                    (VK_CONTROL, false),
                    (key, false),
                    (key, true),
                    (VK_CONTROL, true),
                ],
                label,
            )
        }

        fn send_key_sequence(&mut self, events: &[(u16, bool)], label: &str) -> Result<(), String> {
            let inputs: Vec<INPUT> = events
                .iter()
                .map(|(key, key_up)| key_input(*key, *key_up))
                .collect();
            let actual = unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    size_of::<INPUT>() as i32,
                )
            };
            self.cleanup_state.pending_key_releases = pending_key_releases(events, actual);
            require_complete_input(inputs.len() as u32, actual, label)
        }

        fn send_paste(&mut self) -> Result<(), String> {
            self.send_key_sequence(
                &[
                    (VK_CONTROL, false),
                    (VK_V, false),
                    (VK_V, true),
                    (VK_CONTROL, true),
                ],
                "paste",
            )
        }

        fn activate_composition_layout(&mut self) -> Result<(), String> {
            let (focus, focus_thread) = self.require_focus()?;
            let original = unsafe { GetKeyboardLayout(focus_thread) };
            if original.is_null() {
                return Err("focused WebView2 keyboard layout is unavailable".into());
            }
            self.cleanup_state.layout = Some(KeyboardLayoutSnapshot {
                original,
                target: original,
                focus,
                thread_id: focus_thread,
            });
            let target =
                unsafe { LoadKeyboardLayoutW(US_INTERNATIONAL_KLID.as_ptr(), KLF_ACTIVATE) };
            if target.is_null() {
                return Err("United States-International layout 00020409 is unavailable".into());
            }
            let snapshot = self.cleanup_state.layout.as_mut().ok_or_else(|| {
                "keyboard layout snapshot disappeared during activation".to_string()
            })?;
            snapshot.target = target;
            let dead_key = unsafe { MapVirtualKeyExW(VK_OEM_7 as u32, MAPVK_VK_TO_CHAR, target) };
            if dead_key & 0x8000_0000 == 0 {
                return Err("VK_OEM_7 is not a dead key under layout 00020409".into());
            }
            request_keyboard_layout(target, focus, focus_thread)?;
            Ok(())
        }

        fn send_right_arrow(&mut self) -> Result<(), String> {
            // Move one real authored position past the just-pasted range. The
            // page acknowledges the resulting ProseMirror selection before
            // this driver sends the dead-key input. This both isolates that
            // authored edit from the paste in history and proves one benign
            // key was processed after the keyboard-layout change without a
            // guessed delay.
            self.send_key_sequence(&[(VK_RIGHT, false), (VK_RIGHT, true)], "caret advance")
        }

        fn send_dead_key_press(&mut self) -> Result<(), String> {
            self.cleanup_state.dead_key_pending = true;
            self.send_key_sequence(&[(VK_OEM_7, false), (VK_OEM_7, true)], "dead-key press")
        }

        fn send_composition_character(&mut self) -> Result<(), String> {
            self.send_key_sequence(&[(VK_E, false), (VK_E, true)], "composition character")
        }
    }

    fn perform_cleanup_action(
        hwnd: HWND,
        action: CleanupAction,
        state: &NativeCleanupState,
    ) -> Result<(), String> {
        match action {
            CleanupAction::MouseUp => {
                send_inputs(&[mouse_input(0, 0, MOUSEEVENTF_LEFTUP)], "mouse release")
            }
            CleanupAction::KeyUp(key) => send_inputs(&[key_input(key, true)], "key release"),
            CleanupAction::ClearDeadKeyState => {
                let layout = state
                    .layout
                    .as_ref()
                    .ok_or_else(|| "keyboard-layout cleanup state is unavailable".to_string())?;
                clear_dead_key_state(layout.target)
            }
            CleanupAction::RestoreKeyboardLayout => {
                let layout = state
                    .layout
                    .as_ref()
                    .ok_or_else(|| "keyboard-layout cleanup state is unavailable".to_string())?;
                restore_keyboard_layout(layout.original, layout.focus, layout.thread_id)
            }
            CleanupAction::RestoreCursor => {
                let cursor = state
                    .cursor
                    .as_ref()
                    .copied()
                    .ok_or_else(|| "cursor cleanup state is unavailable".to_string())?;
                if unsafe { SetCursorPos(cursor.x, cursor.y) } == 0 {
                    Err("SetCursorPos failed during native input cleanup".into())
                } else {
                    Ok(())
                }
            }
            CleanupAction::RestoreClipboard => {
                let clipboard = state
                    .clipboard
                    .as_ref()
                    .ok_or_else(|| "clipboard cleanup state is unavailable".to_string())?;
                restore_clipboard_snapshot(hwnd, clipboard)
            }
        }
    }

    impl Drop for WindowsNativeInputDriver {
        fn drop(&mut self) {
            let _ = self.cleanup();
        }
    }

    fn require_interactive_input_desktop() -> Result<(), String> {
        unsafe {
            let station = GetProcessWindowStation();
            if station.is_null() {
                return Err("process window station is unavailable".into());
            }
            let mut flags = USEROBJECTFLAGS::default();
            let mut needed = 0;
            if GetUserObjectInformationW(
                station,
                UOI_FLAGS,
                &mut flags as *mut _ as *mut c_void,
                size_of::<USEROBJECTFLAGS>() as u32,
                &mut needed,
            ) == 0
                || flags.dwFlags & WSF_VISIBLE as u32 == 0
            {
                return Err("Windows runner has no visible interactive window station".into());
            }
            let thread_desktop = GetThreadDesktop(GetCurrentThreadId());
            if thread_desktop.is_null() || !desktop_is_input(thread_desktop) {
                return Err("native host thread is not attached to the input desktop".into());
            }
            let input_desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if input_desktop.is_null() {
                return Err("Windows input desktop is unavailable or locked".into());
            }
            let is_input = desktop_is_input(input_desktop);
            let _ = CloseDesktop(input_desktop);
            if !is_input {
                return Err("opened Windows desktop is not the active input desktop".into());
            }
        }
        Ok(())
    }

    unsafe fn desktop_is_input(desktop: *mut c_void) -> bool {
        let mut is_input = 0i32;
        let mut needed = 0;
        GetUserObjectInformationW(
            desktop,
            UOI_IO,
            &mut is_input as *mut _ as *mut c_void,
            size_of::<i32>() as u32,
            &mut needed,
        ) != 0
            && is_input != 0
    }

    fn require_input_released() -> Result<(), String> {
        for key in [
            VK_LBUTTON,
            VK_SHIFT,
            VK_CONTROL,
            VK_LCONTROL,
            VK_RCONTROL,
            VK_MENU,
            VK_LWIN,
            VK_RWIN,
        ] {
            if unsafe { GetAsyncKeyState(key as i32) as u16 } & 0x8000 != 0 {
                return Err(format!(
                    "Win32 input preflight found virtual key {key} held"
                ));
            }
        }
        Ok(())
    }

    fn request_keyboard_layout(layout: HKL, focus: HWND, thread_id: u32) -> Result<(), String> {
        unsafe {
            let _ = ActivateKeyboardLayout(layout, KLF_SETFORPROCESS);
            let mut message_result = 0usize;
            if SendMessageTimeoutW(
                focus,
                WM_INPUTLANGCHANGEREQUEST,
                0,
                layout as isize,
                SMTO_ABORTIFHUNG,
                1_000,
                &mut message_result,
            ) == 0
            {
                return Err("focused WebView2 window rejected the keyboard-layout request".into());
            }
            if GetKeyboardLayout(thread_id) != layout {
                return Err("focused WebView2 thread did not activate the requested layout".into());
            }
        }
        Ok(())
    }

    fn restore_keyboard_layout(layout: HKL, focus: HWND, thread_id: u32) -> Result<(), String> {
        request_keyboard_layout(layout, focus, thread_id)
            .map_err(|error| format!("keyboard-layout restoration failed: {error}"))
    }

    fn clear_dead_key_state(layout: HKL) -> Result<(), String> {
        let scan_code = unsafe { MapVirtualKeyExW(VK_SPACE as u32, MAPVK_VK_TO_VSC, layout) };
        if scan_code == 0 {
            return Err("MapVirtualKeyExW failed while clearing dead-key state".into());
        }
        let keyboard_state = [0u8; 256];
        let mut translated = [0u16; 2];
        let count = unsafe {
            ToUnicodeEx(
                VK_SPACE as u32,
                scan_code,
                keyboard_state.as_ptr(),
                translated.as_mut_ptr(),
                translated.len() as i32,
                0,
                layout,
            )
        };
        if count == 1 {
            Ok(())
        } else {
            Err(format!(
                "ToUnicodeEx returned {count} while clearing dead-key state"
            ))
        }
    }

    fn virtual_desktop() -> Result<(i32, i32, i32, i32), String> {
        let result = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if result.2 <= 1 || result.3 <= 1 {
            return Err("Windows virtual desktop geometry is invalid".into());
        }
        Ok(result)
    }

    fn absolute_mouse_move(
        point: POINT,
        virtual_x: i32,
        virtual_y: i32,
        virtual_width: i32,
        virtual_height: i32,
        no_coalesce: bool,
    ) -> INPUT {
        let mut flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        if no_coalesce {
            flags |= MOUSEEVENTF_MOVE_NOCOALESCE;
        }
        mouse_input(
            normalize_absolute_coordinate(point.x, virtual_x, virtual_width),
            normalize_absolute_coordinate(point.y, virtual_y, virtual_height),
            flags,
        )
    }

    fn mouse_input(dx: i32, dy: i32, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn key_input(key: u16, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send_inputs(inputs: &[INPUT], label: &str) -> Result<(), String> {
        let actual = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        require_complete_input(inputs.len() as u32, actual, label)
    }

    fn snapshot_clipboard(hwnd: HWND) -> Result<ClipboardSnapshot, String> {
        unsafe {
            if OpenClipboard(hwnd) == 0 {
                return Err("OpenClipboard failed while snapshotting native state".into());
            }
            SetLastError(ERROR_SUCCESS);
            let format_count = CountClipboardFormats();
            let count_error = GetLastError();
            let result = (|| {
                if format_count == 0 && count_error != ERROR_SUCCESS {
                    return Err(format!(
                        "CountClipboardFormats failed with Win32 error {count_error}"
                    ));
                }
                match classify_clipboard_snapshot(format_count)? {
                    ClipboardSnapshotKind::Empty => Ok(ClipboardSnapshot::Empty),
                }
            })();
            close_clipboard_result(result)
        }
    }

    fn read_clipboard_text(hwnd: HWND) -> Result<String, String> {
        unsafe {
            if OpenClipboard(hwnd) == 0 {
                return Err("OpenClipboard failed".into());
            }
            close_clipboard_result(read_open_clipboard_text())
        }
    }

    fn wait_for_exact_clipboard_text(hwnd: HWND, expected: &str) -> Result<(), String> {
        let started = Instant::now();
        let diagnostics = poll_exact_clipboard_text(
            expected,
            CLIPBOARD_READINESS_TIMEOUT.as_millis() as u64,
            CLIPBOARD_POLL_INTERVAL.as_millis() as u64,
            || read_clipboard_text(hwnd),
            || started.elapsed().as_millis() as u64,
            |delay_ms| thread::sleep(Duration::from_millis(delay_ms)),
        )?;
        if diagnostics.attempts > 1 {
            eprintln!(
                "[native-proof] Win32 clipboard readiness {}",
                diagnostics.summary(),
            );
        }
        Ok(())
    }

    unsafe fn read_open_clipboard_text() -> Result<String, String> {
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        if handle.is_null() {
            return Err("CF_UNICODETEXT is unavailable on the Win32 clipboard".into());
        }
        let size = GlobalSize(handle);
        let pointer = GlobalLock(handle) as *const u16;
        if pointer.is_null() || size < size_of::<u16>() {
            return Err("Win32 clipboard text memory is unavailable".into());
        }
        let units = std::slice::from_raw_parts(pointer, size / size_of::<u16>());
        let length = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let text = String::from_utf16(&units[..length])
            .map_err(|_| "Win32 clipboard text is not valid UTF-16".to_string());
        let _ = GlobalUnlock(handle);
        text
    }

    fn restore_clipboard_snapshot(hwnd: HWND, snapshot: &ClipboardSnapshot) -> Result<(), String> {
        match snapshot {
            ClipboardSnapshot::Empty => clear_clipboard(hwnd),
        }
    }

    fn clear_clipboard(hwnd: HWND) -> Result<(), String> {
        unsafe {
            if OpenClipboard(hwnd) == 0 {
                return Err("OpenClipboard failed while restoring empty clipboard".into());
            }
            let result = if EmptyClipboard() == 0 {
                Err("EmptyClipboard failed while restoring empty clipboard".into())
            } else {
                Ok(())
            };
            close_clipboard_result(result)
        }
    }

    unsafe fn close_clipboard_result<T>(result: Result<T, String>) -> Result<T, String> {
        if CloseClipboard() != 0 {
            return result;
        }
        match result {
            Ok(_) => Err("CloseClipboard failed".into()),
            Err(error) => Err(format!("{error}; CloseClipboard failed")),
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use platform::WindowsNativeInputDriver;

#[cfg(test)]
mod tests {
    use super::{
        classify_clipboard_snapshot, cleanup_actions, execute_cleanup,
        normalize_absolute_coordinate, pending_key_releases, poll_exact_clipboard_text,
        require_complete_input, CleanupAction, CleanupState, ClipboardSnapshotKind, DriverAction,
        DriverProtocol,
    };
    use serde_json::json;
    use std::cell::Cell;

    fn ready() -> serde_json::Value {
        json!({
            "version": 1,
            "stage": "ready",
            "viewport": { "width": 1200, "height": 900 },
            "devicePixelRatio": 1.0,
            "gap": { "top": 320, "bottom": 500 },
            "dragStart": { "x": 260, "y": 300 },
            "dragEnd": { "x": 520, "y": 520 }
        })
    }

    #[test]
    fn copy_waits_for_collapsed_selection_before_paste() {
        let mut protocol = DriverProtocol::new();
        protocol.advance(&ready()).unwrap();
        protocol
            .advance(&json!({ "version": 1, "stage": "drag",
            "selectionFrom": 42, "selectionTo": 75, "gapPosition": 60,
            "selectedText": "invented selection" }))
            .unwrap();
        let action = protocol
            .advance(&json!({ "version": 1, "stage": "copy",
            "selectedText": "invented selection", "documentSize": 500 }))
            .unwrap();
        assert_eq!(format!("{action:?}"), "CollapseSelection");
        assert!(protocol
            .advance(&json!({ "version": 1, "stage": "paste",
            "pastedText": "invented selection", "beforeSize": 500,
            "afterSize": 518, "selectionPos": 93 }))
            .is_err());
        for invalid in [
            json!({ "documentSize": 501, "selectionPos": 75 }),
            json!({ "documentSize": 500, "selectionPos": 42 }),
        ] {
            let mut value = invalid;
            value["version"] = json!(1);
            value["stage"] = json!("collapsed");
            assert!(protocol.advance(&value).is_err());
        }
        assert_eq!(
            protocol
                .advance(&json!({ "version": 1, "stage": "collapsed",
            "documentSize": 500, "selectionPos": 75 }))
                .unwrap(),
            DriverAction::Paste
        );
    }

    #[test]
    fn advances_only_through_the_complete_ordered_protocol() {
        let mut protocol = DriverProtocol::new();
        assert!(matches!(
            protocol.advance(&ready()).unwrap(),
            DriverAction::Drag(_)
        ));
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "drag",
                    "selectionFrom": 42,
                    "selectionTo": 75,
                    "gapPosition": 60,
                    "selectedText": "invented selection"
                }))
                .unwrap(),
            DriverAction::Copy
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "copy",
                    "selectedText": "invented selection",
                    "documentSize": 500
                }))
                .unwrap(),
            DriverAction::CollapseSelection
        );
        assert_eq!(
            protocol
                .advance(&json!({ "version": 1, "stage": "collapsed",
                "documentSize": 500, "selectionPos": 75 }))
                .unwrap(),
            DriverAction::Paste
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "paste",
                    "pastedText": "invented selection",
                    "beforeSize": 500,
                    "afterSize": 518,
                    "selectionPos": 317
                }))
                .unwrap(),
            DriverAction::MoveCaret
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "caret",
                    "documentSize": 518,
                    "beforePos": 317,
                    "afterPos": 318
                }))
                .unwrap(),
            DriverAction::DeadKey
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "dead-keydown",
                    "documentSize": 518,
                    "insertionPos": 318
                }))
                .unwrap(),
            DriverAction::ComposeCharacter
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "dead-key",
                    "data": "é",
                    "beforeSize": 518,
                    "afterSize": 519,
                    "insertionPos": 318
                }))
                .unwrap(),
            DriverAction::Undo
        );
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "undo",
                    "documentSize": 518,
                    "documentRestored": true,
                    "selectionRestored": true
                }))
                .unwrap(),
            DriverAction::Complete
        );
        assert!(protocol.is_complete());
    }

    #[test]
    fn rejects_wrong_dead_key_delta_and_inexact_undo_identity() {
        let mut protocol = DriverProtocol::new();
        protocol.advance(&ready()).unwrap();
        protocol
            .advance(&json!({
                "version": 1,
                "stage": "drag",
                "selectionFrom": 42,
                "selectionTo": 75,
                "gapPosition": 60,
                "selectedText": "invented selection"
            }))
            .unwrap();
        protocol
            .advance(&json!({
                "version": 1,
                "stage": "copy",
                "selectedText": "invented selection",
                "documentSize": 500
            }))
            .unwrap();
        protocol
            .advance(&json!({ "version": 1, "stage": "collapsed",
            "documentSize": 500, "selectionPos": 75 }))
            .unwrap();
        protocol
            .advance(&json!({
                "version": 1,
                "stage": "paste",
                "pastedText": "invented selection",
                "beforeSize": 500,
                "afterSize": 518,
                "selectionPos": 317
            }))
            .unwrap();
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "dead-key",
                "data": "é",
                "beforeSize": 518,
                "afterSize": 519,
                "insertionPos": 318
            }))
            .is_err());
        for invalid in [
            json!({
                "version": 1,
                "stage": "caret",
                "documentSize": 519,
                "beforePos": 317,
                "afterPos": 318
            }),
            json!({
                "version": 1,
                "stage": "caret",
                "documentSize": 518,
                "beforePos": 316,
                "afterPos": 317
            }),
            json!({
                "version": 1,
                "stage": "caret",
                "documentSize": 518,
                "beforePos": 317,
                "afterPos": 317
            }),
            json!({
                "version": 1,
                "stage": "caret",
                "documentSize": 518,
                "beforePos": 317,
                "afterPos": 319
            }),
            json!({
                "version": 1,
                "stage": "caret",
                "documentSize": 518,
                "beforePos": 518,
                "afterPos": 519
            }),
        ] {
            assert!(protocol.advance(&invalid).is_err());
        }
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "caret",
                    "documentSize": 518,
                    "beforePos": 317,
                    "afterPos": 318
                }))
                .unwrap(),
            DriverAction::DeadKey
        );
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "dead-key",
                "data": "é",
                "beforeSize": 518,
                "afterSize": 519,
                "insertionPos": 318
            }))
            .is_err());
        for invalid in [
            json!({
                "version": 1,
                "stage": "dead-keydown",
                "documentSize": 519,
                "insertionPos": 318
            }),
            json!({
                "version": 1,
                "stage": "dead-keydown",
                "documentSize": 518,
                "insertionPos": 317
            }),
        ] {
            assert!(protocol.advance(&invalid).is_err());
        }
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "dead-keydown",
                    "documentSize": 518,
                    "insertionPos": 318
                }))
                .unwrap(),
            DriverAction::ComposeCharacter
        );
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "dead-key",
                "data": "e",
                "beforeSize": 518,
                "afterSize": 520,
                "insertionPos": 317
            }))
            .is_err());
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "dead-key",
                "data": "é",
                "beforeSize": 518,
                "afterSize": 519,
                "insertionPos": 317
            }))
            .is_err());
        assert_eq!(
            protocol
                .advance(&json!({
                    "version": 1,
                    "stage": "dead-key",
                    "data": "é",
                    "beforeSize": 518,
                    "afterSize": 519,
                    "insertionPos": 318
                }))
                .unwrap(),
            DriverAction::Undo
        );
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "undo",
                "documentSize": 518,
                "documentRestored": true,
                "selectionRestored": false
            }))
            .is_err());
    }

    #[test]
    fn rejects_out_of_order_duplicate_and_mismatched_messages() {
        let mut protocol = DriverProtocol::new();
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "copy",
                "selectedText": "invented",
                "documentSize": 100
            }))
            .is_err());
        protocol.advance(&ready()).unwrap();
        assert!(protocol.advance(&ready()).is_err());

        let mut protocol = DriverProtocol::new();
        protocol.advance(&ready()).unwrap();
        protocol
            .advance(&json!({
                "version": 1,
                "stage": "drag",
                "selectionFrom": 42,
                "selectionTo": 75,
                "gapPosition": 60,
                "selectedText": "invented"
            }))
            .unwrap();
        assert!(protocol
            .advance(&json!({
                "version": 1,
                "stage": "copy",
                "selectedText": "different",
                "documentSize": 100
            }))
            .is_err());
    }

    #[test]
    fn normalizes_virtual_desktop_edges_without_losing_negative_origins() {
        assert_eq!(normalize_absolute_coordinate(-1920, -1920, 3840), 0);
        assert_eq!(normalize_absolute_coordinate(1919, -1920, 3840), 65_535);
        assert!(normalize_absolute_coordinate(0, -1920, 3840) > 32_767);
    }

    #[test]
    fn rejects_partial_send_input_counts() {
        assert!(require_complete_input(4, 4, "keyboard").is_ok());
        assert_eq!(
            require_complete_input(4, 3, "keyboard").unwrap_err(),
            "keyboard SendInput accepted 3 of 4 records"
        );
    }

    #[test]
    fn cleanup_executor_orders_every_native_restore_and_retains_only_failures() {
        let mut state = CleanupState {
            mouse_down: true,
            pending_key_releases: vec![0x11, 0x43],
            dead_key_pending: false,
            layout: Some("layout"),
            cursor: Some("cursor"),
            clipboard: Some("clipboard"),
        };
        let mut observed = Vec::new();
        let errors = execute_cleanup(&mut state, |action, _| {
            observed.push(action);
            match action {
                CleanupAction::KeyUp(0x43) => Err("C key remained pressed".into()),
                CleanupAction::RestoreCursor => Err("cursor restore failed".into()),
                _ => Ok(()),
            }
        });

        assert_eq!(
            observed,
            vec![
                CleanupAction::MouseUp,
                CleanupAction::KeyUp(0x11),
                CleanupAction::KeyUp(0x43),
                CleanupAction::RestoreKeyboardLayout,
                CleanupAction::RestoreCursor,
                CleanupAction::RestoreClipboard,
            ]
        );
        assert_eq!(
            errors,
            vec!["C key remained pressed", "cursor restore failed"]
        );
        assert_eq!(
            cleanup_actions(&state),
            vec![CleanupAction::KeyUp(0x43), CleanupAction::RestoreCursor]
        );

        let mut retried = Vec::new();
        assert!(execute_cleanup(&mut state, |action, _| {
            retried.push(action);
            Ok(())
        })
        .is_empty());
        assert_eq!(
            retried,
            vec![CleanupAction::KeyUp(0x43), CleanupAction::RestoreCursor]
        );
        assert!(state.is_clean());
    }

    #[test]
    fn clears_pending_dead_key_before_layout_restore_and_retries_failed_clear() {
        let mut state = CleanupState {
            mouse_down: false,
            pending_key_releases: Vec::new(),
            dead_key_pending: true,
            layout: Some("layout"),
            cursor: Some("cursor"),
            clipboard: Some("clipboard"),
        };
        let mut observed = Vec::new();
        let errors = execute_cleanup(&mut state, |action, _| {
            observed.push(action);
            match action {
                CleanupAction::ClearDeadKeyState => Err("dead-key state remained pending".into()),
                _ => Ok(()),
            }
        });

        assert_eq!(
            observed,
            vec![
                CleanupAction::ClearDeadKeyState,
                CleanupAction::RestoreCursor,
                CleanupAction::RestoreClipboard,
            ]
        );
        assert_eq!(errors, vec!["dead-key state remained pending"]);
        assert_eq!(
            cleanup_actions(&state),
            vec![
                CleanupAction::ClearDeadKeyState,
                CleanupAction::RestoreKeyboardLayout,
            ]
        );

        let mut retried = Vec::new();
        assert!(execute_cleanup(&mut state, |action, _| {
            retried.push(action);
            Ok(())
        })
        .is_empty());
        assert_eq!(
            retried,
            vec![
                CleanupAction::ClearDeadKeyState,
                CleanupAction::RestoreKeyboardLayout,
            ]
        );
        assert!(state.is_clean());
    }

    #[test]
    fn accepts_only_an_exactly_restorable_empty_clipboard() {
        assert_eq!(
            classify_clipboard_snapshot(0).unwrap(),
            ClipboardSnapshotKind::Empty
        );
        assert_eq!(
            classify_clipboard_snapshot(1).unwrap_err(),
            "Win32 clipboard must be empty before native input proof so every format can be restored exactly"
        );
        assert_eq!(
            classify_clipboard_snapshot(2).unwrap_err(),
            "Win32 clipboard must be empty before native input proof so every format can be restored exactly"
        );
        assert_eq!(
            classify_clipboard_snapshot(-1).unwrap_err(),
            "CountClipboardFormats returned an invalid result"
        );
    }

    #[test]
    fn polls_until_the_normalized_clipboard_matches_exactly() {
        let mut observations = [
            Err("OpenClipboard failed".to_string()),
            Ok(String::new()),
            Ok("different text".to_string()),
            Ok("invented\r\nselection".to_string()),
        ]
        .into_iter();
        let now_ms = Cell::new(0u64);
        let mut waits = Vec::new();

        let diagnostics = poll_exact_clipboard_text(
            "invented\nselection",
            1_000,
            10,
            || observations.next().expect("bounded observation"),
            || now_ms.get(),
            |delay_ms| {
                waits.push(delay_ms);
                now_ms.set(now_ms.get() + delay_ms);
            },
        )
        .unwrap();

        assert_eq!(diagnostics.attempts, 4);
        assert_eq!(diagnostics.empty_reads, 1);
        assert_eq!(diagnostics.mismatch_reads, 1);
        assert_eq!(diagnostics.error_reads, 1);
        assert_eq!(diagnostics.last_mismatch_utf16, Some(14));
        assert_eq!(
            diagnostics.last_error.as_deref(),
            Some("OpenClipboard failed")
        );
        assert_eq!(waits, vec![10, 10, 10]);
    }

    #[test]
    fn clipboard_polling_fails_closed_with_bounded_diagnostics() {
        let mut observations = [
            Ok(String::new()),
            Ok("wrong".to_string()),
            Err("clipboard owner busy".to_string()),
        ]
        .into_iter();
        let now_ms = Cell::new(0u64);
        let mut waits = Vec::new();

        let error = poll_exact_clipboard_text(
            "invented selection",
            25,
            10,
            || observations.next().expect("bounded observation"),
            || now_ms.get(),
            |delay_ms| {
                waits.push(delay_ms);
                now_ms.set(now_ms.get() + delay_ms);
            },
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Win32 clipboard did not reach the exact copied selection within 25 ms \
(attempts=3, empty=1, mismatches=1, errors=1, lastMismatchUtf16=5, \
lastError=clipboard owner busy)"
        );
        assert_eq!(waits, vec![10, 10, 5]);
    }

    #[test]
    fn retains_every_key_whose_accepted_down_event_lacks_an_accepted_release() {
        let copy = [(0x11, false), (0x43, false), (0x43, true), (0x11, true)];
        assert_eq!(pending_key_releases(&copy, 2), vec![0x11, 0x43]);
        assert_eq!(pending_key_releases(&copy, 3), vec![0x11]);
        assert!(pending_key_releases(&copy, 4).is_empty());

        let paste = [
            (0x27, false),
            (0x27, true),
            (0x11, false),
            (0x56, false),
            (0x56, true),
            (0x11, true),
        ];
        assert_eq!(pending_key_releases(&paste, 1), vec![0x27]);
        assert_eq!(pending_key_releases(&paste, 4), vec![0x11, 0x56]);
        assert_eq!(pending_key_releases(&paste, 5), vec![0x11]);
    }
}
