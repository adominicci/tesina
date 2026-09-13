use super::contract::ErrorCode;
use std::path::PathBuf;

pub fn installed_model() -> Option<PathBuf> {
    None
}

pub fn evaluate(
    os: &str,
    arch: &str,
    version: (u32, u32),
    sidecar: bool,
    model: bool,
    busy: bool,
) -> Result<&'static str, ErrorCode> {
    if !matches!(os, "macos" | "windows") {
        return Err(ErrorCode::UnsupportedPlatform);
    }
    if (os == "macos" && (!matches!(arch, "aarch64" | "x86_64") || version < (13, 3)))
        || (os == "windows" && (arch != "x86_64" || version < (10, 0)))
    {
        return Err(ErrorCode::UnsupportedHardware);
    }
    if !sidecar {
        return Err(ErrorCode::SidecarAbsent);
    }
    if !model {
        return Err(ErrorCode::NotInstalled);
    }
    Ok(if busy { "busy" } else { "ready" })
}

#[cfg(target_os = "macos")]
pub fn os_version() -> (u32, u32) {
    let mut bytes = [0u8; 64];
    let mut len = bytes.len();
    // Fixed public kernel property, no shell invocation or environment value.
    let ok = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if !ok || len > bytes.len() {
        return (0, 0);
    }
    let text = std::str::from_utf8(&bytes[..len])
        .unwrap_or("")
        .trim_end_matches('\0');
    let mut parts = text.split('.');
    (
        parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
        parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
    )
}
#[cfg(windows)]
pub fn os_version() -> (u32, u32) {
    #[repr(C)]
    struct OsVersion {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version: *mut OsVersion) -> i32;
    }
    let mut version = OsVersion {
        size: std::mem::size_of::<OsVersion>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service: [0; 128],
    };
    if unsafe { RtlGetVersion(&mut version) } == 0 {
        (version.major, version.minor)
    } else {
        (0, 0)
    }
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn os_version() -> (u32, u32) {
    (0, 0)
}
