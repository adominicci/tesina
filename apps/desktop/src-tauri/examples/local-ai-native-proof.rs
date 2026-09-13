//! Process/socket proof only. This is not platform-webview acceptance.
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};

// Nonshipping diagnostics: fixed IDs only, never panic payloads or paths.
static FAILURE_PHASE: AtomicU8 = AtomicU8::new(0);
static FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);
static FAILURE_RESULT: AtomicU8 = AtomicU8::new(0);
static CHILD_STARTED: AtomicBool = AtomicBool::new(false);
static FIXTURE_MARKER: AtomicBool = AtomicBool::new(false);
static FAKE_BIND: AtomicU8 = AtomicU8::new(0);
static FAKE_BIND_CODE: AtomicI32 = AtomicI32::new(0);
static FAKE_BIND_HAS_CODE: AtomicBool = AtomicBool::new(false);

fn capture_fake_bind(fixture: &std::path::Path) {
    use std::io::Read;
    let file = match std::fs::File::open(fixture.join("launch-bind.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            FAKE_BIND.store(3, Ordering::SeqCst);
            return;
        }
    };
    let mut bytes = Vec::new();
    let valid = (|| {
        file.take(129).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 128 {
            return None;
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        if value.as_object()?.len() != 2 {
            return None;
        }
        let status = value.get("status")?.as_u64()?;
        let code = value.get("code")?;
        let code = if code.is_null() {
            None
        } else {
            Some(i32::try_from(code.as_i64()?).ok()?)
        };
        if !matches!(status, 1 | 2) || (status == 1 && code.is_some()) {
            return None;
        }
        Some((status as u8, code))
    })();
    let Some((status, code)) = valid else {
        FAKE_BIND.store(3, Ordering::SeqCst);
        return;
    };
    FAKE_BIND_CODE.store(code.unwrap_or(0), Ordering::SeqCst);
    FAKE_BIND_HAS_CODE.store(code.is_some(), Ordering::SeqCst);
    FAKE_BIND.store(status, Ordering::SeqCst);
}
fn diagnostic_hook() {
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        if FAILURE_REPORTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let (source, line, column) = info.location().map_or((0, 0, 0), |location| {
            let file = location.file().replace('\\', "/");
            let sources = [
                "examples/local-ai-native-proof.rs",
                "src/local_ai/job_windows.rs",
                "src/local_ai/process.rs",
                "src/local_ai/guardian_macos.rs",
                "src/local_ai/socket.rs",
                "src/local_ai/proxy.rs",
                "src/local_ai/state.rs",
            ];
            let source = sources
                .iter()
                .position(|suffix| file.ends_with(suffix))
                .map_or(0, |i| i + 1);
            (source, location.line(), location.column())
        });
        #[cfg(windows)]
        let (windows_stage, windows_code) =
            if (3..=7).contains(&FAILURE_PHASE.load(Ordering::SeqCst)) {
                tesina_lib::local_ai::proof_startup_snapshot()
            } else {
                (0, 0)
            };
        #[cfg(not(windows))]
        let (windows_stage, windows_code) = (0, 0);
        let bind_code = if FAKE_BIND_HAS_CODE.load(Ordering::SeqCst) {
            FAKE_BIND_CODE.load(Ordering::SeqCst).to_string()
        } else {
            "null".to_owned()
        };
        let _ = writeln!(std::io::stderr().lock(),
            "{{\"proof\":\"local-ai-native-panic-v1\",\"phase\":{},\"source\":{source},\"line\":{line},\"column\":{column},\"result\":{},\"childStarted\":{},\"fixtureMarker\":{},\"windowsStage\":{windows_stage},\"windowsCode\":{windows_code},\"fakeBind\":{},\"fakeBindCode\":{bind_code}}}",
            FAILURE_PHASE.load(Ordering::SeqCst), FAILURE_RESULT.load(Ordering::SeqCst),
            CHILD_STARTED.load(Ordering::SeqCst), FIXTURE_MARKER.load(Ordering::SeqCst), FAKE_BIND.load(Ordering::SeqCst));
    }));
}

#[cfg(target_os = "macos")]
fn prelaunch_parent() {
    use std::os::fd::FromRawFd;
    for fd in [3, 4, 5] {
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    let control = unsafe { std::os::unix::net::UnixStream::from_raw_fd(3) };
    let _sole_writer = unsafe { std::fs::File::from_raw_fd(4) };
    let read = unsafe { std::fs::File::from_raw_fd(5) };
    let guardian = spawn_guardian_fixture(&control, &read, 0);
    let fixture = PathBuf::from(std::env::args_os().nth(2).unwrap());
    std::fs::write(
        fixture.join("prelaunch.json"),
        json!({"guardian":guardian.0.id()}).to_string(),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(15));
}

#[cfg(target_os = "macos")]
async fn guardian_prelaunch_death() {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let fixture = tempfile::tempdir().unwrap();
    let (mut control, child_control) = std::os::unix::net::UnixStream::pair().unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let (read, write) = owned_pipe();
    let fds = [
        child_control.as_raw_fd(),
        write.as_raw_fd(),
        read.as_raw_fd(),
    ];
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--prelaunch-parent")
        .arg(fixture.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            let copies = fds.map(|fd| libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10));
            for (index, fd) in copies.into_iter().enumerate() {
                if fd < 0 || libc::dup2(fd, 3 + index as i32) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            for fd in copies {
                libc::close(fd);
            }
            Ok(())
        });
    }
    let mut parent = ProofProcess(command.spawn().unwrap());
    let mut sentinel = ProofProcess(
        Command::new("/bin/sleep")
            .arg("15")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let started_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    drop(child_control);
    drop(read);
    drop(write);
    let guardian = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(file) = std::fs::File::open(fixture.path().join("prelaunch.json")) {
                let mut bytes = vec![];
                file.take(513).read_to_end(&mut bytes).unwrap();
                assert!(bytes.len() <= 512);
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    break u32::try_from(value["guardian"].as_u64().unwrap()).unwrap();
                }
            }
            assert!(parent.0.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(guardian > 1 && parent.0.try_wait().unwrap().is_none());
    assert_eq!(unsafe { libc::kill(guardian as i32, 0) }, 0);
    control.set_nonblocking(true).unwrap();
    assert!(
        matches!(control.read(&mut [0]),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "guardian already acknowledged or closed before parent death"
    );
    let started = Instant::now();
    parent.0.kill().unwrap(); // Authorized crash of this exact owned application parent.
    loop {
        let parent_done = parent.0.try_wait().unwrap().is_some();
        if parent_done && unsafe { libc::kill(guardian as i32, 0) } != 0 {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "prelaunch guardian survived parent death"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    control.set_nonblocking(false).unwrap();
    let mut ack = vec![];
    control.take(5).read_to_end(&mut ack).unwrap();
    assert!(ack.is_empty() && !fixture.path().join("launch-attempted").exists());
    assert!(sentinel.0.try_wait().unwrap().is_none());
    if std::env::args().nth(2).as_deref() == Some("--guardian-only") {
        println!("guardian-proof: parent={} guardian={guardian} sentinel={} started-unix-ms={started_unix_ms} exit-ms={} ack-bytes=0",parent.0.id(),sentinel.0.id(),started.elapsed().as_millis());
    }
}

#[cfg(target_os = "macos")]
fn spawn_guardian_fixture(
    control: &std::os::unix::net::UnixStream,
    lifeline: &std::fs::File,
    invalid: u8,
) -> ProofProcess {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let c = control.as_raw_fd();
    let l = lifeline.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--tesina-local-ai-guardian")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            let a = libc::fcntl(c, libc::F_DUPFD_CLOEXEC, 10);
            let b = libc::fcntl(l, libc::F_DUPFD_CLOEXEC, 10);
            if a < 0
                || b < 0
                || libc::dup2(if invalid == 3 { b } else { a }, 3) < 0
                || libc::dup2(if invalid == 4 { a } else { b }, 4) < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(a);
            libc::close(b);
            Ok(())
        });
    }
    ProofProcess(command.spawn().unwrap())
}

#[cfg(target_os = "macos")]
fn owned_pipe() -> (std::fs::File, std::fs::File) {
    use std::os::fd::FromRawFd;
    let mut fds = [-1; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    for fd in fds {
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    unsafe {
        (
            std::fs::File::from_raw_fd(fds[0]),
            std::fs::File::from_raw_fd(fds[1]),
        )
    }
}

#[cfg(target_os = "macos")]
async fn guardian_controls(executable: &std::path::Path) {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let fixture = tempfile::tempdir().unwrap();
    let copied = fixture.path().join("owned-fake");
    std::fs::copy(executable, &copied).unwrap();
    let model = fixture.path().join("launch-integrity.gguf");
    std::fs::write(&model, b"synthetic fixture").unwrap();
    let artifact = |path: &std::path::Path| {
        let path = path.canonicalize().unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        let mut digest = Sha256::new();
        let mut bytes = [0; 8192];
        loop {
            let n = file.read(&mut bytes).unwrap();
            if n == 0 {
                break;
            }
            digest.update(&bytes[..n]);
        }
        json!({"root":path.parent().unwrap(),"path":path,"digest":format!("{:x}",digest.finalize())})
    };
    let envelope = json!({"parent":std::process::id(),"launch":{"executable":artifact(&copied),"model":artifact(&model)},"key":"1".repeat(64)});
    for case in [
        "valid",
        "invalid-control-fd",
        "invalid-lifeline-fd",
        "oversized",
        "unknown-field",
        "lifeline-eof",
    ] {
        if fixture.path().join("launch-attempted").exists() {
            std::fs::remove_file(fixture.path().join("launch-attempted")).unwrap();
        }
        let (mut control, child_control) = std::os::unix::net::UnixStream::pair().unwrap();
        control
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        control
            .set_write_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let (read, write) = owned_pipe();
        let invalid = if case == "invalid-control-fd" {
            3
        } else if case == "invalid-lifeline-fd" {
            4
        } else {
            0
        };
        let mut guardian = spawn_guardian_fixture(&child_control, &read, invalid);
        let started_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let mut fake_pid = None;
        drop(child_control);
        drop(read);
        let mut write = Some(write);
        if case == "lifeline-eof" {
            write.take();
        }
        let mut start = envelope.clone();
        if case == "unknown-field" {
            start["extra"] = json!(true);
        }
        let bytes = serde_json::to_vec(&start).unwrap();
        assert!(bytes.len() <= 8192);
        let length = if case == "oversized" {
            8193
        } else {
            bytes.len() as u32
        };
        let _ = control.write_all(&length.to_be_bytes());
        if case != "oversized" {
            let _ = control.write_all(&bytes);
        }
        if case == "valid" {
            let mut ack = [0; 4];
            control.read_exact(&mut ack).unwrap();
            assert!(u32::from_be_bytes(ack) > 0);
            fake_pid = Some(u32::from_be_bytes(ack));
            let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while !fixture.path().join("launch-attempted").exists()
                && std::time::Instant::now() < until
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(
                fixture.path().join("launch-attempted").exists(),
                "independent valid guardian envelope must launch fake"
            );
            write.take();
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while guardian.0.try_wait().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < until,
                "guardian cleanup deadline"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        if let Some(pid) = fake_pid {
            assert_ne!(
                unsafe { libc::kill(pid as i32, 0) },
                0,
                "positive guardian left its fake alive"
            );
        }
        if case != "valid" {
            let mut ack = vec![];
            let _ = control.take(5).read_to_end(&mut ack);
            assert!(
                ack.is_empty(),
                "rejected control produced a PID acknowledgement: {case}"
            );
            assert!(
                !fixture.path().join("launch-attempted").exists(),
                "rejected control executed fake: {case}"
            );
        }
        if std::env::args().nth(2).as_deref() == Some("--guardian-only") {
            println!("guardian-control: case={case} guardian={} fake={} started-unix-ms={started_unix_ms}",guardian.0.id(),fake_pid.unwrap_or(0));
        }
    }
}

const POISON_NAMES: &[&str] = &[
    "LLAMA_ARG_MODEL",
    "LLAMA_ARG_HOST",
    "LLAMA_ARG_PORT",
    "LLAMA_ARG_CTX_SIZE",
    "LLAMA_CACHE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "XDG_CONFIG_HOME",
    "LD_PRELOAD",
];

#[cfg(target_os = "macos")]
async fn launch_environment(executable: &std::path::Path) {
    use std::process::{Command, Stdio};
    let fixture = tempfile::tempdir().unwrap();
    let model = fixture.path().join("launch-environment.gguf");
    std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .current_dir(std::env::current_dir().unwrap())
        .arg("--environment-service")
        .arg(executable)
        .arg(&model)
        .env_clear()
        .env("LLAMA_API_KEY", "f".repeat(64))
        .env("DYLD_LIBRARY_PATH", fixture.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for name in POISON_NAMES {
        command.env(name, "LT05_SYNTHETIC_POISON");
    }
    let mut parent = ProofProcess(command.spawn().unwrap());
    let started_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = parent.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < until,
            "owned environment parent deadline"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert!(status.success(), "poisoned native parent proof failed");
    use std::io::Read;
    let mut bytes = vec![];
    std::fs::File::open(fixture.path().join("environment-verified.json"))
        .expect("fake environment acknowledgement missing")
        .take(513)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 512);
    let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(result["isolated"] == true && result["fixedArguments"] == true);
    if std::env::args().nth(2).as_deref() == Some("--launch-only") {
        println!("launch-proof: parent={} isolated-parent={} fake={} started-unix-ms={started_unix_ms} verified-poison-count=13", std::process::id(), parent.0.id(), result["pid"]);
    }
}

fn result_category(result: &serde_json::Value) -> u8 {
    match (result["status"].as_str(), result["error"].as_str()) {
        (Some("ok"), _) => 1,
        (Some("error"), Some(code)) => [
            "unsupported-platform",
            "unsupported-hardware",
            "sidecar-absent",
            "not-installed",
            "busy",
            "cancelled",
            "invalid-request",
            "invalid-response",
            "startup-failed",
            "timeout",
            "out-of-memory",
            "crash",
            "shutting-down",
        ]
        .iter()
        .position(|known| *known == code)
        .map_or(15, |i| i as u8 + 2),
        _ => 15,
    }
}

async fn launch_integrity(executable: &std::path::Path) {
    FAILURE_PHASE.store(3, Ordering::SeqCst);
    let fixture = tempfile::tempdir().unwrap();
    let copied = fixture.path().join("owned-fake");
    std::fs::copy(executable, &copied).unwrap();
    let model = fixture.path().join("launch-integrity.gguf");
    std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
    let service = tesina_lib::local_ai::proof_service(copied, model).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({"requestId":id,"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}});
    FAILURE_PHASE.store(4, Ordering::SeqCst);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), service.run(request))
        .await
        .unwrap()
        .unwrap();
    FAILURE_RESULT.store(result_category(&result), Ordering::SeqCst);
    // Retained proof PID witnesses a successful start, not current liveness.
    CHILD_STARTED.store(service.proof_child_pid().is_some(), Ordering::SeqCst);
    FIXTURE_MARKER.store(
        fixture.path().join("launch-attempted").exists(),
        Ordering::SeqCst,
    );
    FAILURE_PHASE.store(5, Ordering::SeqCst);
    capture_fake_bind(fixture.path());
    service.prepare_shutdown().await.unwrap();
    FAILURE_PHASE.store(6, Ordering::SeqCst);
    assert_eq!(
        result,
        json!({"requestId":id,"documentRevision":7,"task":"writingCoach","status":"ok","output":{"issues":[]}})
    );
    FAILURE_PHASE.store(7, Ordering::SeqCst);
    assert!(
        fixture.path().join("launch-attempted").exists(),
        "copied fake must attest actual execution"
    );
    assert_eq!(
        FAKE_BIND.load(Ordering::SeqCst),
        1,
        "fixed fake bind witness required"
    );
    FAKE_BIND.store(0, Ordering::SeqCst);
    FAKE_BIND_HAS_CODE.store(false, Ordering::SeqCst);
    FAILURE_RESULT.store(0, Ordering::SeqCst);
    CHILD_STARTED.store(false, Ordering::SeqCst);
    FIXTURE_MARKER.store(false, Ordering::SeqCst);
    for mutation in [
        "missing-executable",
        "tampered-executable",
        "missing-model",
        "tampered-model",
        "symlink-executable",
        "symlink-model",
    ] {
        #[cfg(not(unix))]
        if mutation.starts_with("symlink") {
            continue;
        }
        FAILURE_PHASE.store(8, Ordering::SeqCst);
        let fixture = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let copied = fixture.path().join("owned-fake");
        std::fs::copy(executable, &copied).unwrap();
        let model = fixture.path().join("launch-integrity.gguf");
        std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
        let service = tesina_lib::local_ai::proof_service(copied.clone(), model.clone()).unwrap();
        let target = if mutation.ends_with("executable") {
            &copied
        } else {
            &model
        };
        if mutation.starts_with("missing") {
            std::fs::remove_file(target).unwrap();
        } else if mutation.starts_with("tampered") {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .append(true)
                .open(target)
                .unwrap()
                .write_all(b"changed")
                .unwrap();
        } else {
            #[cfg(unix)]
            {
                let escaped = outside.path().join("same-bytes");
                std::fs::rename(target, &escaped).unwrap();
                std::os::unix::fs::symlink(escaped, target).unwrap();
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        FAILURE_PHASE.store(9, Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), service.run(json!({"requestId":id,"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}}))).await.unwrap().unwrap();
        FAILURE_PHASE.store(10, Ordering::SeqCst);
        service.prepare_shutdown().await.unwrap();
        FAILURE_PHASE.store(11, Ordering::SeqCst);
        assert_eq!(
            result,
            json!({"requestId":id,"documentRevision":7,"task":"writingCoach","status":"error","error":"startup-failed"}),
            "artifact mutation: {mutation}"
        );
        assert!(
            service.proof_child_pid().is_none(),
            "tampered artifact launched a child: {mutation}"
        );
        assert!(
            !fixture.path().join("launch-attempted").exists(),
            "tampered artifact executed: {mutation}"
        );
    }
    FAILURE_PHASE.store(0, Ordering::SeqCst);
    FAILURE_RESULT.store(0, Ordering::SeqCst);
    CHILD_STARTED.store(false, Ordering::SeqCst);
    FIXTURE_MARKER.store(false, Ordering::SeqCst);
}

async fn crash_and_explicit_retry(executable: PathBuf) {
    use std::time::{Duration, Instant};
    let fixture = tempfile::tempdir().unwrap();
    let model = fixture.path().join("crash.gguf");
    std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
    let service = tesina_lib::local_ai::proof_service(executable, model).unwrap();
    let request = |id: String, text: &str| json!({"requestId":id,"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":text}}});
    let id = uuid::Uuid::new_v4().to_string();
    let run_service = service.clone();
    let first = request(id.clone(), "FAILED_SOURCE");
    let pending = tokio::spawn(async move { run_service.run(first).await });
    let admitted = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(file) = std::fs::File::open(fixture.path().join("crash-admitted.json")) {
                use std::io::Read;
                let mut bytes = vec![];
                file.take(513).read_to_end(&mut bytes).unwrap();
                assert!(bytes.len() <= 512);
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    break value;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if admitted.is_err() {
        service.prepare_shutdown().await.unwrap();
        panic!("authenticated crash admission acknowledgement missing");
    }
    let admitted = admitted.unwrap();
    assert_eq!(
        admitted["pid"].as_u64(),
        service.proof_child_pid().map(u64::from)
    );
    let started = Instant::now();
    std::fs::write(fixture.path().join("release-crash"), b"release").unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    FAILURE_RESULT.store(result_category(&result), Ordering::SeqCst);
    service.prepare_shutdown().await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    #[cfg(target_os = "macos")]
    assert_ne!(
        unsafe { libc::kill(admitted["pid"].as_u64().unwrap() as i32, 0) },
        0
    );
    assert_eq!(
        result,
        json!({"requestId":id,"documentRevision":7,"task":"writingCoach","status":"error","error":"crash"})
    );
    FAILURE_RESULT.store(0, Ordering::SeqCst);
    assert!(service.shutdown_ready());
    service.resume().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("generation-starts"))
            .unwrap()
            .lines()
            .count(),
        1,
        "failed source was automatically replayed"
    );
    std::fs::write(fixture.path().join("allow-retry"), b"retry").unwrap();
    let next_id = uuid::Uuid::new_v4().to_string();
    let next = tokio::time::timeout(
        Duration::from_secs(5),
        service.run(request(next_id.clone(), "FRESH_SOURCE")),
    )
    .await
    .unwrap()
    .unwrap();
    service.prepare_shutdown().await.unwrap();
    assert_eq!(
        next,
        json!({"requestId":next_id,"documentRevision":7,"task":"writingCoach","status":"ok","output":{"issues":[]}})
    );
    assert_ne!(
        admitted["pid"].as_u64(),
        service.proof_child_pid().map(u64::from)
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("generation-starts"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    let fresh_pid = service.proof_child_pid().unwrap();
    service.resume().unwrap();
    std::fs::write(fixture.path().join("live-malformed"), b"malformed").unwrap();
    let live_id = uuid::Uuid::new_v4().to_string();
    let live = tokio::time::timeout(
        Duration::from_secs(5),
        service.run(request(live_id.clone(), "FRESH_SOURCE")),
    )
    .await
    .unwrap()
    .unwrap();
    service.prepare_shutdown().await.unwrap();
    assert_eq!(
        live,
        json!({"requestId":live_id,"documentRevision":7,"task":"writingCoach","status":"error","error":"invalid-response"})
    );
    if std::env::args().nth(2).as_deref() == Some("--crash-only") {
        println!("crash-proof: owned parent={} crashed={} retry={} live-malformed={} cleanup-under-5s=true", std::process::id(), admitted["pid"], fresh_pid, service.proof_child_pid().unwrap());
    }
}

#[cfg(target_os = "macos")]
struct ProofProcess(std::process::Child);
#[cfg(target_os = "macos")]
impl Drop for ProofProcess {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(None)) {
            return;
        }
        // This exact Child was spawned here and remains unreaped while signalled.
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGTERM);
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < until && matches!(self.0.try_wait(), Ok(None)) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < until && matches!(self.0.try_wait(), Ok(None)) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            self.0.try_wait().unwrap().is_some(),
            "owned proof cleanup deadline"
        );
    }
}

#[cfg(target_os = "macos")]
async fn parent_death_phases(executable: &std::path::Path) {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    for scenario in ["loading", "read-generation"] {
        let fixture = tempfile::tempdir().unwrap();
        let model = fixture.path().join(format!("{scenario}.gguf"));
        std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
        let proof = std::env::current_exe().unwrap();
        let cwd = std::env::current_dir().unwrap();
        let mut parent = ProofProcess(
            Command::new(&proof)
                .arg("--owned-service")
                .arg(executable)
                .arg(&model)
                .current_dir(&cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut sentinel = ProofProcess(
            Command::new("/bin/sleep")
                .arg("30")
                .current_dir(&cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let started_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        if std::env::args().nth(2).as_deref() == Some("--death-only") {
            println!("parent-death-owned: phase={scenario} parent={} sentinel={} started_unix_ms={started_unix_ms} executable={} args=--owned-service,{},{} cwd={}", parent.0.id(), sentinel.0.id(), proof.display(), executable.display(), model.display(), cwd.display());
        }
        let phase = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(file) = std::fs::File::open(fixture.path().join("death-phase.json")) {
                    use std::io::Read;
                    let mut bytes = vec![];
                    file.take(513).read_to_end(&mut bytes).unwrap();
                    assert!(bytes.len() <= 512, "bounded phase metadata");
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        break value;
                    }
                }
                assert!(
                    parent.0.try_wait().unwrap().is_none(),
                    "owned service exited before phase acknowledgement"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual service phase acknowledgement deadline");
        assert_eq!(phase["phase"], scenario);
        let fake = u32::try_from(phase["pid"].as_u64().unwrap()).unwrap();
        let guardian = u32::try_from(phase["guardian"].as_u64().unwrap()).unwrap();
        assert!(fake > 1 && guardian > 1 && fake != guardian);
        assert!(parent.0.try_wait().unwrap().is_none());
        assert_eq!(unsafe { libc::kill(fake as i32, 0) }, 0);
        assert_eq!(unsafe { libc::kill(guardian as i32, 0) }, 0);
        let started = Instant::now();
        parent.0.kill().unwrap(); // Intentional forced application-parent death scenario.
        while started.elapsed() < Duration::from_secs(5) {
            let parent_done = parent.0.try_wait().unwrap().is_some();
            let fake_done = unsafe { libc::kill(fake as i32, 0) } != 0;
            let guardian_done = unsafe { libc::kill(guardian as i32, 0) } != 0;
            if parent_done && fake_done && guardian_done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "owned service descendants survived parent-death deadline"
        );
        assert!(sentinel.0.try_wait().unwrap().is_none());
        println!(
            "{}",
            json!({"proof":"parent-death-v1","phase":scenario,"parentPid":parent.0.id(),"sentinelPid":sentinel.0.id(),"fakePid":fake,"guardianPid":guardian,"startedUnixMs":started_unix_ms,"elapsedMs":started.elapsed().as_millis(),"passed":true})
        );
    }
}

async fn read_generation_cancellation(executable: PathBuf) {
    use std::time::{Duration, Instant};
    let fixture = tempfile::tempdir().unwrap();
    let model = fixture.path().join("read-generation.gguf");
    std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
    let service = tesina_lib::local_ai::proof_service(executable, model).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({"requestId":id,"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"SOURCE_CANARY"}}});
    let duplicate = request.clone();
    let run_service = service.clone();
    let mut pending = tokio::spawn(async move { run_service.run(request).await });
    let marker = fixture.path().join("completion-admitted.json");
    let admission = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(bytes) = std::fs::read(&marker) {
                if bytes.len() <= 4096 {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        break value;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if admission.is_err() {
        service.prepare_shutdown().await.unwrap();
        let _ = pending.await;
        panic!("fake did not acknowledge authenticated completion admission");
    }
    let admission = admission.unwrap();
    assert_eq!(
        admission["pid"].as_u64(),
        service.proof_child_pid().map(u64::from)
    );
    service.cancel(uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut pending)
            .await
            .is_err(),
        "foreign cancellation affected completion read"
    );
    let cancelled_at = Instant::now();
    service.cancel(id.clone()).unwrap();
    let result = tokio::time::timeout(Duration::from_millis(500), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        result
            == json!({"requestId":id,"documentRevision":7,"task":"writingCoach","status":"error","error":"cancelled"}),
        "matching cancellation must return exactly the fixed correlated terminal"
    );
    service.prepare_shutdown().await.unwrap();
    assert!(cancelled_at.elapsed() < Duration::from_secs(5));
    assert!(service.shutdown_ready());
    #[cfg(target_os = "macos")]
    assert_ne!(
        unsafe { libc::kill(admission["pid"].as_u64().unwrap() as i32, 0) },
        0,
        "cancelled fake remained alive after cleanup"
    );
    assert!(
        admission["keyDigest"]
            .as_str()
            .is_some_and(|s| s.len() == 64),
        "fixture must attest the generation key without disclosing it"
    );
    assert!(
        admission["outputAttempted"] == true,
        "fake must actually attempt source/generated/path/key output"
    );
    let starts = fixture.path().join("generation-starts");
    assert_eq!(std::fs::read_to_string(&starts).unwrap().lines().count(), 1);
    std::fs::remove_file(&marker).unwrap();
    service.resume().unwrap();
    service.cancel(id).unwrap();
    assert!(
        service.run(duplicate).await.unwrap()["error"] == "busy",
        "completed ID produced another generation after duplicate cancellation"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !marker.exists(),
        "cleanup/resume automatically restarted a generation"
    );
    assert_eq!(
        std::fs::read_to_string(&starts).unwrap().lines().count(),
        1,
        "cleanup/resume launched another process"
    );
    let next_id = uuid::Uuid::new_v4().to_string();
    let request = json!({"requestId":next_id,"sourceSnapshotId":"s","task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"SOURCE_CANARY"}}});
    let run_service = service.clone();
    let pending = tokio::spawn(async move { run_service.run(request).await });
    let next = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(bytes) = std::fs::read(&marker) {
                if bytes.len() <= 4096 {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        break value;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if next.is_err() {
        service.prepare_shutdown().await.unwrap();
        let _ = pending.await;
        panic!("next explicit request did not reach completion");
    }
    let next = next.unwrap();
    assert!(
        next["pid"] != admission["pid"],
        "next explicit request reused its child"
    );
    assert!(
        next["keyDigest"].as_str().is_some_and(|s| s.len() == 64)
            && next["keyDigest"] != admission["keyDigest"],
        "next explicit generation reused its secret"
    );
    assert_eq!(std::fs::read_to_string(&starts).unwrap().lines().count(), 2);
    std::fs::write(fixture.path().join("release-completion"), b"release").unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        result
            == json!({"requestId":next_id,"sourceSnapshotId":"s","task":"writingCoach","status":"error","error":"invalid-response"}),
        "malformed canary response crossed fixed error boundary"
    );
    service.prepare_shutdown().await.unwrap();
}

fn main() {
    diagnostic_hook();
    if tesina_lib::local_ai::guardian_entry() {
        return;
    }
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("--prelaunch-parent") {
        prelaunch_parent();
        return;
    }
    FAILURE_PHASE.store(1, Ordering::SeqCst);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        FAILURE_PHASE.store(2, Ordering::SeqCst);
        if std::env::args().nth(1).as_deref() == Some("--environment-service") {
            let executable = PathBuf::from(std::env::args_os().nth(2).unwrap());
            let model = PathBuf::from(std::env::args_os().nth(3).unwrap());
            for name in POISON_NAMES { assert!(std::env::var(name).as_deref() == Ok("LT05_SYNTHETIC_POISON")); }
            assert!(std::env::var("LLAMA_API_KEY").unwrap() == "f".repeat(64));
            assert!(std::env::var_os("DYLD_LIBRARY_PATH").as_deref() == model.parent().map(|p| p.as_os_str()));
            let service = tesina_lib::local_ai::proof_service(executable, model).unwrap();
            let result = service.run(json!({"requestId":uuid::Uuid::new_v4().to_string(),"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}})).await.unwrap();
            service.prepare_shutdown().await.unwrap();
            assert!(result["status"] == "ok");
            return;
        }
        if std::env::args().nth(1).as_deref() == Some("--owned-service") {
            let executable = PathBuf::from(std::env::args_os().nth(2).unwrap());
            let model = PathBuf::from(std::env::args_os().nth(3).unwrap());
            let service = tesina_lib::local_ai::proof_service(executable, model).unwrap();
            let request = json!({"requestId":uuid::Uuid::new_v4().to_string(),"documentRevision":1,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"SOURCE_CANARY"}}});
            let _ = service.run(request).await;
            service.prepare_shutdown().await.unwrap();
            return;
        }
        let executable = PathBuf::from(std::env::args_os().nth(1).expect("fixed fake executable required"));
        #[cfg(target_os = "macos")]
        if std::env::args().nth(2).as_deref() == Some("--guardian-only") {
            guardian_controls(&executable).await;
            guardian_prelaunch_death().await;
            println!("local-ai-native-proof: guardian prelaunch controls passed");
            return;
        }
        if std::env::args().nth(2).as_deref() == Some("--launch-only") {
            launch_integrity(&executable).await;
            #[cfg(target_os = "macos")]
            launch_environment(&executable).await;
            println!("local-ai-native-proof: fixed launch integrity and environment passed");
            return;
        }
        if std::env::args().nth(2).as_deref() == Some("--crash-only") {
            crash_and_explicit_retry(executable).await;
            println!("local-ai-native-proof: synchronized child crash and explicit retry passed");
            return;
        }
        #[cfg(target_os = "macos")]
        if std::env::args().nth(2).as_deref() == Some("--death-only") {
            parent_death_phases(&executable).await;
            println!("local-ai-native-proof: actual service parent-death phases passed");
            return;
        }
        if std::env::args().nth(2).as_deref() == Some("--generation-only") {
            read_generation_cancellation(executable).await;
            println!("local-ai-native-proof: synchronized completion-read cancellation passed");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("success.gguf");
        std::fs::write(&model, b"synthetic fixture, not model weights").unwrap();
        let service = tesina_lib::local_ai::proof_service(executable.clone(), model.clone()).unwrap();
        let tasks_only = std::env::args().nth(2).as_deref() == Some("--tasks-only");
        if !tasks_only {
        #[cfg(target_os = "macos")]
        {guardian_controls(&executable).await;guardian_prelaunch_death().await;}
        launch_integrity(&executable).await;
        #[cfg(target_os = "macos")]
        launch_environment(&executable).await;
        crash_and_explicit_retry(executable.clone()).await;
        read_generation_cancellation(executable.clone()).await;
        {
            use std::io::{Read, Write};
            let mut child = tesina_lib::local_ai::proof_child(executable.clone(), model.clone()).unwrap();
            let ready_by = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let port = loop {
                if let Some(port) = tesina_lib::local_ai::proof_listener(&mut child).unwrap() { break port; }
                assert!(std::time::Instant::now() < ready_by, "fake readiness deadline");
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            for (method, path, expected) in [("GET", "/health", 200), ("OPTIONS", "/completion", 200), ("GET", "/v1/models", 401), ("POST", "/tokenize", 401), ("POST", "/completion", 401), ("GET", "/", 401), ("GET", "/props", 401), ("POST", "/models/load", 401), ("POST", "/models/unload", 401), ("GET", "/mcp", 401)] {
                let mut stream = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(1))).unwrap();
                stream.set_write_timeout(Some(std::time::Duration::from_secs(1))).unwrap();
                write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
                let mut response = String::new();
                stream.take(16 * 1024).read_to_string(&mut response).unwrap();
                assert!(response.starts_with(&format!("HTTP/1.1 {expected} ")), "fixed unauthorized probe failed: {path}");
                let body = response.split("\r\n\r\n").nth(1).unwrap();
                assert_eq!(body, if expected == 200 { "{\"status\":\"ok\"}" } else { "{}" });
            }
            child.stop().unwrap();
        }
        let over_context = service.run(json!({"requestId":uuid::Uuid::new_v4().to_string(),"documentRevision":1,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"x".repeat(2048)}}})).await.unwrap();
        assert_eq!(over_context["error"], "invalid-request", "over2047 tokenized prompt must not generate a draft");
        service.prepare_shutdown().await.unwrap();
        service.resume().unwrap();
        if std::env::args().nth(2).as_deref() == Some("--protocol-only") { println!("local-ai-native-proof: ten independent unauthorized/public probes and context cap passed"); return; }
        for scenario in ["smuggling", "framing-lf", "framing-mixed", "framing-reversed", "framing-duplicate-cl", "framing-duplicate-te", "framing-interim", "framing-header-cap", "framing-comma-cl", "framing-trailer", "framing-valid-chunked"] {
        let smuggling_model = temp.path().join(format!("{scenario}.gguf"));
        std::fs::write(&smuggling_model, b"synthetic fixture").unwrap();
        let smuggling = tesina_lib::local_ai::proof_service(executable.clone(), smuggling_model).unwrap();
        let result = smuggling.run(json!({"requestId":uuid::Uuid::new_v4().to_string(),"documentRevision":1,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}})).await.unwrap();
        smuggling.prepare_shutdown().await.unwrap();
        if scenario == "framing-valid-chunked" { assert_eq!(result["status"], "ok"); }
        else { assert_eq!(result["error"], "invalid-response", "hostile framing must never yield a draft: {scenario}"); }
        }
        if std::env::args().nth(2).as_deref() == Some("--framing-only") {
            println!("local-ai-native-proof: eleven real framing cases passed");
            return;
        }
        let delayed = tesina_lib::local_ai::proof_service_with_launch_delay(executable.clone(), model.clone(), 2000).unwrap();
        let delayed_id = uuid::Uuid::new_v4().to_string();
        let pending = delayed.run(json!({"requestId":delayed_id,"documentRevision":1,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}}));
        let cancellation = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            for _ in 0..31 { delayed.cancel(uuid::Uuid::new_v4().to_string()).unwrap(); }
            assert!(delayed.cancel(uuid::Uuid::new_v4().to_string()).is_err(), "full table must not evict the active record");
            delayed.cancel(delayed_id.clone()).unwrap();
            std::time::Instant::now()
        };
        let (result, cancelled_at) = tokio::join!(pending, cancellation);
        assert_eq!(result.unwrap()["error"], "cancelled");
        assert!(cancelled_at.elapsed() < std::time::Duration::from_millis(500), "cancellation must decide before blocking launch finishes");
        delayed.prepare_shutdown().await.unwrap();
        let loading_model = temp.path().join("loading.gguf");
        std::fs::write(&loading_model, b"synthetic fixture").unwrap();
        let loading = tesina_lib::local_ai::proof_service_with_startup_budget(executable.clone(), loading_model).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_millis(1500), loading.run(json!({"requestId":uuid::Uuid::new_v4().to_string(),"documentRevision":1,"task":"writingCoach","input":{"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"Fixture"}}}))).await;
        loading.prepare_shutdown().await.unwrap();
        assert!(loading.proof_child_pid().is_some(), "startup proof must reach the spawned loading fake");
        assert_eq!(result.expect("launch and readiness must share one startup budget").unwrap()["error"], "startup-failed");
        #[cfg(target_os = "macos")]
        {
            let failing_model = temp.path().join("guardian-fault.gguf");
            std::fs::write(&failing_model, b"synthetic fixture").unwrap();
            let mut child = tesina_lib::local_ai::proof_child(executable.clone(), failing_model).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
            let leaked = !child.alive() && unsafe { libc::kill(child.pid as i32, 0) } == 0;
            assert!(!leaked, "post-spawn guardian error left an orphan");
            let exited_model = temp.path().join("exit-before-listen.gguf");
            std::fs::write(&exited_model, b"synthetic fixture").unwrap();
            let mut child = tesina_lib::local_ai::proof_child(executable.clone(), exited_model).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(!child.alive(), "actual child exit must be visible to its parent owner");
            assert_eq!(unsafe { libc::kill(child.pid as i32, 0) }, 0, "exited child must remain unreaped until explicit generation cleanup");
            child.stop().unwrap();
            assert_ne!(unsafe { libc::kill(child.pid as i32, 0) }, 0);
        }
        }
        for (task, language, count) in [("writingCoach", "en", 5), ("writingCoach", "es", 5), ("groundedQuiz", "en", 5), ("groundedQuiz", "es", 10)] {
            let source = json!({"sourceId":"p","snapshotId":"s","text":"Árbol 🌱"});
            let input = if task == "writingCoach" { json!({"documentLanguage":language,"passage":source}) } else { json!({"documentLanguage":language,"sources":[source],"questionCount":count}) };
            let id = uuid::Uuid::new_v4().to_string();
            let result = service.run(json!({"requestId":id,"sourceSnapshotId":"s","task":task,"input":input})).await.unwrap();
            assert_eq!(result["status"], "ok", "only fixed error codes may be printed: {}", result["error"]);
            assert_eq!(result["requestId"], id);
            assert_eq!(result["sourceSnapshotId"], "s");
            if task == "groundedQuiz" { assert_eq!(result["output"]["questions"].as_array().unwrap().len(), count); }
            service.prepare_shutdown().await.unwrap();
            service.resume().unwrap();
        }
        if tasks_only { println!("local-ai-native-proof: four native task schema cases passed"); return; }
        #[cfg(target_os = "macos")]
        parent_death_phases(&executable).await;
        println!("local-ai-native-proof: both task shapes and both languages passed; webview/platform matrix pending");
    });
}
