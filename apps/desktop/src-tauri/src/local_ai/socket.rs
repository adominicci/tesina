use super::contract::ErrorCode;
use std::net::{Ipv4Addr, SocketAddr};
use tokio::net::TcpStream;
use tokio::time::{Duration, Instant};
#[cfg(all(test, target_os = "macos"))]
#[path = "socket_process_tests.rs"]
mod process_tests;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Row {
    local_address: u32,
    remote_address: u32,
    local_port: u16,
    remote_port: u16,
    state: u32,
}

#[cfg(target_os = "macos")]
fn rows(pid: u32) -> Result<Vec<Row>, ErrorCode> {
    unsafe extern "C" {
        fn tesina_tcp_rows(pid: i32, out: *mut Row, capacity: i32) -> i32;
    }
    let mut rows = vec![Row::default(); 256];
    let count = unsafe {
        tesina_tcp_rows(
            pid.try_into().map_err(|_| ErrorCode::StartupFailed)?,
            rows.as_mut_ptr(),
            rows.len() as i32,
        )
    };
    if count < 0 || count as usize > rows.len() {
        return Err(ErrorCode::StartupFailed);
    }
    rows.truncate(count as usize);
    Ok(rows)
}
#[cfg(windows)]
fn rows(pid: u32) -> Result<Vec<Row>, ErrorCode> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    let mut bytes = 0;
    unsafe {
        GetExtendedTcpTable(
            None,
            &mut bytes,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if bytes == 0 || bytes > 1024 * 1024 {
        return Err(ErrorCode::StartupFailed);
    }
    // u64 storage supplies alignment for the OS table, without unchecked casts from bytes.
    let mut table = vec![0u64; (bytes as usize + 7) / 8];
    let result = unsafe {
        GetExtendedTcpTable(
            Some(table.as_mut_ptr().cast()),
            &mut bytes,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if result != 0 {
        return Err(ErrorCode::StartupFailed);
    }
    let table = unsafe { &*table.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>() };
    let count = table.dwNumEntries as usize;
    if count > (bytes as usize).saturating_sub(4) / std::mem::size_of_val(&table.table[0]) {
        return Err(ErrorCode::StartupFailed);
    }
    Ok(
        unsafe { std::slice::from_raw_parts(table.table.as_ptr(), count) }
            .iter()
            .filter(|row| row.dwOwningPid == pid && matches!(row.dwState, 2 | 5))
            .map(|r| Row {
                local_address: u32::from_be(r.dwLocalAddr),
                remote_address: u32::from_be(r.dwRemoteAddr),
                local_port: u16::from_be(r.dwLocalPort as u16),
                remote_port: u16::from_be(r.dwRemotePort as u16),
                state: if r.dwState == 2 { 1 } else { 2 },
            })
            .collect(),
    )
}
#[cfg(not(any(target_os = "macos", windows)))]
fn rows(_: u32) -> Result<Vec<Row>, ErrorCode> {
    Err(ErrorCode::UnsupportedPlatform)
}

pub fn listener(pid: u32) -> Result<Option<u16>, ErrorCode> {
    let ports: Vec<_> = rows(pid)?
        .into_iter()
        .filter(|r| r.state == 1 && r.local_address == u32::from(Ipv4Addr::LOCALHOST))
        .collect();
    match ports.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(row.local_port)),
        _ => Err(ErrorCode::StartupFailed),
    }
}
/// Returns a stream only after inspecting the reverse tuple at the owned PID.
/// No application bytes are written before this function returns.
pub async fn connect(pid: u32, port: u16, deadline: Instant) -> Result<TcpStream, ErrorCode> {
    let stream = tokio::time::timeout_at(deadline, TcpStream::connect((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|_| ErrorCode::Timeout)?
        .map_err(|_| ErrorCode::StartupFailed)?;
    let SocketAddr::V4(local) = stream.local_addr().map_err(|_| ErrorCode::StartupFailed)? else {
        return Err(ErrorCode::StartupFailed);
    };
    let proof_deadline = deadline.min(Instant::now() + Duration::from_millis(200));
    for _ in 0..20 {
        if rows(pid)?.iter().any(|r| {
            r.state == 2
                && r.local_address == u32::from(Ipv4Addr::LOCALHOST)
                && r.local_port == port
                && r.remote_address == u32::from(*local.ip())
                && r.remote_port == local.port()
        }) {
            return Ok(stream);
        }
        if Instant::now() >= proof_deadline {
            break;
        }
        tokio::time::sleep_until(proof_deadline.min(Instant::now() + Duration::from_millis(10)))
            .await;
    }
    Err(ErrorCode::StartupFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn actual_reverse_tuple_succeeds_and_wrong_pid_receives_no_bytes() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move { listener.accept().await.unwrap().0 });
        let client = connect(
            std::process::id(),
            port,
            Instant::now() + Duration::from_secs(1),
        )
        .await
        .unwrap();
        let peer = accept.await.unwrap();
        assert_eq!(client.local_addr().unwrap(), peer.peer_addr().unwrap());
        drop(client);
        drop(peer);
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut byte = [0];
            stream.read(&mut byte).await.unwrap()
        });
        assert!(
            connect(u32::MAX, port, Instant::now() + Duration::from_secs(1))
                .await
                .is_err()
        );
        assert_eq!(accept.await.unwrap(), 0);
    }
}
