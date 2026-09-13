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
impl OwnedChild {
    pub fn start(
        launch: &Launch,
        key: &str,
        cancellation: Option<&tokio::sync::watch::Receiver<bool>>,
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
            startup_stage!(10);
            CreateProcessW(
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
            )
            .map_err(startup_error!(10))?;
            startup_stage!(11);
            let _thread = Handle(process.hThread);
            Ok(Self {
                job: Some(job),
                process: Handle(process.hProcess),
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
