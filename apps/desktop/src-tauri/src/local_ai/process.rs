use super::contract::ErrorCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
#[path = "guardian_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "job_windows.rs"]
mod platform;
#[cfg(all(windows, feature = "local-ai-proof"))]
pub use platform::proof_startup_snapshot;
#[cfg(any(target_os = "macos", windows))]
pub use platform::{guardian_entry, OwnedChild};

pub const FLAGS: &[&str] = &[
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
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub root: PathBuf,
    pub path: PathBuf,
    pub digest: String,
}
impl Artifact {
    #[cfg(feature = "local-ai-proof")]
    pub fn fixture(path: PathBuf) -> Result<Self, ErrorCode> {
        let path = path.canonicalize().map_err(|_| ErrorCode::SidecarAbsent)?;
        let root = path.parent().ok_or(ErrorCode::SidecarAbsent)?.to_owned();
        let digest = hash(&path)?;
        Ok(Self { root, path, digest })
    }
    pub fn verify(&self) -> Result<(), ErrorCode> {
        let relative = self
            .path
            .strip_prefix(&self.root)
            .map_err(|_| ErrorCode::StartupFailed)?;
        if self
            .root
            .canonicalize()
            .map_err(|_| ErrorCode::StartupFailed)?
            != self.root
        {
            return Err(ErrorCode::StartupFailed);
        }
        let mut current = self.root.clone();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err(ErrorCode::StartupFailed);
            }
            current.push(component);
            let metadata =
                std::fs::symlink_metadata(&current).map_err(|_| ErrorCode::StartupFailed)?;
            if metadata.file_type().is_symlink() {
                return Err(ErrorCode::StartupFailed);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(ErrorCode::StartupFailed);
                }
            }
        }
        if !self.path.is_file() || hash(&self.path)? != self.digest {
            return Err(ErrorCode::StartupFailed);
        }
        Ok(())
    }
}
fn hash(path: &Path) -> Result<String, ErrorCode> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| ErrorCode::StartupFailed)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| ErrorCode::StartupFailed)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub executable: Artifact,
    pub model: Artifact,
}
impl Launch {
    pub fn verify(&self) -> Result<(), ErrorCode> {
        self.executable.verify()?;
        self.model.verify()
    }
}

pub fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn guardian_entry() -> bool {
    false
}
