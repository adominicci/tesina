#[cfg(test)]
mod boundary_tests;
mod capability;
mod contract;
mod framing;
mod process;
mod proxy;
mod response;
mod schema;
mod socket;
mod state;
pub use process::guardian_entry;
#[cfg(all(windows, feature = "local-ai-proof"))]
pub use process::{proof_startup_snapshot, proof_transition_snapshot};
pub use state::Service;

#[tauri::command]
pub fn local_inference_capability(state: tauri::State<'_, Service>) -> serde_json::Value {
    state.capability()
}
#[tauri::command]
pub async fn local_inference_run(
    state: tauri::State<'_, Service>,
    request: serde_json::Value,
) -> Result<serde_json::Value, contract::ErrorCode> {
    state.run(request).await
}
#[tauri::command]
pub fn local_inference_cancel(
    state: tauri::State<'_, Service>,
    request_id: String,
) -> Result<(), contract::ErrorCode> {
    state.cancel(request_id)
}
#[tauri::command]
pub async fn local_inference_prepare_shutdown(
    state: tauri::State<'_, Service>,
) -> Result<(), contract::ErrorCode> {
    state.prepare_shutdown().await
}
#[tauri::command]
pub fn local_inference_resume(state: tauri::State<'_, Service>) -> Result<(), contract::ErrorCode> {
    state.resume()
}

#[cfg(feature = "local-ai-proof")]
pub fn proof_service(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
) -> Result<Service, contract::ErrorCode> {
    Ok(Service::new(Some(process::Launch {
        executable: process::Artifact::fixture(executable)?,
        model: process::Artifact::fixture(model)?,
    })))
}

#[cfg(feature = "local-ai-proof")]
pub fn proof_child(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
) -> Result<process::OwnedChild, contract::ErrorCode> {
    process::OwnedChild::start(
        &process::Launch {
            executable: process::Artifact::fixture(executable)?,
            model: process::Artifact::fixture(model)?,
        },
        &process::secret(),
        None,
    )
}

#[cfg(all(windows, feature = "local-ai-proof"))]
pub fn proof_quota_child(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
    holder: &std::process::Child,
    snapshot: &mut process::ProofQuota,
) -> Result<process::OwnedChild, contract::ErrorCode> {
    process::OwnedChild::proof_quota_start(
        &process::Launch {
            executable: process::Artifact::fixture(executable)?,
            model: process::Artifact::fixture(model)?,
        },
        &process::secret(),
        holder,
        snapshot,
    )
}

#[cfg(all(windows, feature = "local-ai-proof"))]
pub use process::{ProofHandles, ProofQuota};

#[cfg(all(windows, feature = "local-ai-proof"))]
pub fn proof_handle_child(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
    sentinel: &std::process::Child,
    snapshot: &mut ProofHandles,
) -> Result<process::OwnedChild, contract::ErrorCode> {
    process::OwnedChild::proof_handle_start(
        &process::Launch {
            executable: process::Artifact::fixture(executable)?,
            model: process::Artifact::fixture(model)?,
        },
        &process::secret(),
        sentinel,
        snapshot,
    )
}

#[cfg(feature = "local-ai-proof")]
pub fn proof_listener(child: &mut process::OwnedChild) -> Result<Option<u16>, contract::ErrorCode> {
    if !child.alive() {
        return Err(contract::ErrorCode::Crash);
    }
    let port = socket::listener(child.pid)?;
    if !child.alive() {
        return Err(contract::ErrorCode::Crash);
    }
    Ok(port)
}

#[cfg(feature = "local-ai-proof")]
pub fn proof_service_with_launch_delay(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
    milliseconds: u64,
) -> Result<Service, contract::ErrorCode> {
    let mut service = proof_service(executable, model)?;
    service.launch_delay = std::time::Duration::from_millis(milliseconds.min(3000));
    Ok(service)
}

#[cfg(feature = "local-ai-proof")]
pub fn proof_service_with_startup_budget(
    executable: std::path::PathBuf,
    model: std::path::PathBuf,
) -> Result<Service, contract::ErrorCode> {
    let mut service = proof_service_with_launch_delay(executable, model, 200)?;
    service.startup_budget = std::time::Duration::from_millis(1000);
    Ok(service)
}

#[cfg(test)]
mod tests {
    use super::contract::*;
    use serde_json::json;
    #[tokio::test(start_paused = true)]
    async fn cancellation_table_bounds_foreign_ids_completed_noops_and_exact_expiry() {
        let service = super::Service::default();
        let ids: Vec<_> = (0..32).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        for id in &ids {
            service.cancel(id.clone()).unwrap();
        }
        let foreign = uuid::Uuid::new_v4().to_string();
        assert_eq!(service.cancel(foreign.clone()), Err(ErrorCode::Busy));
        let request = json!({"requestId":ids[0],"documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"es","passage":{"sourceId":"p","snapshotId":"s","text":"Árbol 🌱"}}});
        assert_eq!(
            service.run(request.clone()).await.unwrap()["error"],
            "cancelled"
        );
        service.cancel(ids[0].clone()).unwrap();
        assert_eq!(
            service.run(request.clone()).await.unwrap()["error"],
            "busy",
            "completed cancellation is a no-op, not a new cancellation"
        );
        tokio::time::advance(std::time::Duration::from_millis(119_999)).await;
        assert_eq!(service.cancel(foreign.clone()), Err(ErrorCode::Busy));
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        service.cancel(foreign).unwrap();
        assert_ne!(
            service.run(request).await.unwrap()["error"],
            "cancelled",
            "expired tombstone must not cancel a later admission"
        );
        assert_eq!(service.capability()["status"], "unavailable");
        service.prepare_shutdown().await.unwrap();
        assert!(service.shutdown_ready());
        service.resume().unwrap();
        assert!(!service.shutdown_ready());
    }

    #[test]
    fn accepts_original_source_and_rejects_unbounded_or_foreign_authority() {
        let request = json!({"requestId":"f98b4102-986b-4abc-9bb4-b760f7b136b7", "sourceSnapshotId":"s", "task":"writingCoach", "input":{"documentLanguage":"es","passage":{"sourceId":"p","snapshotId":"s","text":"Árbol 🌱"}}});
        let accepted = admit(request.clone()).unwrap();
        assert_eq!(accepted.sources()[0].text, "Árbol 🌱");
        for extra in ["endpoint", "modelPath", "executable", "headers"] {
            let mut invalid = request.clone();
            invalid[extra] = json!("sensitive");
            assert!(admit(invalid).is_err());
        }
        let mut invalid = request.clone();
        invalid["documentRevision"] = json!(1);
        assert!(admit(invalid).is_err());
        let mut invalid = request.clone();
        invalid["documentRevision"] = serde_json::Value::Null;
        assert!(admit(invalid).is_err());
        let mut invalid = request.clone();
        invalid["input"]["passage"]["text"] = json!("x".repeat(16385));
        assert_eq!(
            admit(invalid).unwrap().validate(),
            Err(ErrorCode::InvalidRequest)
        );
        let mut invalid = request;
        invalid["input"]["passage"]["snapshotId"] = json!("foreign");
        assert_eq!(
            admit(invalid).unwrap().validate(),
            Err(ErrorCode::InvalidRequest)
        );
    }

    #[test]
    fn rejects_smuggled_drafts_and_preserves_surrogate_boundaries() {
        let request = admit(json!({"requestId":"f98b4102-986b-4abc-9bb4-b760f7b136b7", "documentRevision":4, "task":"writingCoach", "input":{"documentLanguage":"es","passage":{"sourceId":"p","snapshotId":"s","text":"Árbol 🌱"}}})).unwrap();
        let valid = r#"{"issues":[{"from":6,"to":8,"category":"clarity","explanation":"¿Qué significa?","learningQuestion":"¿Puedes explicarlo?","source":"local-model"}]}"#;
        assert!(super::response::validate_draft(valid.as_bytes(), &request).is_ok());
        for invalid in [
            valid.replace("\"from\":6", "\"from\":7"),
            valid.replace("\"from\":6", "\"from\":6,\"from\":6"),
            format!("{valid} {{}}"),
            valid.replace(
                "\"source\":\"local-model\"",
                "\"source\":\"local-model\",\"secret\":\"canary\"",
            ),
            "{\"issues\":[],\"issues\":[]}".to_owned(),
            format!("{}0{}", "[".repeat(33), "]".repeat(33)),
        ] {
            assert_eq!(
                super::response::validate_draft(invalid.as_bytes(), &request),
                Err(ErrorCode::InvalidResponse)
            );
        }
    }

    #[test]
    fn capability_is_ordered_and_default_model_resolution_is_empty() {
        use super::capability::*;
        assert_eq!(
            evaluate("linux", "x86_64", (99, 0), true, true, false),
            Err(ErrorCode::UnsupportedPlatform)
        );
        assert_eq!(
            evaluate("macos", "aarch64", (12, 0), true, true, false),
            Err(ErrorCode::UnsupportedHardware)
        );
        assert_eq!(
            evaluate("windows", "aarch64", (10, 0), true, true, false),
            Err(ErrorCode::UnsupportedHardware)
        );
        assert_eq!(
            evaluate("macos", "aarch64", (13, 3), false, true, false),
            Err(ErrorCode::SidecarAbsent)
        );
        assert_eq!(
            evaluate("windows", "x86_64", (10, 0), true, false, false),
            Err(ErrorCode::NotInstalled)
        );
        assert_eq!(
            evaluate("macos", "x86_64", (13, 3), true, true, true),
            Ok("busy")
        );
        assert_eq!(
            evaluate("macos", "aarch64", (13, 3), true, true, false),
            Ok("ready")
        );
        assert!(installed_model().is_none());
    }
}
