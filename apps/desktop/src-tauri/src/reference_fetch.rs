use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use tokio::time::{Duration, Instant};
use url::{Host, Url};
mod body;
#[cfg(test)]
mod connector_tests;
mod local_addresses;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FetchError {
    InvalidRequest,
    Unreadable,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Json,
    Html,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FetchRequest {
    url: String,
    kind: Kind,
}
#[derive(Serialize)]
pub struct FetchResult {
    status: u16,
    body: String,
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && b == 168)
                && !(a == 192 && b == 0 && matches!(c, 0 | 2))
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 192 && matches!((b, c), (31, 196) | (52, 193) | (175, 48)))
                && !(a == 198 && matches!(b, 18 | 19))
                && !(a == 198 && b == 51 && c == 100)
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Global unicast only; exclude transition, protocol, documentation and special allocations.
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && s[1] <= 0x1ff)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
                && !(s[0] == 0x2620 && s[1] == 0x4f && s[2] == 0x8000)
        }
    }
}
fn checked_url(raw: &str) -> Result<Url, FetchError> {
    if raw.len() > 4096 {
        return Err(FetchError::InvalidRequest);
    }
    let mut url = Url::parse(raw).map_err(|_| FetchError::InvalidRequest)?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(FetchError::InvalidRequest);
    }
    match url.host().ok_or(FetchError::InvalidRequest)? {
        Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if !lower.contains('.')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "test",
                    "invalid",
                    "onion",
                    "home.arpa",
                ]
                .iter()
                .any(|suffix| lower == *suffix || lower.ends_with(&format!(".{suffix}")))
            {
                return Err(FetchError::InvalidRequest);
            }
        }
        Host::Ipv4(ip) if !public_address(ip.into()) => return Err(FetchError::InvalidRequest),
        Host::Ipv6(ip) if !public_address(ip.into()) => return Err(FetchError::InvalidRequest),
        _ => {}
    }
    url.set_fragment(None);
    Ok(url)
}
fn validate_addresses(addresses: &[SocketAddr], local: &[IpAddr]) -> Result<(), FetchError> {
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses
            .iter()
            .any(|a| !public_address(a.ip()) || local.contains(&a.ip()))
    {
        return Err(FetchError::Unreadable);
    }
    Ok(())
}
fn reference_client(
    host: &str,
    addresses: &[SocketAddr],
    deadline: Instant,
) -> Result<reqwest::Client, FetchError> {
    // Citation fetching may precede updater initialization. Reuse its locked ring
    // provider; a concurrent install simply means the process already has one.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addresses)
        .timeout(deadline.saturating_duration_since(Instant::now()))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| FetchError::Unreadable)
}

#[tauri::command]
pub async fn reference_fetch(request: FetchRequest) -> Result<FetchResult, FetchError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    fetch(request, deadline).await
}
async fn fetch(request: FetchRequest, deadline: Instant) -> Result<FetchResult, FetchError> {
    fetch_with_network(request, deadline, &NativeNetwork).await
}
// Only OS DNS/interfaces and the HTTP connector are substituted in tests; URL,
// hop validation, address pinning inputs and body bounds use this same owner.
trait Network {
    fn resolve(
        &self,
        host: &str,
        port: u16,
    ) -> impl std::future::Future<Output = Result<Vec<SocketAddr>, FetchError>> + Send;
    fn local_addresses(&self) -> Result<Vec<IpAddr>, FetchError>;
    fn get(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        kind: &Kind,
        deadline: Instant,
    ) -> impl std::future::Future<Output = Result<reqwest::Response, FetchError>> + Send;
}
struct NativeNetwork;
impl Network for NativeNetwork {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, FetchError> {
        Ok(tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| FetchError::Unreadable)?
            .take(65)
            .collect())
    }
    fn local_addresses(&self) -> Result<Vec<IpAddr>, FetchError> {
        local_addresses::read()
    }
    async fn get(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
        kind: &Kind,
        deadline: Instant,
    ) -> Result<reqwest::Response, FetchError> {
        let client = reference_client(
            url.host_str().ok_or(FetchError::InvalidRequest)?,
            addresses,
            deadline,
        )?;
        client
            .get(url.clone())
            .header("User-Agent", "Tesina/0.1 (academic writing app)")
            .header(
                "Accept",
                match kind {
                    Kind::Json => "application/json",
                    Kind::Html => "text/html,application/xhtml+xml",
                },
            )
            .header("Accept-Encoding", "gzip, identity")
            .send()
            .await
            .map_err(|_| FetchError::Unreadable)
    }
}
async fn fetch_with_network(
    request: FetchRequest,
    deadline: Instant,
    network: &impl Network,
) -> Result<FetchResult, FetchError> {
    tokio::time::timeout_at(deadline, fetch_hops(request, deadline, network))
        .await
        .map_err(|_| FetchError::Unreadable)?
}
async fn fetch_hops(
    request: FetchRequest,
    deadline: Instant,
    network: &impl Network,
) -> Result<FetchResult, FetchError> {
    let mut url = checked_url(&request.url)?;
    for redirect in 0..=5 {
        let host = url.host_str().ok_or(FetchError::InvalidRequest)?;
        let port = url
            .port_or_known_default()
            .ok_or(FetchError::InvalidRequest)?;
        let addresses: Vec<SocketAddr> = match url.host().ok_or(FetchError::InvalidRequest)? {
            Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Domain(_) => network.resolve(host, port).await?,
        };
        // Refresh for every hop; globally routed addresses can belong to this host.
        validate_addresses(&addresses, &network.local_addresses()?)?;
        let mut response = network
            .get(&url, &addresses, &request.kind, deadline)
            .await?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err(FetchError::Unreadable);
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                .ok_or(FetchError::Unreadable)?;
            if location.len() > 4096 {
                return Err(FetchError::Unreadable);
            }
            url = checked_url(
                url.join(location)
                    .map_err(|_| FetchError::Unreadable)?
                    .as_str(),
            )?;
            continue;
        }
        if response
            .headers()
            .get_all("content-encoding")
            .iter()
            .count()
            > 1
        {
            return Err(FetchError::Unreadable);
        }
        let encoding = response
            .headers()
            .get("content-encoding")
            .map(|v| v.to_str().map_err(|_| FetchError::Unreadable))
            .transpose()?;
        let mut body = body::Body::new(encoding)?;
        let status = response.status().as_u16();
        while let Some(chunk) = response.chunk().await.map_err(|_| FetchError::Unreadable)? {
            body.push(&chunk)?;
            if Instant::now() >= deadline {
                return Err(FetchError::Unreadable);
            }
        }
        let body = body.finish()?;
        if Instant::now() >= deadline {
            return Err(FetchError::Unreadable);
        }
        return Ok(FetchResult { status, body });
    }
    Err(FetchError::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_iana_special_use_even_when_globally_reachable() {
        for ip in [
            "192.31.196.1",
            "192.52.193.1",
            "192.175.48.1",
            "2620:4f:8000::1",
        ] {
            assert!(
                !public_address(ip.parse().unwrap()),
                "special-use address {ip}"
            );
        }
    }
    use std::{collections::VecDeque, sync::Mutex};
    struct ControlledNetwork {
        answers: Mutex<VecDeque<Vec<SocketAddr>>>,
        responses: Mutex<VecDeque<reqwest::Response>>,
        sent: Mutex<Vec<(String, Vec<SocketAddr>)>>,
        local: Vec<IpAddr>,
        delay: Duration,
    }
    #[tokio::test]
    async fn gzip_is_decoded_with_the_same_exact_four_million_byte_limit() {
        use std::io::Write;
        for size in [4_000_000, 4_000_001] {
            let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gzip.write_all(&vec![b'x'; size]).unwrap();
            let network = ControlledNetwork {
                answers: Mutex::new(VecDeque::from([vec!["1.1.1.1:443".parse().unwrap()]])),
                responses: Mutex::new(VecDeque::from([hyper::Response::builder()
                    .status(200)
                    .header("content-encoding", "gzip")
                    .body(gzip.finish().unwrap())
                    .unwrap()
                    .into()])),
                sent: Mutex::new(vec![]),
                local: vec![],
                delay: Duration::ZERO,
            };
            let result = fetch_with_network(
                FetchRequest {
                    url: "https://example.org/paper".into(),
                    kind: Kind::Html,
                },
                Instant::now() + Duration::from_secs(1),
                &network,
            )
            .await;
            if size == 4_000_000 {
                assert_eq!(
                    result.expect("within-cap gzip must decode").body.len(),
                    size
                );
            } else {
                assert!(matches!(result, Err(FetchError::Unreadable)));
            }
        }
    }
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    async fn fetch_encoded(bytes: Vec<u8>, encoding: &str) -> Result<FetchResult, FetchError> {
        let network = ControlledNetwork {
            answers: Mutex::new(VecDeque::from([vec!["1.1.1.1:443".parse().unwrap()]])),
            responses: Mutex::new(VecDeque::from([hyper::Response::builder()
                .status(200)
                .header("content-encoding", encoding)
                .body(bytes)
                .unwrap()
                .into()])),
            sent: Mutex::new(vec![]),
            local: vec![],
            delay: Duration::ZERO,
        };
        fetch_with_network(
            FetchRequest {
                url: "https://example.org/paper".into(),
                kind: Kind::Html,
            },
            Instant::now() + Duration::from_secs(1),
            &network,
        )
        .await
    }
    #[tokio::test]
    async fn gzip_completion_crc_trailing_members_and_identity_are_bounded() {
        let valid = gzip("Árbol 🌱".as_bytes());
        let mut crc = valid.clone();
        let checksum = crc.len() - 8;
        crc[checksum] ^= 1;
        let mut trailing = valid.clone();
        trailing.push(0);
        for invalid in [vec![], valid[..valid.len() - 1].to_vec(), crc, trailing] {
            assert!(matches!(
                fetch_encoded(invalid, "gzip").await,
                Err(FetchError::Unreadable)
            ));
        }
        let mut members = gzip("Árbol ".as_bytes());
        members.extend(gzip("🌱".as_bytes()));
        assert_eq!(
            fetch_encoded(members, "gzip").await.unwrap().body,
            "Árbol 🌱"
        );
        let mut overflow = gzip(&vec![b'x'; 2_000_000]);
        overflow.extend(gzip(&vec![b'x'; 2_000_001]));
        assert!(matches!(
            fetch_encoded(overflow, "gzip").await,
            Err(FetchError::Unreadable)
        ));
        assert_eq!(
            fetch_encoded(vec![b'x'; 4_000_000], "identity")
                .await
                .unwrap()
                .body
                .len(),
            4_000_000
        );
        assert!(matches!(
            fetch_encoded(vec![b'x'; 4_000_001], "identity").await,
            Err(FetchError::Unreadable)
        ));
        assert!(matches!(
            fetch_encoded(vec![1, 2], "br").await,
            Err(FetchError::Unreadable)
        ));
    }
    struct HeaderThenStall {
        bytes: Option<bytes::Bytes>,
        polls: std::sync::Arc<std::sync::atomic::AtomicU32>,
    }
    impl hyper::body::Body for HeaderThenStall {
        type Data = bytes::Bytes;
        type Error = std::io::Error;
        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
            self.polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match self.bytes.take() {
                Some(bytes) => std::task::Poll::Ready(Some(Ok(hyper::body::Frame::data(bytes)))),
                None => std::task::Poll::Pending,
            }
        }
    }
    #[tokio::test]
    async fn unterminated_gzip_header_rejects_before_waiting_for_more_body() {
        let mut bytes = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255];
        bytes.extend(vec![b'x'; 65_536]);
        let polls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let body = reqwest::Body::wrap(HeaderThenStall {
            bytes: Some(bytes.into()),
            polls: polls.clone(),
        });
        let network = ControlledNetwork {
            answers: Mutex::new(VecDeque::from([vec!["1.1.1.1:443".parse().unwrap()]])),
            responses: Mutex::new(VecDeque::from([hyper::Response::builder()
                .status(200)
                .header("content-encoding", "gzip")
                .body(body)
                .unwrap()
                .into()])),
            sent: Mutex::new(vec![]),
            local: vec![],
            delay: Duration::ZERO,
        };
        let result = fetch_with_network(
            FetchRequest {
                url: "https://example.org/paper".into(),
                kind: Kind::Html,
            },
            Instant::now() + Duration::from_millis(100),
            &network,
        )
        .await;
        assert!(matches!(result, Err(FetchError::Unreadable)));
        assert_eq!(
            polls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "must reject the header before polling the stalled body again"
        );
    }
    impl Network for ControlledNetwork {
        async fn resolve(&self, _: &str, _: u16) -> Result<Vec<SocketAddr>, FetchError> {
            self.answers
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(FetchError::Unreadable)
        }
        fn local_addresses(&self) -> Result<Vec<IpAddr>, FetchError> {
            Ok(self.local.clone())
        }
        async fn get(
            &self,
            url: &Url,
            addresses: &[SocketAddr],
            _: &Kind,
            _: Instant,
        ) -> Result<reqwest::Response, FetchError> {
            tokio::time::sleep(self.delay).await;
            self.sent
                .lock()
                .unwrap()
                .push((url.to_string(), addresses.to_vec()));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(FetchError::Unreadable)
        }
    }
    #[tokio::test]
    async fn each_redirect_is_resolved_once_and_private_rebinding_never_reaches_connector() {
        let network = ControlledNetwork {
            answers: Mutex::new(VecDeque::from([
                vec!["1.1.1.1:443".parse().unwrap()],
                vec!["127.0.0.1:443".parse().unwrap()],
            ])),
            responses: Mutex::new(VecDeque::from([hyper::Response::builder()
                .status(302)
                .header("location", "/next")
                .body("")
                .unwrap()
                .into()])),
            sent: Mutex::new(vec![]),
            local: vec![],
            delay: Duration::ZERO,
        };
        let result = fetch_with_network(
            FetchRequest {
                url: "https://example.org/start".into(),
                kind: Kind::Json,
            },
            Instant::now() + Duration::from_secs(1),
            &network,
        )
        .await;
        assert!(matches!(result, Err(FetchError::Unreadable)));
        assert!(network.answers.lock().unwrap().is_empty());
        assert_eq!(
            *network.sent.lock().unwrap(),
            vec![(
                "https://example.org/start".into(),
                vec!["1.1.1.1:443".parse().unwrap()]
            )]
        );
    }
    #[tokio::test]
    async fn one_deadline_also_bounds_a_stalled_connector() {
        let network = ControlledNetwork {
            answers: Mutex::new(VecDeque::from([vec!["1.1.1.1:443".parse().unwrap()]])),
            responses: Mutex::new(VecDeque::from([hyper::Response::builder()
                .status(200)
                .body("ok")
                .unwrap()
                .into()])),
            sent: Mutex::new(vec![]),
            local: vec![],
            delay: Duration::from_millis(50),
        };
        let result = fetch_with_network(
            FetchRequest {
                url: "https://example.org/paper".into(),
                kind: Kind::Html,
            },
            Instant::now() + Duration::from_millis(5),
            &network,
        )
        .await;
        assert!(matches!(result, Err(FetchError::Unreadable)));
        assert!(network.sent.lock().unwrap().is_empty());
    }
    #[test]
    fn resolver_rejects_globally_numbered_local_interfaces_and_mixed_answers() {
        let local = [
            "8.8.8.8".parse().unwrap(),
            "2606:4700:4700::1111".parse().unwrap(),
        ];
        for addresses in [
            vec!["8.8.8.8:443"],
            vec!["[2606:4700:4700::1111]:443"],
            vec!["1.1.1.1:443", "127.0.0.1:443"],
            vec!["1.1.1.1:443", "8.8.8.8:443"],
        ] {
            let addresses: Vec<_> = addresses.iter().map(|a| a.parse().unwrap()).collect();
            assert!(validate_addresses(&addresses, &local).is_err());
        }
        assert!(validate_addresses(&["1.1.1.1:443".parse().unwrap()], &local).is_ok());
        assert!(local_addresses::read()
            .unwrap()
            .iter()
            .any(IpAddr::is_loopback));
    }
    #[test]
    fn reference_client_initializes_without_updater_in_a_fresh_process() {
        const CHILD: &str = "TESINA_REFERENCE_TLS_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            // Build the actual native owner client without sending any network request.
            assert!(reference_client(
                "example.org",
                &["1.1.1.1:443".parse().unwrap()],
                Instant::now() + Duration::from_secs(1)
            )
            .is_ok());
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "reference_fetch::tests::reference_client_initializes_without_updater_in_a_fresh_process", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(
            output.status.success(),
            "fresh citation client failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn url_policy_rejects_local_numeric_mapped_credential_and_unusual_port_targets() {
        for url in [
            "http://localhost/",
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "https://user:pass@example.org/",
            "https://example.org:8443/",
            "file:///tmp/paper",
        ] {
            assert!(checked_url(url).is_err(), "must reject {url}");
        }
        assert!(checked_url("https://example.org/paper#reference")
            .unwrap()
            .fragment()
            .is_none());
        for ip in [
            "10.1.2.3",
            "192.168.1.1",
            "169.254.0.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "2001:db8::1",
            "fc00::1",
            "fe80::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!public_address(ip.parse().unwrap()));
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_address(ip.parse().unwrap()));
        }
    }
}
