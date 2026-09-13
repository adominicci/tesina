//! Actual platform webview -> production client -> registered commands -> fake.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{borrow::Cow, path::PathBuf};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

struct Coordination {
    root: PathBuf,
    stage: std::sync::Mutex<u8>,
    previous: std::sync::Mutex<Option<serde_json::Value>>,
}

// Fixed nonshipping scenario only: no caller-selected path, bytes, or process.
#[tauri::command]
async fn local_inference_proof_coordinate(
    state: tauri::State<'_, Coordination>,
    service: tauri::State<'_, tesina_lib::local_ai::Service>,
    action: String,
) -> Result<(), &'static str> {
    let stage = *state.stage.lock().unwrap();
    let expected = [
        "arm",
        "admitted",
        "cleaned",
        "arm",
        "admitted",
        "release",
        "finished",
        "arm-terminal",
        "terminal-ready",
        "release-cancelled-terminal",
        "terminal-cleaned",
    ];
    if expected.get(usize::from(stage)).copied() != Some(action.as_str()) {
        return Err("proof-order");
    }
    let marker = state.root.join("webview-admitted.json");
    match action.as_str() {
        "arm-terminal" => {
            if !service.proof_arm_completion() {
                return Err("proof-terminal-arm");
            }
        }
        "terminal-ready" => {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !service.proof_completion_pending() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "proof-terminal-ready")?;
            let pid = service.proof_child_pid().ok_or("proof-terminal-owner")?;
            *state.previous.lock().unwrap() = Some(serde_json::json!({"pid":pid}));
        }
        "release-cancelled-terminal" => {
            if !service.proof_release_cancelled_completion() {
                return Err("proof-pending-cancel");
            }
        }
        "arm" => {
            if marker.exists() {
                return Err("proof-stale");
            }
            std::fs::write(state.root.join("webview-hold"), b"hold").map_err(|_| "proof-file")?;
        }
        "admitted" => {
            let admission = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if let Ok(bytes) = std::fs::read(&marker) {
                        if bytes.len() <= 256 {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                break value;
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "proof-admission")?;
            if admission["pid"].as_u64() != service.proof_child_pid().map(u64::from)
                || !admission["keyDigest"]
                    .as_str()
                    .is_some_and(|key| key.len() == 64)
            {
                return Err("proof-owner");
            }
            let mut previous = state.previous.lock().unwrap();
            if let Some(old) = previous.as_ref() {
                if old["pid"] == admission["pid"] || old["keyDigest"] == admission["keyDigest"] {
                    return Err("proof-fresh");
                }
            }
            *previous = Some(admission);
        }
        "release" => {
            std::fs::write(state.root.join("webview-release"), b"release")
                .map_err(|_| "proof-file")?;
        }
        "cleaned" | "finished" | "terminal-cleaned" => {
            if !service.shutdown_ready() {
                return Err("proof-cleanup");
            }
            #[cfg(target_os = "macos")]
            {
                let pid = state.previous.lock().unwrap().as_ref().unwrap()["pid"]
                    .as_u64()
                    .unwrap();
                if unsafe { libc::kill(pid as i32, 0) } == 0 {
                    return Err("proof-live");
                }
            }
            for name in ["webview-admitted.json", "webview-hold", "webview-release"] {
                let path = state.root.join(name);
                if path.exists() {
                    std::fs::remove_file(path).map_err(|_| "proof-file")?;
                }
            }
        }
        _ => return Err("proof-order"),
    }
    *state.stage.lock().unwrap() = stage + 1;
    Ok(())
}

struct ProofAssets {
    script: Vec<u8>,
    html: Vec<u8>,
}
impl Assets<Wry> for ProofAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            "/index.html" => Some(Cow::Borrowed(&self.html)),
            "/proof.js" => Some(Cow::Borrowed(&self.script)),
            _ => None,
        }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
#[tauri::command]
fn local_inference_proof_report(
    app: tauri::AppHandle,
    result: tauri::State<'_, Arc<AtomicBool>>,
    connections: tauri::State<'_, Arc<std::sync::atomic::AtomicU32>>,
    cases: u8,
    denied: bool,
    private_fs: bool,
    private_fs_write_denials: u8,
    csp: bool,
    cancellations: u8,
    native_escape: bool,
    cancellation_table_entries: u8,
    cancellation_table_saturated: bool,
    read_cancellation: bool,
    completion_ordering: bool,
    fresh_generation: bool,
    pending_cancel_wins: bool,
    coordination: tauri::State<'_, Coordination>,
    passed: bool,
) {
    let connections = connections.load(Ordering::SeqCst);
    let success = passed
        && denied
        && private_fs
        && private_fs_write_denials == 2
        && csp
        && cases == 12
        && connections == 0
        && cancellations == 2
        && native_escape
        && cancellation_table_entries == 32
        && cancellation_table_saturated
        && read_cancellation
        && completion_ordering
        && fresh_generation
        && pending_cancel_wins
        && *coordination.stage.lock().unwrap() == 11;
    println!("{{\"proof\":\"local-ai-webview-v1\",\"cases\":{cases},\"genericHttpDenied\":{denied},\"privateFsDenied\":{private_fs},\"privateFsWriteDenials\":{private_fs_write_denials},\"cspDenied\":{csp},\"trapConnections\":{connections},\"cancellations\":{cancellations},\"nativeEscapeDenied\":{native_escape},\"cancellationTableEntries\":{cancellation_table_entries},\"cancellationTableSaturated\":{cancellation_table_saturated},\"readCancellation\":{read_cancellation},\"completionOrdering\":{completion_ordering},\"freshGeneration\":{fresh_generation},\"pendingCancelWins\":{pending_cancel_wins},\"passed\":{success}}}");
    result.store(success, Ordering::SeqCst);
    // Some platform event loops do not propagate AppHandle::exit's code.
    if !success {
        std::process::exit(1);
    }
    app.exit(if success { 0 } else { 1 });
}
fn main() {
    use tesina_lib::local_ai::*;
    use tesina_lib::reference_fetch::*;
    if guardian_entry() {
        return;
    }
    let executable = PathBuf::from(std::env::args_os().nth(1).expect("fixed fake required"));
    let script =
        std::fs::read(std::env::args_os().nth(2).expect("built proof JS required")).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let model = temp.path().join("success.gguf");
    std::fs::write(&model, b"synthetic proof fixture").unwrap();
    let service = proof_service_with_launch_delay(executable, model, 200).unwrap();
    let trap = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    trap.set_nonblocking(true).unwrap();
    let trap_url = format!("http://{}/trap", trap.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let trap_stop = stop.clone();
    let connections = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let trap_connections = connections.clone();
    let trap_thread = std::thread::spawn(move || {
        use std::io::Write;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !trap_stop.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            if let Ok((mut stream, _)) = trap.accept() {
                trap_connections.fetch_add(1, Ordering::SeqCst);
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(100)));
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
    let mut context = tesina_lib::local_ai_proof_context();
    context.config_mut().build.dev_url = None;
    context.config_mut().app.security.dev_csp = context.config().app.security.csp.clone();
    context.config_mut().app.windows[0].visible = false;
    // Automated proof continuations must keep running while the test window is inactive.
    context.config_mut().app.windows[0].background_throttling =
        Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    context.config_mut().app.windows[0].title = "Tesina local inference proof".into();
    let html = format!("<!doctype html><html><head><meta charset=\"utf-8\"></head><body data-trap=\"{trap_url}\">Local inference boundary proof<script type=\"module\" src=\"/proof.js\"></script></body></html>").into_bytes();
    context.set_assets(Box::new(ProofAssets { script, html }));
    let result = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .manage(service)
        .manage(Coordination {
            root: temp.path().to_path_buf(),
            stage: std::sync::Mutex::new(0),
            previous: std::sync::Mutex::new(None),
        })
        .manage(result.clone())
        .manage(connections.clone())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            local_inference_capability,
            local_inference_run,
            local_inference_cancel,
            local_inference_prepare_shutdown,
            local_inference_resume,
            reference_fetch,
            local_inference_proof_coordinate,
            local_inference_proof_report
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(60));
                handle.exit(2);
                std::process::exit(2);
            });
            Ok(())
        })
        .build(context)
        .unwrap()
        .run(|_, _| {});
    stop.store(true, Ordering::SeqCst);
    trap_thread.join().unwrap();
    if !result.load(Ordering::SeqCst) || connections.load(Ordering::SeqCst) != 0 {
        eprintln!("local-ai-webview-proof: no successful native report");
        std::process::exit(1);
    }
}
