use super::{
    capability,
    contract::{admit, valid_uuid, ErrorCode},
    process::{self, Launch, OwnedChild},
    proxy,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{oneshot, watch},
    time::{Duration, Instant},
};

enum RecordState {
    Cancelled,
    Active,
    Completed,
}
struct Record {
    at: Instant,
    state: RecordState,
}
struct Owner {
    records: HashMap<String, Record>,
    active: Option<(String, watch::Sender<bool>)>,
    stopping: bool,
    shutdown: bool,
    cleanup_failed: bool,
}
#[derive(Clone)]
pub struct Service {
    owner: Arc<Mutex<Owner>>,
    launch: Option<Launch>,
    #[cfg(feature = "local-ai-proof")]
    pub(super) launch_delay: Duration,
    #[cfg(feature = "local-ai-proof")]
    pub(super) startup_budget: Duration,
    #[cfg(feature = "local-ai-proof")]
    proof_pid: Arc<std::sync::atomic::AtomicU32>,
}
impl Default for Service {
    fn default() -> Self {
        Self::new(None)
    }
}
impl Service {
    pub(super) fn new(launch: Option<Launch>) -> Self {
        Self {
            owner: Arc::new(Mutex::new(Owner {
                records: HashMap::new(),
                active: None,
                stopping: false,
                shutdown: false,
                cleanup_failed: false,
            })),
            launch,
            #[cfg(feature = "local-ai-proof")]
            launch_delay: Duration::ZERO,
            #[cfg(feature = "local-ai-proof")]
            startup_budget: Duration::from_secs(30),
            #[cfg(feature = "local-ai-proof")]
            proof_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        }
    }
    pub fn capability(&self) -> Value {
        let busy = self
            .owner
            .lock()
            .map(|o| o.active.is_some() || o.stopping)
            .unwrap_or(true);
        let result = capability::evaluate(
            std::env::consts::OS,
            std::env::consts::ARCH,
            capability::os_version(),
            self.launch.is_some(),
            self.launch.is_some() || capability::installed_model().is_some(),
            busy,
        );
        match result {
            Ok(status) => json!({"version":1,"status":status}),
            Err(reason) => json!({"version":1,"status":"unavailable","reason":reason}),
        }
    }
    pub async fn run(&self, value: Value) -> Result<Value, ErrorCode> {
        let request = admit(value)?;
        if let Err(code) = request.validate() {
            return Ok(request.correlation.error(code));
        }
        let id = request.correlation.request_id.clone();
        let (launch, mut cancellation, deadline) = {
            let mut owner = self.owner.lock().map_err(|_| ErrorCode::Crash)?;
            owner.expire();
            if owner.shutdown {
                return Ok(request.correlation.error(ErrorCode::ShuttingDown));
            }
            if owner.cleanup_failed {
                return Ok(request.correlation.error(ErrorCode::Crash));
            }
            if let Some(record) = owner.records.get_mut(&id) {
                return Ok(request.correlation.error(match record.state {
                    RecordState::Cancelled => {
                        record.state = RecordState::Completed;
                        ErrorCode::Cancelled
                    }
                    _ => ErrorCode::Busy,
                }));
            }
            if owner.active.is_some() || owner.stopping || owner.records.len() >= 32 {
                return Ok(request.correlation.error(ErrorCode::Busy));
            }
            let Some(launch) = self.launch.clone() else {
                let code = capability::evaluate(
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    capability::os_version(),
                    false,
                    false,
                    false,
                )
                .err()
                .unwrap_or(ErrorCode::NotInstalled);
                return Ok(request.correlation.error(code));
            };
            let (cancel, cancellation) = watch::channel(false);
            owner.active = Some((id.clone(), cancel));
            owner.records.insert(
                id.clone(),
                Record {
                    at: Instant::now(),
                    state: RecordState::Active,
                },
            );
            let deadline = Instant::now() + Duration::from_secs(120);
            (launch, cancellation, deadline)
        };
        let (reply, receive) = oneshot::channel();
        let service = self.clone();
        #[cfg(feature = "local-ai-proof")]
        let startup_deadline =
            deadline.min(deadline - Duration::from_secs(120) + self.startup_budget);
        #[cfg(not(feature = "local-ai-proof"))]
        let startup_deadline = deadline - Duration::from_secs(90);
        tokio::spawn(async move {
            let key = process::secret();
            // spawn_blocking owns the child even if its caller is cancelled during launch.
            let key_for_launch = key.clone();
            let launch_cancel = cancellation.clone();
            let mut started = tokio::task::spawn_blocking(move || {
                #[cfg(feature = "local-ai-proof")]
                std::thread::sleep(service.launch_delay);
                if *launch_cancel.borrow() {
                    return Err(ErrorCode::Cancelled);
                }
                OwnedChild::start(&launch, &key_for_launch, Some(&launch_cancel))
            });
            let mut launch_pending = true;
            let launch_result = tokio::select! {
                biased;
                _ = cancellation.changed() => Err(ErrorCode::Cancelled),
                _ = tokio::time::sleep_until(startup_deadline) => Err(ErrorCode::StartupFailed),
                result = &mut started => { launch_pending = false; result.unwrap_or(Err(ErrorCode::StartupFailed)) },
            };
            let mut launch_error = ErrorCode::StartupFailed;
            let mut child = match launch_result {
                Ok(child) => Some(child),
                Err(error) => {
                    launch_error = error;
                    None
                }
            };
            #[cfg(feature = "local-ai-proof")]
            if let Some(child) = &child {
                service
                    .proof_pid
                    .store(child.pid, std::sync::atomic::Ordering::SeqCst);
            }
            let outcome = if *cancellation.borrow() {
                Err(ErrorCode::Cancelled)
            } else if let Some(child) = child.as_mut() {
                tokio::select! {
                    biased;
                    _ = cancellation.changed() => Err(ErrorCode::Cancelled),
                    result = tokio::time::timeout_at(deadline, proxy::generate(child, &key, &request, deadline, startup_deadline)) => result.unwrap_or(Err(ErrorCode::Timeout)),
                }
            } else {
                Err(launch_error)
            };
            let result = {
                let mut owner = service.owner.lock().expect("local inference owner");
                let cancelled = owner
                    .active
                    .as_ref()
                    .is_some_and(|(_, signal)| *signal.borrow());
                // Abort any still-verifying launch on every terminal decision,
                // including timeout; the starter checks again after verification.
                if let Some((_, signal)) = &owner.active {
                    let _ = signal.send(true);
                }
                owner.active = None;
                owner.stopping = child.is_some() || launch_pending;
                if let Some(record) = owner.records.get_mut(&id) {
                    record.state = RecordState::Completed;
                    record.at = Instant::now();
                }
                if cancelled {
                    request.correlation.error(ErrorCode::Cancelled)
                } else {
                    match outcome {
                        Ok(output) => request.correlation.success(output),
                        Err(error) => request.correlation.error(error),
                    }
                }
            };
            let _ = reply.send(result);
            let cleanup = async {
                if launch_pending {
                    child = match started.await {
                        Ok(Ok(child)) => Some(child),
                        _ => None,
                    };
                }
                if let Some(mut child) = child.take() {
                    tokio::task::spawn_blocking(move || child.stop())
                        .await
                        .is_ok_and(|result| result.is_ok())
                } else {
                    true
                }
            };
            let cleanup_ok = tokio::time::timeout(Duration::from_secs(5), cleanup)
                .await
                .unwrap_or(false);
            let mut owner = service.owner.lock().expect("local inference owner");
            owner.cleanup_failed |= !cleanup_ok;
            owner.stopping = !cleanup_ok;
        });
        receive.await.map_err(|_| ErrorCode::Crash)
    }
    pub fn cancel(&self, id: String) -> Result<(), ErrorCode> {
        if !valid_uuid(&id) {
            return Err(ErrorCode::InvalidRequest);
        }
        let mut owner = self.owner.lock().map_err(|_| ErrorCode::Crash)?;
        owner.expire();
        if let Some((active, signal)) = &owner.active {
            if active == &id {
                let _ = signal.send(true);
                return Ok(());
            }
        }
        if owner.records.contains_key(&id) {
            return Ok(());
        }
        if owner.records.len() >= 32 {
            return Err(ErrorCode::Busy);
        }
        owner.records.insert(
            id,
            Record {
                at: Instant::now(),
                state: RecordState::Cancelled,
            },
        );
        Ok(())
    }
    pub async fn prepare_shutdown(&self) -> Result<(), ErrorCode> {
        {
            let mut owner = self.owner.lock().map_err(|_| ErrorCode::Crash)?;
            owner.shutdown = true;
            if let Some((_, signal)) = &owner.active {
                let _ = signal.send(true);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        for _ in 0..500 {
            {
                let owner = self.owner.lock().map_err(|_| ErrorCode::Crash)?;
                if owner.cleanup_failed {
                    return Err(ErrorCode::Crash);
                }
                if owner.active.is_none() && !owner.stopping {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Err(ErrorCode::Timeout)
    }
    pub fn resume(&self) -> Result<(), ErrorCode> {
        let mut owner = self.owner.lock().map_err(|_| ErrorCode::Crash)?;
        if owner.cleanup_failed || owner.stopping || owner.active.is_some() {
            return Err(ErrorCode::Busy);
        }
        owner.shutdown = false;
        Ok(())
    }
    pub fn shutdown_ready(&self) -> bool {
        self.owner.lock().is_ok_and(|owner| {
            owner.shutdown && owner.active.is_none() && !owner.stopping && !owner.cleanup_failed
        })
    }
    #[cfg(feature = "local-ai-proof")]
    pub fn proof_child_pid(&self) -> Option<u32> {
        let pid = self.proof_pid.load(std::sync::atomic::Ordering::SeqCst);
        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}
impl Owner {
    fn expire(&mut self) {
        self.records.retain(|_, record| {
            matches!(record.state, RecordState::Active)
                || record.at.elapsed() < Duration::from_secs(120)
        });
    }
}
