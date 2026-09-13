use super::{
    contract::{ErrorCode, Request, OUTPUT_BYTES},
    process::OwnedChild,
    response, socket,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request as HttpRequest;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::time::{Duration, Instant};

async fn exchange(
    child: &mut OwnedChild,
    port: u16,
    key: &str,
    path: &'static str,
    body: Option<Value>,
    deadline: Instant,
) -> Result<Value, ErrorCode> {
    if !child.alive() {
        return Err(ErrorCode::Crash);
    }
    let stream = socket::connect(child.pid, port, deadline).await?;
    if !child.alive() {
        return Err(ErrorCode::Crash);
    }
    let io = TokioIo::new(super::framing::GuardedStream::new(stream));
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(16 * 1024)
        .handshake(io)
        .await
        .map_err(|_| ErrorCode::InvalidResponse)?;
    // The handle is aborted on every exit path, so cancellation closes the verified stream.
    struct Connection(tokio::task::JoinHandle<()>);
    impl Drop for Connection {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _connection = Connection(tokio::spawn(async move {
        let _ = connection.await;
    }));
    let method = if body.is_some() { "POST" } else { "GET" };
    let bytes = match body {
        Some(body) => serde_json::to_vec(&body).map_err(|_| ErrorCode::InvalidRequest)?,
        None => vec![],
    };
    let mut builder = HttpRequest::builder()
        .method(method)
        .uri(path)
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "close")
        .header("Content-Type", "application/json");
    if path != "/health" {
        builder = builder.header("Authorization", format!("Bearer {key}"));
    }
    let request = builder
        .body(Full::new(Bytes::from(bytes)))
        .map_err(|_| ErrorCode::InvalidRequest)?;
    let operation = async {
        let response = sender.send_request(request).await.map_err(|_| {
            if child.alive() {
                ErrorCode::InvalidResponse
            } else {
                ErrorCode::Crash
            }
        })?;
        if response.status() == 503 {
            return Err(ErrorCode::Busy);
        }
        if !response.status().is_success() || response.headers().contains_key("upgrade") {
            return Err(ErrorCode::InvalidResponse);
        }
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| {
                if child.alive() {
                    ErrorCode::InvalidResponse
                } else {
                    ErrorCode::Crash
                }
            })?;
            if let Some(data) = frame.data_ref() {
                if bytes.len() + data.len() > OUTPUT_BYTES {
                    return Err(ErrorCode::InvalidResponse);
                }
                bytes.extend_from_slice(data);
            }
            if frame.trailers_ref().is_some() {
                return Err(ErrorCode::InvalidResponse);
            }
        }
        response::parse(&bytes)
    };
    tokio::time::timeout_at(deadline, operation)
        .await
        .map_err(|_| ErrorCode::Timeout)?
}

pub async fn generate(
    child: &mut OwnedChild,
    key: &str,
    request: &Request,
    deadline: Instant,
    startup: Instant,
) -> Result<Value, ErrorCode> {
    let mut ready = None;
    for _ in 0..100 {
        if !child.alive() {
            return Err(ErrorCode::Crash);
        }
        if Instant::now() >= startup {
            return Err(ErrorCode::StartupFailed);
        }
        if let Some(port) = socket::listener(child.pid)? {
            match exchange(child, port, key, "/health", None, startup).await {
                Ok(health) if health == json!({"status":"ok"}) => {
                    let models = exchange(child, port, key, "/v1/models", None, startup).await?;
                    if models["data"].as_array().is_some_and(|models| {
                        models.len() == 1 && models[0]["id"] == "tesina-local"
                    }) {
                        ready = Some(port);
                        break;
                    }
                    return Err(ErrorCode::InvalidResponse);
                }
                Err(ErrorCode::Busy) => {}
                Err(code) => return Err(code),
                _ => return Err(ErrorCode::InvalidResponse),
            }
        }
        tokio::time::sleep_until(startup.min(Instant::now() + Duration::from_millis(100))).await;
    }
    let port = ready.ok_or(ErrorCode::StartupFailed)?;
    let input = request.input.as_ref().map_err(|e| *e)?;
    let prompt = serde_json::to_string(input).map_err(|_| ErrorCode::InvalidRequest)?;
    let tokenized = exchange(
        child,
        port,
        key,
        "/tokenize",
        Some(json!({"content":prompt,"add_special":true})),
        deadline,
    )
    .await?;
    let tokens = tokenized["tokens"]
        .as_array()
        .ok_or(ErrorCode::InvalidResponse)?;
    if tokens.is_empty() || tokens.len() > 2047 {
        return Err(ErrorCode::InvalidRequest);
    }
    if tokens
        .iter()
        .any(|n| n.as_u64().is_none_or(|n| n > i32::MAX as u64))
    {
        return Err(ErrorCode::InvalidResponse);
    }
    let schema = super::schema::draft(input);
    let completion = exchange(child, port, key, "/completion", Some(json!({"prompt":tokens,"n_predict":2048,"stream":false,"cache_prompt":false,"json_schema":schema})), deadline).await?;
    if completion.get("truncated").is_some_and(|v| v != false)
        || completion.get("stopped_limit").is_some_and(|v| v != false)
    {
        return Err(ErrorCode::InvalidResponse);
    }
    let content = completion["content"]
        .as_str()
        .ok_or(ErrorCode::InvalidResponse)?;
    response::validate_draft(content.as_bytes(), request)
}
