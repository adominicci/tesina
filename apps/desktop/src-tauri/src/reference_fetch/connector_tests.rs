use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn real_connector_pins_hostname_and_sends_only_fixed_reference_get() {
    for (kind, accept) in [
        (Kind::Json, "application/json"),
        (Kind::Html, "text/html,application/xhtml+xml"),
    ] {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let url = Url::parse("http://reference-proof.invalid/paper?q=1").unwrap();
        let server = async {
            let (mut stream, peer) = origin.accept().await.unwrap();
            assert!(peer.ip().is_loopback());
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                assert!(header.len() < 8192, "request header exceeded fixture bound");
                header.push(stream.read_u8().await.unwrap());
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\npinnedOK",
                )
                .await
                .unwrap();
            let extra = stream.read_u8().await;
            assert!(extra.is_err(), "GET unexpectedly sent a body");
            String::from_utf8(header).unwrap()
        };
        let client = async {
            let response = NativeNetwork
                .get(
                    &url,
                    &[address],
                    &kind,
                    Instant::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200);
            assert_eq!(response.url().host_str(), Some("reference-proof.invalid"));
            assert_eq!(response.text().await.unwrap(), "pinnedOK");
        };
        let (header, ()) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client)
        })
        .await
        .expect("owned request/accept/read deadline");
        let mut lines = header.split("\r\n");
        assert_eq!(lines.next(), Some("GET /paper?q=1 HTTP/1.1"));
        assert_eq!(lines.clone().filter(|s| !s.is_empty()).count(), 4);
        let fields: std::collections::BTreeMap<_, _> = lines
            .filter(|s| !s.is_empty())
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_ascii_lowercase(), value.trim().to_owned())
            })
            .collect();
        assert_eq!(
            fields,
            std::collections::BTreeMap::from([
                ("host".into(), "reference-proof.invalid".into()),
                (
                    "user-agent".into(),
                    "Tesina/0.1 (academic writing app)".into()
                ),
                ("accept".into(), accept.into()),
                ("accept-encoding".into(), "gzip, identity".into()),
            ])
        );
    }
}

#[tokio::test]
async fn real_connector_returns_redirect_without_contacting_its_target() {
    let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trap = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = origin.local_addr().unwrap();
    let location = format!("http://{}/redirect-trap", trap.local_addr().unwrap());
    let url = Url::parse("http://reference-proof.invalid/start").unwrap();
    let server = async {
        let (mut stream, _) = origin.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            assert!(header.len() < 8192);
            header.push(stream.read_u8().await.unwrap());
        }
        stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    };
    let trap_observation = async {
        match tokio::time::timeout(Duration::from_millis(500), trap.accept()).await {
            Err(_) => 0,
            Ok(Ok((mut stream, _))) => {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                1
            }
            Ok(Err(_)) => panic!("owned redirect trap failed"),
        }
    };
    let client = async {
        let response = NativeNetwork
            .get(
                &url,
                &[address],
                &Kind::Html,
                Instant::now() + Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        assert_eq!(response.headers()["location"], location);
    };
    let (_, connections, ()) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(server, trap_observation, client)
    })
    .await
    .expect("owned redirect fixture deadline");
    assert_eq!(connections, 0);
}

#[tokio::test]
async fn real_connector_ignores_proxy_environment_in_an_isolated_process() {
    const ORIGIN: &str = "TESINA_REFERENCE_CONNECTOR_TEST_ORIGIN";
    if let Some(origin) = std::env::var_os(ORIGIN) {
        let address: SocketAddr = origin.to_str().unwrap().parse().unwrap();
        assert!(address.ip().is_loopback());
        let url = Url::parse("http://reference-proof.invalid/proxy-check").unwrap();
        let response = NativeNetwork
            .get(
                &url,
                &[address],
                &Kind::Json,
                Instant::now() + Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "pinnedOK");
        return;
    }
    let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trap = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", trap.local_addr().unwrap());
    let cwd = std::env::current_dir().unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "reference_fetch::connector_tests::real_connector_ignores_proxy_environment_in_an_isolated_process"])
        .current_dir(&cwd).env(ORIGIN, origin.local_addr().unwrap().to_string())
        .env_remove("NO_PROXY").env_remove("no_proxy").env_remove("REQUEST_METHOD")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env(name, &proxy);
    }
    let mut child = command.spawn().unwrap();
    println!(
        "reference-connector-child pid={} started_unix_ms={} cwd={}",
        child.id().unwrap(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
        cwd.display()
    );
    let server = async {
        let accepted = tokio::time::timeout(Duration::from_secs(3), origin.accept()).await;
        let Ok(Ok((mut stream, _))) = accepted else {
            return false;
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                if header.len() >= 8192 {
                    return false;
                }
                let Ok(byte) = stream.read_u8().await else {
                    return false;
                };
                header.push(byte);
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\npinnedOK",
                )
                .await
                .is_ok()
        })
        .await
        .unwrap_or(false)
    };
    let trap_observation = async {
        match tokio::time::timeout(Duration::from_secs(3), trap.accept()).await {
            Err(_) => 0,
            Ok(Ok((mut stream, _))) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntrap",
                    ),
                )
                .await;
                1
            }
            Ok(Err(_)) => 1,
        }
    };
    let wait = async {
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => status.unwrap().success(),
            Err(_) => {
                #[cfg(target_os = "macos")]
                if let Some(pid) = child.id() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                if tokio::time::timeout(Duration::from_secs(1), child.wait())
                    .await
                    .is_err()
                {
                    child.start_kill().unwrap();
                    tokio::time::timeout(Duration::from_secs(1), child.wait())
                        .await
                        .expect("owned test process cleanup deadline")
                        .unwrap();
                }
                false
            }
        }
    };
    let (reached_origin, trap_connections, passed) = tokio::join!(server, trap_observation, wait);
    assert!(
        passed && reached_origin,
        "isolated real connector did not reach its pinned origin"
    );
    assert_eq!(trap_connections, 0);
}
