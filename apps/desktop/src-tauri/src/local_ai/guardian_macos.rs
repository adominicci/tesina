use super::{ErrorCode, Launch, FLAGS};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct GuardedChild {
    child: Child,
    notify: UnixStream,
}
impl std::ops::Deref for GuardedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for GuardedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for GuardedChild {
    fn drop(&mut self) {
        // Invalidate the parent's authority before any reap permits PID reuse.
        let _ = self.notify.write_all(&[1]);
        if matches!(self.child.try_wait(), Ok(None)) {
            unsafe {
                libc::kill(self.child.id() as i32, libc::SIGTERM);
            }
            let grace = Instant::now() + Duration::from_secs(2);
            while Instant::now() < grace {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

const MODE: &str = "--tesina-local-ai-guardian";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    parent: u32,
    launch: Launch,
    key: String,
}

pub struct OwnedChild {
    guardian: Child,
    lifeline: Option<File>,
    control: Option<UnixStream>,
    exited: bool,
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
        let (mut control, child_control) =
            UnixStream::pair().map_err(|_| ErrorCode::StartupFailed)?;
        control
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| ErrorCode::StartupFailed)?;
        control
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| ErrorCode::StartupFailed)?;
        let mut pipe = [-1; 2];
        if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
            return Err(ErrorCode::StartupFailed);
        }
        let read = unsafe { File::from_raw_fd(pipe[0]) };
        let write = unsafe { File::from_raw_fd(pipe[1]) };
        // The application is the only writer, including across exec boundaries.
        for fd in pipe {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(ErrorCode::StartupFailed);
            }
        }
        let control_fd = child_control.as_raw_fd();
        let read_fd = read.as_raw_fd();
        let mut command =
            Command::new(std::env::current_exe().map_err(|_| ErrorCode::StartupFailed)?);
        command
            .arg(MODE)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                // Dup to high temporary descriptors first so originals3/4 cannot collide.
                let control_copy = libc::fcntl(control_fd, libc::F_DUPFD_CLOEXEC, 10);
                let read_copy = libc::fcntl(read_fd, libc::F_DUPFD_CLOEXEC, 10);
                if control_copy < 0
                    || read_copy < 0
                    || libc::dup2(control_copy, 3) < 0
                    || libc::dup2(read_copy, 4) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(control_copy);
                libc::close(read_copy);
                Ok(())
            });
        }
        let guardian = command.spawn().map_err(|_| ErrorCode::StartupFailed)?;
        let mut owned = Self {
            guardian,
            lifeline: Some(write),
            control: None,
            exited: false,
            pid: 0,
        };
        drop(child_control);
        drop(read);
        let start = serde_json::to_vec(&Start {
            parent: std::process::id(),
            launch: launch.clone(),
            key: key.to_owned(),
        })
        .map_err(|_| ErrorCode::StartupFailed)?;
        if start.len() > 8192 {
            return Err(ErrorCode::StartupFailed);
        }
        control
            .write_all(&(start.len() as u32).to_be_bytes())
            .and_then(|()| control.write_all(&start))
            .map_err(|_| ErrorCode::StartupFailed)?;
        let mut pid = [0; 4];
        control
            .read_exact(&mut pid)
            .map_err(|_| ErrorCode::StartupFailed)?;
        owned.pid = u32::from_be_bytes(pid);
        if owned.pid == 0 {
            return Err(ErrorCode::StartupFailed);
        }
        control
            .set_nonblocking(true)
            .map_err(|_| ErrorCode::StartupFailed)?;
        owned.control = Some(control);
        Ok(owned)
    }
    pub fn alive(&mut self) -> bool {
        if self.exited {
            return false;
        }
        if !matches!(self.guardian.try_wait(), Ok(None)) {
            self.exited = true;
            return false;
        }
        let mut status = [0];
        self.exited = match self
            .control
            .as_mut()
            .map(|control| control.read(&mut status))
        {
            Some(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => false,
            _ => true,
        };
        if !self.exited {
            unsafe extern "C" {
                fn tesina_process_exiting(pid: i32) -> i32;
            }
            // Socket EOF can precede the guardian's exit notification. The guardian
            // retains this exact child unreaped, including while exit is in progress.
            let observation = unsafe { tesina_process_exiting(self.pid as i32) };
            self.exited = observation == 1;
        }
        !self.exited
    }
    pub fn stop(&mut self) -> Result<(), ErrorCode> {
        self.lifeline.take();
        self.control.take();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self
                .guardian
                .try_wait()
                .map_err(|_| ErrorCode::Crash)?
                .is_some()
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(ErrorCode::Crash)
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn descriptor_is(fd: i32, kind: libc::mode_t) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    unsafe {
        libc::fstat(fd, info.as_mut_ptr()) == 0 && info.assume_init().st_mode & libc::S_IFMT == kind
    }
}
fn parent_is_same_executable(parent: u32) -> bool {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let count =
        unsafe { libc::proc_pidpath(parent as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if count <= 0 {
        return false;
    }
    use std::os::unix::ffi::OsStrExt;
    let len = path.iter().position(|b| *b == 0).unwrap_or(path.len());
    std::env::current_exe().is_ok_and(|own| own.as_os_str().as_bytes() == &path[..len])
}
fn eof(fd: i32) -> bool {
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
        revents: 0,
    };
    unsafe { libc::poll(&mut descriptor, 1, 0) < 0 || descriptor.revents != 0 }
}
fn guard() -> Result<(), ()> {
    if !descriptor_is(3, libc::S_IFSOCK) || !descriptor_is(4, libc::S_IFIFO) {
        return Err(());
    }
    let mut control = unsafe { UnixStream::from_raw_fd(3) };
    let lifeline = unsafe { File::from_raw_fd(4) };
    for fd in [3, 4] {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(());
        }
    }
    control
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    let mut length = [0; 4];
    control.read_exact(&mut length).map_err(|_| ())?;
    let length = u32::from_be_bytes(length) as usize;
    if length > 8192 {
        return Err(());
    }
    let mut bytes = vec![0; length];
    control.read_exact(&mut bytes).map_err(|_| ())?;
    let start: Start = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if start.parent != unsafe { libc::getppid() } as u32
        || !parent_is_same_executable(start.parent)
        || start.key.len() != 64
        || !start.key.bytes().all(|b| b.is_ascii_hexdigit())
        || eof(lifeline.as_raw_fd())
    {
        return Err(());
    }
    start.launch.verify().map_err(|_| ())?;
    if eof(lifeline.as_raw_fd()) {
        return Err(());
    }
    control.set_nonblocking(true).map_err(|_| ())?;
    let notify = control.try_clone().map_err(|_| ())?;
    let child = Command::new(&start.launch.executable.path)
        .args(FLAGS)
        .arg("--model")
        .arg(&start.launch.model.path)
        .env_clear()
        .env("LLAMA_API_KEY", start.key)
        .current_dir(&start.launch.executable.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let mut child = GuardedChild { child, notify };
    let sent = control.write_all(&child.id().to_be_bytes()).is_ok();
    #[cfg(feature = "local-ai-proof")]
    if start
        .launch
        .model
        .path
        .file_stem()
        .is_some_and(|name| name == "guardian-fault")
    {
        return Err(());
    }
    let mut stop = !sent;
    let mut reported_exit = false;
    while !stop {
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(());
        }
        if unsafe { info.si_pid() } != 0 && !reported_exit {
            control.write_all(&[1]).map_err(|_| ())?;
            reported_exit = true;
        }
        stop = eof(lifeline.as_raw_fd());
        // Only one start is accepted. Any further data or control EOF stops the child.
        let mut byte = [0u8];
        if matches!(control.read(&mut byte), Ok(_)) {
            stop = true;
        }
        if !stop {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // This PID remains unreaped and belongs to this guardian throughout signalling.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let grace = Instant::now() + Duration::from_secs(2);
    while Instant::now() < grace {
        if child.try_wait().map_err(|_| ())?.is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().map_err(|_| ())?;
    child.wait().map_err(|_| ())?;
    Ok(())
}
pub fn guardian_entry() -> bool {
    if std::env::args_os().nth(1).is_some_and(|arg| arg == MODE) {
        let _ = guard();
        true
    } else {
        false
    }
}
