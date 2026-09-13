use super::*;
use std::process::{Child, Command, Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CHILD_TEST: &str = "local_ai::socket::process_tests::owned_socket_process_fixture";
struct Fixture {
    directory: tempfile::TempDir,
    children: Vec<(&'static str, Child)>,
}
impl Fixture {
    fn new() -> Self {
        Self {
            directory: tempfile::tempdir().unwrap(),
            children: vec![],
        }
    }
    fn spawn(&mut self, role: &'static str) -> u32 {
        let executable = std::env::current_exe().unwrap();
        let cwd = std::env::current_dir().unwrap();
        let child = Command::new(&executable)
            .args(["--ignored", "--exact", CHILD_TEST])
            .current_dir(&cwd)
            .env("TESINA_SOCKET_TEST_DIRECTORY", self.directory.path())
            .env("TESINA_SOCKET_TEST_ROLE", role)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        println!("owned-socket-child role={role} pid={pid} started_unix_ms={} executable={} args=--ignored,--exact,{CHILD_TEST} cwd={}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), executable.display(), cwd.display());
        self.children.push((role, child));
        pid
    }
    fn signal(&self, name: &str, bytes: &[u8]) {
        std::fs::write(self.directory.path().join(name), bytes).unwrap();
    }
    async fn record(&self, name: &str) -> String {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(bytes) = std::fs::read(self.directory.path().join(name)) {
                    assert!(bytes.len() <= 128);
                    if !bytes.is_empty() {
                        break String::from_utf8(bytes).unwrap();
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned socket fixture record deadline")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (role, _) in &self.children {
            let _ = std::fs::write(self.directory.path().join(format!("{role}.exit")), b"exit");
        }
        for (_, child) in &mut self.children {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while std::time::Instant::now() < until {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if matches!(child.try_wait(), Ok(None)) {
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
                let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
                while std::time::Instant::now() < until {
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.kill();
                }
            }
            let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while std::time::Instant::now() < until {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(
                child.try_wait().ok().flatten().is_some(),
                "owned fixture child cleanup deadline"
            );
        }
    }
}

#[tokio::test]
async fn protected_launchd_introspection_denial_rejects_before_any_peer_bytes() {
    unsafe extern "C" {
        fn tesina_tcp_rows(pid: i32, out: *mut Row, capacity: i32) -> i32;
    }
    // PID1 is macOS launchd. Read-only access must actually be denied on this
    // host; an unavailable denial is an explicit environment failure, not a skip.
    let mut output = [Row::default(); 256];
    let (count, errno) = unsafe {
        *libc::__error() = 0;
        let count = tesina_tcp_rows(1, output.as_mut_ptr(), output.len() as i32);
        (count, *libc::__error())
    };
    assert_eq!(
        count, -1,
        "environment must deny the actual launchd socket query"
    );
    assert_eq!(
        errno,
        libc::EPERM,
        "requires real EPERM, not a missing PID or empty table"
    );
    assert!(matches!(rows(1), Err(ErrorCode::StartupFailed)));

    let mut fixture = Fixture::new();
    let trap = fixture.spawn("competitor");
    let port: u16 = fixture.record("competitor.ready").await.parse().unwrap();
    assert_eq!(listener(trap).unwrap(), Some(port));
    let started = Instant::now();
    let result = connect(1, port, started + Duration::from_secs(1)).await;
    let denied = matches!(&result, Err(ErrorCode::StartupFailed));
    if let Ok(mut stream) = result {
        tokio::time::timeout(
            Duration::from_secs(1),
            stream.write_all(b"owned-stream-control"),
        )
        .await
        .unwrap()
        .unwrap();
    }
    let received = fixture.record("competitor.received-0").await;
    assert!(
        denied,
        "denied introspection must reject the connected stream"
    );
    assert_eq!(received.split_whitespace().last(), Some("0"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(listener(trap).unwrap(), Some(port));
}

#[tokio::test]
async fn separate_live_socket_owners_accept_only_the_exact_reverse_tuple() {
    let mut fixture = Fixture::new();
    let owner = fixture.spawn("owner");
    let port: u16 = fixture.record("owner.ready").await.parse().unwrap();
    let competitor = fixture.spawn("competitor");
    let other_port: u16 = fixture.record("competitor.ready").await.parse().unwrap();
    assert_eq!(listener(owner).unwrap(), Some(port));
    assert_eq!(listener(competitor).unwrap(), Some(other_port));
    let mut verified = connect(owner, port, Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    let local = verified.local_addr().unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        verified.write_all(b"owned-stream-control"),
    )
    .await
    .unwrap()
    .unwrap();
    drop(verified);
    assert_eq!(
        fixture.record("owner.received-0").await,
        format!("{local} 20")
    );
    let failed = connect(owner, other_port, Instant::now() + Duration::from_secs(1)).await;
    let rejected = matches!(&failed, Err(ErrorCode::StartupFailed));
    if let Ok(mut stream) = failed {
        tokio::time::timeout(
            Duration::from_secs(1),
            stream.write_all(b"owned-stream-control"),
        )
        .await
        .unwrap()
        .unwrap();
    }
    let received = fixture.record("competitor.received-0").await;
    assert!(
        rejected,
        "live competing process was accepted as the owned child"
    );
    assert_eq!(received.split_whitespace().last(), Some("0"));
    assert_eq!(listener(owner).unwrap(), Some(port));
    assert_eq!(listener(competitor).unwrap(), Some(other_port));
}

#[tokio::test]
#[ignore = "exact owned subprocess fixture"]
async fn owned_socket_process_fixture() {
    let directory =
        std::path::PathBuf::from(std::env::var_os("TESINA_SOCKET_TEST_DIRECTORY").unwrap());
    let role = std::env::var("TESINA_SOCKET_TEST_ROLE").unwrap();
    assert!(matches!(role.as_str(), "owner" | "competitor" | "sentinel"));
    let mut listener = if role == "sentinel" {
        None
    } else {
        Some(
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap(),
        )
    };
    std::fs::write(
        directory.join(format!("{role}.ready")),
        listener
            .as_ref()
            .map_or(0, |value| value.local_addr().unwrap().port())
            .to_string(),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    let mut connections = 0;
    let mut readers = Vec::new();
    let mut closed = false;
    let mut rebound = false;
    while Instant::now() < until && !directory.join(format!("{role}.exit")).exists() {
        if !closed && directory.join(format!("{role}.close")).exists() {
            listener.take();
            closed = true;
            std::fs::write(directory.join(format!("{role}.closed")), b"closed").unwrap();
        }
        if !rebound {
            if let Ok(value) = std::fs::read_to_string(directory.join(format!("{role}.rebind"))) {
                let port: u16 = value.parse().unwrap();
                listener.take();
                listener = Some(
                    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                        .await
                        .unwrap(),
                );
                rebound = true;
                std::fs::write(directory.join(format!("{role}.rebound")), port.to_string())
                    .unwrap();
            }
        }
        let Some(listener) = listener.as_ref() else {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        };
        tokio::select! {
            accepted = listener.accept() => {
                let (mut stream, peer) = accepted.unwrap();
                let output = directory.join(format!("{role}.received-{connections}"));
                connections += 1;
                assert!(connections <= 8, "owned fixture connection bound");
                readers.push(tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    tokio::time::timeout(Duration::from_secs(2), (&mut stream).take(64).read_to_end(&mut bytes)).await.unwrap().unwrap();
                    std::fs::write(output, format!("{peer} {}", bytes.len())).unwrap();
                }));
            }
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
    }
    for reader in readers {
        tokio::time::timeout(Duration::from_secs(3), reader)
            .await
            .unwrap()
            .unwrap();
    }
}

fn exited_without_reaping(pid: u32) -> bool {
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        },
        0
    );
    unsafe { info.si_pid() != 0 }
}

#[tokio::test]
async fn reused_listener_rejects_live_then_exited_unreaped_owner_without_bytes() {
    let mut fixture = Fixture::new();
    let owner = fixture.spawn("owner");
    let port: u16 = fixture.record("owner.ready").await.parse().unwrap();
    let competitor = fixture.spawn("competitor");
    fixture.record("competitor.ready").await;
    let sentinel = fixture.spawn("sentinel");
    fixture.record("sentinel.ready").await;
    assert_eq!(listener(sentinel).unwrap(), None);
    fixture.signal("owner.close", b"close");
    assert_eq!(fixture.record("owner.closed").await, "closed");
    assert!(!exited_without_reaping(owner));
    assert_eq!(listener(owner).unwrap(), None);
    fixture.signal("competitor.rebind", port.to_string().as_bytes());
    assert_eq!(fixture.record("competitor.rebound").await, port.to_string());
    assert_eq!(listener(competitor).unwrap(), Some(port));
    for index in 0..2 {
        if index == 1 {
            fixture.signal("owner.exit", b"exit");
            tokio::time::timeout(Duration::from_secs(2), async {
                while !exited_without_reaping(owner) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            // WNOWAIT and the retained Child reserve the exact original PID until cleanup.
            assert_eq!(unsafe { libc::kill(owner as i32, 0) }, 0);
            assert!(!matches!(listener(owner), Ok(Some(_))));
        }
        let started = Instant::now();
        let failed = connect(owner, port, started + Duration::from_secs(1)).await;
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "owned socket proof deadline"
        );
        let rejected = matches!(&failed, Err(ErrorCode::StartupFailed));
        if let Ok(mut stream) = failed {
            tokio::time::timeout(
                Duration::from_secs(1),
                stream.write_all(b"owned-stream-control"),
            )
            .await
            .unwrap()
            .unwrap();
        }
        let received = fixture
            .record(&format!("competitor.received-{index}"))
            .await;
        assert!(
            rejected,
            "rebound competitor was accepted as the original owner"
        );
        assert_eq!(received.split_whitespace().last(), Some("0"));
        assert_eq!(listener(competitor).unwrap(), Some(port));
        assert!(!exited_without_reaping(competitor));
        assert!(!exited_without_reaping(sentinel));
    }
}
