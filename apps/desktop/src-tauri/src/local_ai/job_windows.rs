use super::{ErrorCode, Launch, FLAGS};
use std::os::windows::ffi::OsStrExt;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::*,
    System::{JobObjects::*, Threading::*},
};

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
        launch.verify()?;
        if cancellation.is_some_and(|signal| *signal.borrow()) {
            return Err(ErrorCode::Cancelled);
        }
        unsafe {
            let job = Handle(
                CreateJobObjectW(None, PCWSTR::null()).map_err(|_| ErrorCode::StartupFailed)?,
            );
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|_| ErrorCode::StartupFailed)?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: true.into(),
            };
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
                .map_err(|_| ErrorCode::StartupFailed)?,
            );
            let mut size = 0;
            let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
            if size == 0 || size > 64 * 1024 {
                return Err(ErrorCode::StartupFailed);
            }
            let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(list), 2, None, &mut size)
                .map_err(|_| ErrorCode::StartupFailed)?;
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {
                fn drop(&mut self) {
                    unsafe { DeleteProcThreadAttributeList(self.0) }
                }
            }
            let _attributes = Attributes(list);
            let jobs = [job.0];
            let handles = [nul.0];
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(jobs.as_ptr().cast()),
                std::mem::size_of_val(&jobs),
                None,
                None,
            )
            .map_err(|_| ErrorCode::StartupFailed)?;
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(handles.as_ptr().cast()),
                std::mem::size_of_val(&handles),
                None,
                None,
            )
            .map_err(|_| ErrorCode::StartupFailed)?;
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
            let mut args = vec![quote(launch.executable.path.as_os_str())?];
            args.extend(FLAGS.iter().map(|s| s.to_string()));
            args.push("--model".into());
            args.push(quote(launch.model.path.as_os_str())?);
            let mut command: Vec<u16> = args.join(" ").encode_utf16().chain(Some(0)).collect();
            // A fresh explicit Unicode environment block; no proxy/library/MCP inheritance.
            let environment: Vec<u16> = format!("LLAMA_API_KEY={key}\0\0").encode_utf16().collect();
            let mut process = PROCESS_INFORMATION::default();
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
            .map_err(|_| ErrorCode::StartupFailed)?;
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
