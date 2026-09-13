//! Non-shipping deterministic HTTP fixture. No model, upstream build or downloads.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

fn respond(mut stream: TcpStream, key: &str, scenario: &str, fixture: &std::path::Path) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while bytes.len() < 16 * 1024 && !bytes.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).is_err() {
            return;
        }
        bytes.push(byte[0]);
    }
    let Ok(headers) = std::str::from_utf8(&bytes) else {
        return;
    };
    let mut lines = headers.split("\r\n");
    let first = lines.next().unwrap_or("");
    let fields: Vec<_> = first.split(' ').collect();
    if fields.len() != 3 {
        return;
    }
    let (method, path) = (fields[0], fields[1]);
    let mut length = 0;
    let mut authenticated = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().unwrap_or(usize::MAX);
            }
            if name.eq_ignore_ascii_case("authorization") {
                authenticated = value.trim() == format!("Bearer {key}");
            }
        }
    }
    if length > 96 * 1024 {
        return;
    }
    let mut body = vec![0; length];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    let (status, output) = if scenario == "loading" && path == "/health" {
        #[cfg(target_os = "macos")]
        std::fs::write(
            fixture.join("death-phase.json"),
            json!({"phase":"loading","pid":std::process::id(),"guardian":unsafe {libc::getppid()}})
                .to_string(),
        )
        .unwrap();
        (503, "{}".into())
    } else if path == "/health" || method == "OPTIONS" {
        (200, json!({"status":"ok"}).to_string())
    } else if !authenticated {
        (401, "{}".into())
    } else if path == "/v1/models" {
        (200, json!({"data":[{"id":"tesina-local"}]}).to_string())
    } else if path == "/tokenize" {
        let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if input["add_special"] != true {
            return;
        }
        let tokens: Vec<u32> = input["content"]
            .as_str()
            .unwrap_or("")
            .as_bytes()
            .iter()
            .map(|b| u32::from(*b))
            .collect();
        (200, json!({"tokens":tokens}).to_string())
    } else if path == "/completion" {
        if scenario == "read-generation" {
            let input: Value = serde_json::from_slice(&body).unwrap();
            assert!(input["stream"] == false && input["cache_prompt"] == false);
            let prompt: Vec<u8> = input["prompt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect();
            let request: Value = serde_json::from_slice(&prompt).unwrap();
            let source = request["passage"]["text"].as_str().unwrap();
            assert!(source == "SOURCE_CANARY");
            let output = format!(
                "{source} GENERATED_CANARY /private/PAPER_CANARY /private/MODEL_CANARY {key}"
            );
            println!("{output}");
            eprintln!("{output}");
            std::io::stdout().flush().unwrap();
            std::io::stderr().flush().unwrap();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                output.len()
            );
            std::fs::write(fixture.join("completion-admitted.json"), json!({"pid":std::process::id(),"keyDigest":format!("{:x}",Sha256::digest(key.as_bytes())),"outputAttempted":true}).to_string()).unwrap();
            #[cfg(target_os = "macos")]
            std::fs::write(fixture.join("death-phase.json"), json!({"phase":"read-generation","pid":std::process::id(),"guardian":unsafe {libc::getppid()}}).to_string()).unwrap();
            let until = std::time::Instant::now() + Duration::from_secs(10);
            while !fixture.join("release-completion").exists() && std::time::Instant::now() < until
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = stream.write_all(output.as_bytes());
            return;
        }
        if scenario == "smuggling" || scenario.starts_with("framing-") {
            let output = json!({"content":"{\"issues\":[]}","truncated":false}).to_string();
            let chunked = format!("{:x}\r\n{output}\r\n0\r\n\r\n", output.len());
            let (prefix, headers, body) = match scenario {
                "framing-reversed" => (
                    "",
                    "tRaNsFeR-EnCoDiNg: chunked\r\ncOnTeNt-LeNgTh: 1\r\n".into(),
                    chunked,
                ),
                "framing-duplicate-cl" | "framing-lf" | "framing-mixed" => (
                    "",
                    format!(
                        "Content-Length: {}\r\ncOnTeNt-LeNgTh: {}\r\n",
                        output.len(),
                        output.len()
                    ),
                    output,
                ),
                "framing-duplicate-te" => (
                    "",
                    "Transfer-Encoding: chunked\r\ntRaNsFeR-EnCoDiNg: chunked\r\n".into(),
                    chunked,
                ),
                "framing-interim" => (
                    "HTTP/1.1 100 Continue\r\n\r\n",
                    "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n".into(),
                    chunked,
                ),
                "framing-header-cap" => (
                    "",
                    format!(
                        "X-Fill: {}\r\nContent-Length: {}\r\n",
                        "a".repeat(17 * 1024),
                        output.len()
                    ),
                    output,
                ),
                "framing-comma-cl" => (
                    "",
                    format!("Content-Length: {}, {}\r\n", output.len(), output.len()),
                    output,
                ),
                "framing-trailer" => (
                    "",
                    "Transfer-Encoding: chunked\r\nTrailer: X-Extra\r\n".into(),
                    format!(
                        "{:x}\r\n{output}\r\n0\r\nX-Extra: denied\r\n\r\n",
                        output.len()
                    ),
                ),
                "framing-valid-chunked" => ("", "Transfer-Encoding: chunked\r\n".into(), chunked),
                _ => (
                    "",
                    "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n".into(),
                    chunked,
                ),
            };
            let header = format!("{prefix}HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n");
            let header = match scenario {
                "framing-lf" => header.replace("\r\n", "\n"),
                "framing-mixed" => {
                    header.replace("Connection: close\r\n\r\n", "Connection: close\n\n")
                }
                _ => header,
            };
            let _ = write!(stream, "{header}{body}");
            return;
        }
        if scenario == "crash" {
            let input: Value = serde_json::from_slice(&body).unwrap();
            assert!(input["stream"] == false && input["cache_prompt"] == false);
            let prompt: Vec<u8> = input["prompt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect();
            let request: Value = serde_json::from_slice(&prompt).unwrap();
            if !fixture.join("allow-retry").exists() {
                assert!(request["passage"]["text"] == "FAILED_SOURCE");
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                    )
                    .unwrap();
                std::fs::write(
                    fixture.join("crash-admitted.json"),
                    json!({"pid":std::process::id()}).to_string(),
                )
                .unwrap();
                let until = std::time::Instant::now() + Duration::from_secs(5);
                while !fixture.join("release-crash").exists() && std::time::Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::process::exit(23);
            }
            assert!(
                request["passage"]["text"] == "FRESH_SOURCE",
                "failed source replayed into next generation"
            );
            if fixture.join("live-malformed").exists() {
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                    )
                    .unwrap();
                return; // Close this response, but keep the actual child process alive.
            }
        }
        if scenario == "delay" {
            std::thread::sleep(Duration::from_secs(2));
        }
        if scenario == "malformed" {
            (200, "{\"content\":\"{}\",\"content\":\"{}\"}".into())
        } else {
            let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if input["stream"] != false
                || input["n_predict"] != 2048
                || input["cache_prompt"] != false
                || !input["json_schema"].is_object()
            {
                return;
            }
            let prompt: Vec<u8> = input["prompt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect();
            let request: Value = serde_json::from_slice(&prompt).unwrap();
            let schema = &input["json_schema"];
            let item = if request["passage"].is_object() {
                &schema["properties"]["issues"]["items"]
            } else {
                &schema["properties"]["questions"]["items"]
            };
            if item["type"] != "object"
                || item["additionalProperties"] != false
                || !item["required"].is_array()
            {
                return;
            }
            if request["passage"].is_object() {
                if item["properties"]["source"]["const"] != "local-model"
                    || item["properties"]["learningQuestion"]["maxLength"] != 2048
                {
                    return;
                }
            } else if item["properties"]["options"]["minItems"] != 4
                || item["properties"]["options"]["maxItems"] != 4
                || item["properties"]["provenance"]["additionalProperties"] != false
            {
                return;
            }
            let draft = if request["passage"].is_object() {
                if request["passage"]["text"] == "Árbol 🌱 e\u{301}" {
                    json!({"issues":[
                        {"from":6,"to":8,"category":"clarity","explanation":"🌱","learningQuestion":"¿Árbol?","source":"local-model"},
                        {"from":9,"to":11,"category":"specificity","explanation":"e\u{301}","learningQuestion":"¿e\u{301}?","source":"local-model"}
                    ]})
                } else {
                    json!({"issues":[]})
                }
            } else {
                let s = &request["sources"][0];
                let unicode = s["text"] == "Árbol 🌱 e\u{301}";
                let spans = if unicode {
                    json!([
                        {"sourceId":s["sourceId"],"snapshotId":s["snapshotId"],"from":6,"to":8,"unit":"utf16"},
                        {"sourceId":s["sourceId"],"snapshotId":s["snapshotId"],"from":9,"to":11,"unit":"utf16"}
                    ])
                } else {
                    json!([{"sourceId":s["sourceId"],"snapshotId":s["snapshotId"],"from":0,"to":1,"unit":"utf16"}])
                };
                let q = json!({"question":if unicode { "Árbol 🌱 e\u{301}?" } else { "Fixture?" },"options":["A","B","C","D"],"correctIndex":0,"explanation":"Fixture explanation.","distractorExplanations":["A reason","B reason","C reason","D reason"],"provenance":{"question":spans,"options":[spans,spans,spans,spans],"explanation":spans,"distractorExplanations":[spans,spans,spans,spans]}});
                json!({"questions":vec![q; request["questionCount"].as_u64().unwrap() as usize]})
            };
            (
                200,
                json!({"content":draft.to_string(),"truncated":false}).to_string(),
            )
        }
    } else {
        (404, "{}".into())
    };
    if authenticated && path == "/completion" && fixture.join("webview-hold").exists() {
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", output.len()).unwrap();
        stream.flush().unwrap();
        std::fs::write(fixture.join("webview-admitted.json"), json!({"pid":std::process::id(),"keyDigest":format!("{:x}",Sha256::digest(key.as_bytes()))}).to_string()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !fixture.join("webview-release").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = stream.write_all(output.as_bytes());
    } else {
        let _ = write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{output}", output.len());
    }
}
fn main() {
    let key = std::env::var("LLAMA_API_KEY").expect("fixture key required");
    assert!(key.len() >= 64);
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].as_str())
    };
    assert_eq!(value("--host"), Some("127.0.0.1"));
    assert_eq!(value("--port"), Some("0"));
    assert_eq!(value("--ctx-size"), Some("4096"));
    assert_eq!(value("--parallel"), Some("1"));
    for flag in [
        "--no-webui",
        "--no-agent",
        "--no-webui-mcp-proxy",
        "--no-slots",
        "--offline",
        "--log-disable",
        "--no-context-shift",
    ] {
        assert!(args.iter().any(|arg| arg == flag));
    }
    let scenario = value("--model")
        .and_then(|p| std::path::Path::new(p).file_stem())
        .and_then(|s| s.to_str())
        .unwrap_or("success")
        .to_owned();
    let fixture = std::path::Path::new(value("--model").unwrap())
        .parent()
        .unwrap()
        .to_owned();
    if scenario == "launch-integrity" {
        std::fs::write(fixture.join("launch-attempted"), b"executed").unwrap();
    }
    if scenario == "launch-environment" {
        assert!(
            key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()) && key != "f".repeat(64)
        );
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            assert!(
                !(name.starts_with("LLAMA_") && name != "LLAMA_API_KEY")
                    && !name.starts_with("DYLD_")
                    && !name.starts_with("LD_")
                    && !matches!(
                        name.as_ref(),
                        "HTTP_PROXY"
                            | "HTTPS_PROXY"
                            | "ALL_PROXY"
                            | "NO_PROXY"
                            | "http_proxy"
                            | "https_proxy"
                            | "all_proxy"
                            | "no_proxy"
                            | "XDG_CONFIG_HOME"
                    ),
                "poisoned environment reached fake"
            );
        }
        // Independent approved launch contract; do not import production FLAGS.
        let fixed = [
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--no-webui",
            "--no-agent",
            "--no-webui-mcp-proxy",
            "--no-slots",
            "--offline",
            "--log-disable",
            "--ctx-size",
            "4096",
            "--parallel",
            "1",
            "--no-context-shift",
            "--alias",
            "tesina-local",
            "--model",
        ];
        assert!(
            args.len() == fixed.len() + 2
                && args[1..args.len() - 1].iter().map(String::as_str).eq(fixed)
        );
        assert!(
            std::path::Path::new(args.last().unwrap())
                .file_name()
                .unwrap()
                == "launch-environment.gguf"
        );
        std::fs::write(
            fixture.join("environment-verified.json"),
            json!({"pid":std::process::id(),"isolated":true,"fixedArguments":true}).to_string(),
        )
        .unwrap();
    }
    if scenario == "read-generation" || scenario == "crash" {
        let mut starts = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(fixture.join("generation-starts"))
            .unwrap();
        writeln!(starts, "{}", std::process::id()).unwrap();
    }
    if scenario == "exit-before-listen" {
        std::process::exit(23);
    }
    if scenario == "canary" {
        println!("SOURCE_CANARY GENERATED_CANARY {key}");
        eprintln!("/private/PAPER_CANARY /private/MODEL_CANARY");
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            break;
        };
        let key = key.clone();
        let scenario = scenario.clone();
        let fixture = fixture.clone();
        std::thread::spawn(move || respond(stream, &key, &scenario, &fixture));
    }
}
