use super::{ErrorCode, Launch, FLAGS};
use std::os::windows::ffi::OsStrExt;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::*,
    System::{JobObjects::*, Threading::*},
};

#[cfg(feature = "local-ai-proof")]
static STARTUP_SNAPSHOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "local-ai-proof")]
pub fn proof_startup_snapshot() -> (u8, i32) {
    let value = STARTUP_SNAPSHOT.load(std::sync::atomic::Ordering::SeqCst);
    ((value >> 32) as u8, value as u32 as i32)
}
#[cfg(feature = "local-ai-proof")]
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofTransition {
    site: u8,
    initial: u8,
    eventual: u8,
    elapsed_ms: u32,
    exit_code: Option<u32>,
}
#[cfg(feature = "local-ai-proof")]
static TRANSITION: std::sync::Mutex<Option<ProofTransition>> = std::sync::Mutex::new(None);
#[cfg(feature = "local-ai-proof")]
pub fn proof_transition_snapshot() -> Option<ProofTransition> {
    TRANSITION.try_lock().ok().and_then(|value| *value)
}
macro_rules! startup_stage {
    ($stage:expr) => {
        #[cfg(feature = "local-ai-proof")]
        STARTUP_SNAPSHOT.store(($stage as u64) << 32, std::sync::atomic::Ordering::SeqCst);
    };
}
macro_rules! startup_error {
    ($stage:expr) => {
        |error: windows::core::Error| {
            #[cfg(feature = "local-ai-proof")]
            STARTUP_SNAPSHOT.store(
                (($stage as u64) << 32) | error.code().0 as u32 as u64,
                std::sync::atomic::Ordering::SeqCst,
            );
            let _ = error;
            ErrorCode::StartupFailed
        }
    };
}

struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub struct OwnedChild {
    job: Option<Handle>,
    process: Handle,
    pub pid: u32,
}
#[cfg(feature = "local-ai-proof")]
#[derive(Default)]
pub struct ProofQuota {
    pub created: bool,
    pub limit: u32,
    pub before_count: u32,
    pub after_count: u32,
    pub holder_member: bool,
}
#[cfg(feature = "local-ai-proof")]
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofHandles {
    pub created: bool,
    pub fake_pid: u32,
    pub job_flags: u32,
    pub nul_flags: u32,
    pub canary_flags: u32,
    pub process_flags: u32,
    pub thread_flags: u32,
    pub parent_identity: bool,
    pub nul_identity: bool,
    pub exclusion: &'static str,
    pub before_alive: bool,
    pub after_alive: bool,
    pub inspection_error: bool,
    pub cleaned: bool,
    pub cleanup_ms: u32,
}
#[cfg(feature = "local-ai-proof")]
enum ProofStart<'a> {
    Quota(HANDLE, &'a mut ProofQuota),
    Handles(HANDLE, &'a mut ProofHandles),
}
#[cfg(feature = "local-ai-proof")]
struct ProofCleanup {
    process: HANDLE,
    canary: Option<Handle>,
    armed: bool,
}
#[cfg(feature = "local-ai-proof")]
impl ProofCleanup {
    fn finish(&mut self) -> (bool, u32) {
        drop(self.canary.take());
        let started = std::time::Instant::now();
        let clean = unsafe {
            let state = WaitForSingleObject(self.process, 0);
            (state == WAIT_OBJECT_0
                || (state == WAIT_TIMEOUT && TerminateProcess(self.process, 1).is_ok()))
                && WaitForSingleObject(self.process, 5000) == WAIT_OBJECT_0
        };
        self.armed = false;
        (
            clean,
            started.elapsed().as_millis().min(u32::MAX as u128) as u32,
        )
    }
}
#[cfg(feature = "local-ai-proof")]
impl Drop for ProofCleanup {
    fn drop(&mut self) {
        if self.armed {
            self.finish();
        }
    }
}
#[cfg(feature = "local-ai-proof")]
unsafe fn proof_flags(handle: HANDLE) -> windows::core::Result<u32> {
    let mut flags = 0;
    GetHandleInformation(handle, &mut flags)?;
    Ok(flags)
}
#[cfg(feature = "local-ai-proof")]
unsafe fn proof_duplicate(source: HANDLE, handle: HANDLE) -> windows::core::Result<Handle> {
    let mut duplicate = HANDLE::default();
    DuplicateHandle(
        source,
        handle,
        GetCurrentProcess(),
        &mut duplicate,
        0,
        false,
        DUPLICATE_SAME_ACCESS,
    )?;
    Ok(Handle(duplicate))
}
#[cfg(feature = "local-ai-proof")]
fn quota_membership(job: HANDLE, holder: HANDLE) -> Result<(u32, bool), ErrorCode> {
    unsafe {
        let mut counts = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        QueryInformationJobObject(
            Some(job),
            JobObjectBasicAccountingInformation,
            (&mut counts as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            std::mem::size_of_val(&counts) as u32,
            None,
        )
        .map_err(|_| ErrorCode::StartupFailed)?;
        let mut member = windows::core::BOOL::default();
        IsProcessInJob(holder, Some(job), &mut member).map_err(|_| ErrorCode::StartupFailed)?;
        Ok((
            counts.ActiveProcesses,
            member.as_bool() && WaitForSingleObject(holder, 0) == WAIT_TIMEOUT,
        ))
    }
}
impl OwnedChild {
    pub fn start(
        launch: &Launch,
        key: &str,
        cancellation: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> Result<Self, ErrorCode> {
        Self::start_inner(
            launch,
            key,
            cancellation,
            #[cfg(feature = "local-ai-proof")]
            None,
        )
    }
    #[cfg(feature = "local-ai-proof")]
    pub fn proof_quota_start(
        launch: &Launch,
        key: &str,
        holder: &std::process::Child,
        snapshot: &mut ProofQuota,
    ) -> Result<Self, ErrorCode> {
        use std::os::windows::io::AsRawHandle;
        Self::start_inner(
            launch,
            key,
            None,
            Some(ProofStart::Quota(HANDLE(holder.as_raw_handle()), snapshot)),
        )
    }
    #[cfg(feature = "local-ai-proof")]
    pub fn proof_handle_start(
        launch: &Launch,
        key: &str,
        sentinel: &std::process::Child,
        snapshot: &mut ProofHandles,
    ) -> Result<Self, ErrorCode> {
        use std::os::windows::io::AsRawHandle;
        snapshot.inspection_error = true;
        Self::start_inner(
            launch,
            key,
            None,
            Some(ProofStart::Handles(
                HANDLE(sentinel.as_raw_handle()),
                snapshot,
            )),
        )
    }
    fn start_inner(
        launch: &Launch,
        key: &str,
        cancellation: Option<&tokio::sync::watch::Receiver<bool>>,
        #[cfg(feature = "local-ai-proof")] mut proof: Option<ProofStart<'_>>,
    ) -> Result<Self, ErrorCode> {
        #[cfg(feature = "local-ai-proof")]
        if let Ok(mut value) = TRANSITION.lock() {
            *value = None;
        }
        startup_stage!(1);
        launch.verify()?;
        if cancellation.is_some_and(|signal| *signal.borrow()) {
            return Err(ErrorCode::Cancelled);
        }
        unsafe {
            startup_stage!(2);
            let job = Handle(CreateJobObjectW(None, PCWSTR::null()).map_err(startup_error!(2))?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            startup_stage!(3);
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(startup_error!(3))?;
            #[cfg(feature = "local-ai-proof")]
            if let Some(ProofStart::Quota(holder, snapshot)) = proof.as_mut() {
                limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                limits.BasicLimitInformation.ActiveProcessLimit = 1;
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
                .map_err(startup_error!(3))?;
                AssignProcessToJobObject(job.0, *holder).map_err(startup_error!(3))?;
                let mut observed = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                QueryInformationJobObject(
                    Some(job.0),
                    JobObjectExtendedLimitInformation,
                    (&mut observed as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&observed) as u32,
                    None,
                )
                .map_err(startup_error!(3))?;
                snapshot.limit = observed.BasicLimitInformation.ActiveProcessLimit;
                (snapshot.before_count, snapshot.holder_member) = quota_membership(job.0, *holder)?;
                if snapshot.limit != 1
                    || snapshot.before_count != 1
                    || !snapshot.holder_member
                    || !observed.BasicLimitInformation.LimitFlags.contains(
                        JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    )
                {
                    return Err(ErrorCode::StartupFailed);
                }
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: true.into(),
            };
            startup_stage!(4);
            let nul = Handle(
                CreateFileW(
                    windows::core::w!("NUL"),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    Some(&attributes),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
                .map_err(startup_error!(4))?,
            );
            let mut size = 0;
            startup_stage!(5);
            let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
            if size == 0 || size > 64 * 1024 {
                return Err(ErrorCode::StartupFailed);
            }
            let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
            startup_stage!(6);
            InitializeProcThreadAttributeList(Some(list), 2, None, &mut size)
                .map_err(startup_error!(6))?;
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {
                fn drop(&mut self) {
                    unsafe { DeleteProcThreadAttributeList(self.0) }
                }
            }
            let _attributes = Attributes(list);
            let jobs = [job.0];
            let handles = [nul.0];
            startup_stage!(7);
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(jobs.as_ptr().cast()),
                std::mem::size_of_val(&jobs),
                None,
                None,
            )
            .map_err(startup_error!(7))?;
            startup_stage!(8);
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(handles.as_ptr().cast()),
                std::mem::size_of_val(&handles),
                None,
                None,
            )
            .map_err(startup_error!(8))?;
            let mut info = STARTUPINFOEXW::default();
            info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            info.StartupInfo.hStdInput = nul.0;
            info.StartupInfo.hStdOutput = nul.0;
            info.StartupInfo.hStdError = nul.0;
            info.lpAttributeList = list;
            let executable: Vec<u16> = launch
                .executable
                .path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let cwd: Vec<u16> = launch
                .executable
                .root
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            startup_stage!(9);
            let mut args = vec![quote(launch.executable.path.as_os_str())?];
            args.extend(FLAGS.iter().map(|s| s.to_string()));
            args.push("--model".into());
            args.push(quote(launch.model.path.as_os_str())?);
            let mut command: Vec<u16> = args.join(" ").encode_utf16().chain(Some(0)).collect();
            // Winsock needs SystemRoot; query the OS, never inherit a parent override.
            let mut system_root = vec![0u16; 32768];
            let root_length = windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW(
                Some(&mut system_root),
            ) as usize;
            if root_length == 0
                || root_length >= system_root.len()
                || system_root[root_length] != 0
                || system_root[..root_length].contains(&0)
            {
                return Err(ErrorCode::StartupFailed);
            }
            let system_root = String::from_utf16(&system_root[..root_length])
                .map_err(|_| ErrorCode::StartupFailed)?;
            // Fresh Unicode block: only the generated key and required OS value.
            let environment: Vec<u16> =
                format!("LLAMA_API_KEY={key}\0SystemRoot={system_root}\0\0")
                    .encode_utf16()
                    .collect();
            let mut process = PROCESS_INFORMATION::default();
            #[cfg(feature = "local-ai-proof")]
            let mut canary = None;
            #[cfg(feature = "local-ai-proof")]
            if let Some(ProofStart::Handles(sentinel, snapshot)) = proof.as_mut() {
                let mut handle = HANDLE::default();
                DuplicateHandle(
                    GetCurrentProcess(),
                    *sentinel,
                    GetCurrentProcess(),
                    &mut handle,
                    PROCESS_SYNCHRONIZE.0,
                    true,
                    DUPLICATE_HANDLE_OPTIONS(0),
                )
                .map_err(|_| ErrorCode::StartupFailed)?;
                canary = Some(Handle(handle));
                snapshot.job_flags = proof_flags(job.0).map_err(|_| ErrorCode::StartupFailed)?;
                snapshot.nul_flags = proof_flags(nul.0).map_err(|_| ErrorCode::StartupFailed)?;
                snapshot.canary_flags =
                    proof_flags(handle).map_err(|_| ErrorCode::StartupFailed)?;
                proof_flags(*sentinel).map_err(|_| ErrorCode::StartupFailed)?;
                snapshot.parent_identity = CompareObjectHandles(*sentinel, handle).as_bool();
                if !snapshot.parent_identity || WaitForSingleObject(*sentinel, 0) != WAIT_TIMEOUT {
                    return Err(ErrorCode::StartupFailed);
                }
            }
            startup_stage!(10);
            let created = CreateProcessW(
                PCWSTR(executable.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                Some(environment.as_ptr().cast()),
                PCWSTR(cwd.as_ptr()),
                &info.StartupInfo,
                &mut process,
            );
            // A successful call grants handle ownership before any fallible proof observation.
            let owned = created
                .as_ref()
                .ok()
                .map(|_| (Handle(process.hProcess), Handle(process.hThread)));
            #[cfg(feature = "local-ai-proof")]
            if let Some(ProofStart::Handles(sentinel, snapshot)) = proof.as_mut() {
                snapshot.created = created.is_ok();
                if let Some((process_handle, thread)) = &owned {
                    // Armed before any fallible inspection; duplicate locals drop before this guard.
                    let mut cleanup = ProofCleanup {
                        process: process_handle.0,
                        canary: canary.take(),
                        armed: true,
                    };
                    snapshot.fake_pid = process.dwProcessId;
                    let inspected = (|| -> windows::core::Result<()> {
                        snapshot.process_flags = proof_flags(process_handle.0)?;
                        snapshot.thread_flags = proof_flags(thread.0)?;
                        snapshot.before_alive =
                            WaitForSingleObject(process_handle.0, 0) == WAIT_TIMEOUT;
                        let nul_copy = proof_duplicate(process_handle.0, nul.0)?;
                        proof_flags(nul_copy.0)?;
                        snapshot.nul_identity = CompareObjectHandles(nul_copy.0, nul.0).as_bool();
                        let borrowed_canary = cleanup.canary.as_ref().unwrap().0;
                        match proof_duplicate(process_handle.0, borrowed_canary) {
                            Err(error)
                                if error.code()
                                    == windows::core::HRESULT::from_win32(
                                        ERROR_INVALID_HANDLE.0,
                                    ) =>
                            {
                                snapshot.exclusion = "invalid-handle"
                            }
                            Err(error) => return Err(error),
                            Ok(candidate) => {
                                proof_flags(candidate.0)?;
                                proof_flags(*sentinel)?;
                                SetLastError(ERROR_SUCCESS);
                                if CompareObjectHandles(candidate.0, *sentinel).as_bool() {
                                    snapshot.exclusion = "same-object";
                                } else if GetLastError() == ERROR_NOT_SAME_OBJECT {
                                    snapshot.exclusion = "different-object";
                                } else {
                                    return Err(windows::core::Error::from_win32());
                                }
                            }
                        }
                        snapshot.after_alive = WaitForSingleObject(process_handle.0, 0)
                            == WAIT_TIMEOUT
                            && WaitForSingleObject(*sentinel, 0) == WAIT_TIMEOUT;
                        Ok(())
                    })();
                    snapshot.inspection_error = inspected.is_err();
                    (snapshot.cleaned, snapshot.cleanup_ms) = cleanup.finish();
                }
            }
            #[cfg(feature = "local-ai-proof")]
            if let Some(ProofStart::Quota(holder, snapshot)) = proof.as_mut() {
                snapshot.created = created.is_ok();
                if let Some((process, _)) = &owned {
                    // A broken JOB_LIST must not let this proof's unexpected child escape.
                    if WaitForSingleObject(process.0, 0) == WAIT_TIMEOUT {
                        TerminateProcess(process.0, 1).map_err(|_| ErrorCode::StartupFailed)?;
                    }
                    if WaitForSingleObject(process.0, 5000) != WAIT_OBJECT_0 {
                        return Err(ErrorCode::StartupFailed);
                    }
                }
                (snapshot.after_count, snapshot.holder_member) = quota_membership(job.0, *holder)?;
            }
            created.map_err(startup_error!(10))?;
            startup_stage!(11);
            let (process_handle, _thread) = owned.ok_or(ErrorCode::StartupFailed)?;
            Ok(Self {
                job: Some(job),
                process: process_handle,
                pid: process.dwProcessId,
            })
        }
    }
    pub fn alive(&mut self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == WAIT_TIMEOUT }
    }
    pub async fn transport_error(
        &mut self,
        _site: u8,
        deadline: tokio::time::Instant,
    ) -> ErrorCode {
        let initial = unsafe { WaitForSingleObject(self.process.0, 0) };
        #[cfg(feature = "local-ai-proof")]
        let state = |value| {
            if value == WAIT_TIMEOUT {
                1
            } else if value == WAIT_OBJECT_0 {
                2
            } else {
                3
            }
        };
        #[cfg(feature = "local-ai-proof")]
        let mut observation = ProofTransition {
            site: _site,
            initial: state(initial),
            eventual: 3,
            elapsed_ms: 0,
            exit_code: None,
        };
        let mut settled = initial;
        let duplicate = unsafe {
            let mut raw = HANDLE::default();
            let duplicated = DuplicateHandle(
                GetCurrentProcess(),
                self.process.0,
                GetCurrentProcess(),
                &mut raw,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            );
            duplicated.ok().map(|_| Handle(raw))
        };
        if let Some(duplicate) = duplicate {
            // Windows closes sockets before signalling process exit. Settle only
            // a transport failure, using this exact owned handle and admission deadline.
            let waited = tokio::task::spawn_blocking(move || {
                let duplicate = duplicate; // Move the Send owner, not a captured raw HANDLE field.
                #[cfg(feature = "local-ai-proof")]
                let started = std::time::Instant::now();
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let milliseconds = remaining.as_millis().min(250) as u32;
                let result = unsafe { WaitForSingleObject(duplicate.0, milliseconds) };
                #[cfg(feature = "local-ai-proof")]
                {
                    observation.eventual = state(result);
                    observation.elapsed_ms =
                        started.elapsed().as_millis().try_into().unwrap_or(u32::MAX);
                    if result == WAIT_OBJECT_0 {
                        let mut code = 0;
                        if unsafe { GetExitCodeProcess(duplicate.0, &mut code) }.is_ok() {
                            observation.exit_code = Some(code);
                        }
                    }
                    return (result, observation);
                }
                #[cfg(not(feature = "local-ai-proof"))]
                result
            });
            let waited = tokio::time::timeout_at(deadline, waited).await;
            match waited {
                Ok(Ok(value)) => {
                    #[cfg(feature = "local-ai-proof")]
                    {
                        settled = value.0;
                        observation = value.1;
                    }
                    #[cfg(not(feature = "local-ai-proof"))]
                    {
                        settled = value;
                    }
                }
                Err(_) => return ErrorCode::Timeout,
                Ok(Err(_)) => {}
            }
        }
        // The worker never publishes. Dropping this future on cancel/deadline
        // discards its late measurement while its duplicate stays owned to exit.
        #[cfg(feature = "local-ai-proof")]
        if tokio::time::Instant::now() < deadline {
            if let Ok(mut value) = TRANSITION.lock() {
                *value = Some(observation);
            }
        }
        if settled == WAIT_OBJECT_0 {
            ErrorCode::Crash
        } else {
            ErrorCode::InvalidResponse
        }
    }
    pub fn stop(&mut self) -> Result<(), ErrorCode> {
        // Kill-on-close containment also works when installation exits inside native code.
        self.job.take();
        if unsafe { WaitForSingleObject(self.process.0, 5000) } == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(ErrorCode::Crash)
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
fn quote(value: &std::ffi::OsStr) -> Result<String, ErrorCode> {
    let text = value.to_str().ok_or(ErrorCode::StartupFailed)?;
    if text.contains(['\0', '"']) {
        return Err(ErrorCode::StartupFailed);
    }
    let prefix = text.trim_end_matches('\\');
    Ok(format!(
        "\"{}\"",
        prefix.to_owned() + &"\\".repeat(2 * (text.len() - prefix.len()))
    ))
}
pub fn guardian_entry() -> bool {
    false
}
