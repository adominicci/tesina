use super::FetchError;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

// Enumerate all assigned addresses, including inactive interfaces. Unknown or
// oversized OS results fail closed instead of weakening the local-host deny.
#[cfg(target_os = "macos")]
pub(super) fn read() -> Result<Vec<IpAddr>, FetchError> {
    struct Interfaces(*mut libc::ifaddrs);
    impl Drop for Interfaces {
        fn drop(&mut self) {
            unsafe {
                libc::freeifaddrs(self.0);
            }
        }
    }
    let mut head = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(FetchError::Unreadable);
    }
    let _owner = Interfaces(head);
    let mut current = head;
    let mut addresses = Vec::new();
    let mut rows = 0;
    while !current.is_null() {
        rows += 1;
        if rows > 4096 {
            return Err(FetchError::Unreadable);
        }
        let entry = unsafe { &*current };
        if !entry.ifa_addr.is_null() {
            let addr = unsafe { &*entry.ifa_addr };
            match i32::from(addr.sa_family) {
                libc::AF_INET
                    if usize::from(addr.sa_len) >= std::mem::size_of::<libc::sockaddr_in>() =>
                {
                    let addr = unsafe { &*entry.ifa_addr.cast::<libc::sockaddr_in>() };
                    addresses.push(Ipv4Addr::from(addr.sin_addr.s_addr.to_ne_bytes()).into());
                }
                libc::AF_INET6
                    if usize::from(addr.sa_len) >= std::mem::size_of::<libc::sockaddr_in6>() =>
                {
                    let addr = unsafe { &*entry.ifa_addr.cast::<libc::sockaddr_in6>() };
                    addresses.push(Ipv6Addr::from(addr.sin6_addr.s6_addr).into());
                }
                libc::AF_INET | libc::AF_INET6 => return Err(FetchError::Unreadable),
                _ => {}
            }
        }
        current = entry.ifa_next;
    }
    if addresses.is_empty() {
        return Err(FetchError::Unreadable);
    }
    Ok(addresses)
}

#[cfg(windows)]
pub(super) fn read() -> Result<Vec<IpAddr>, FetchError> {
    use windows::Win32::{NetworkManagement::IpHelper::*, Networking::WinSock::*};
    struct Table(*mut MIB_UNICASTIPADDRESS_TABLE);
    impl Drop for Table {
        fn drop(&mut self) {
            unsafe {
                FreeMibTable(self.0.cast());
            }
        }
    }
    let mut raw = std::ptr::null_mut();
    if unsafe { GetUnicastIpAddressTable(AF_UNSPEC, &mut raw) }.0 != 0 || raw.is_null() {
        return Err(FetchError::Unreadable);
    }
    let _owner = Table(raw);
    let count = unsafe { (*raw).NumEntries } as usize;
    if count == 0 || count > 4096 {
        return Err(FetchError::Unreadable);
    }
    let rows = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!((*raw).Table).cast::<MIB_UNICASTIPADDRESS_ROW>(),
            count,
        )
    };
    let mut addresses = Vec::with_capacity(count);
    for row in rows {
        unsafe {
            match row.Address.si_family {
                AF_INET => addresses.push(
                    Ipv4Addr::from(row.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes()).into(),
                ),
                AF_INET6 => {
                    addresses.push(Ipv6Addr::from(row.Address.Ipv6.sin6_addr.u.Byte).into())
                }
                _ => return Err(FetchError::Unreadable),
            }
        }
    }
    Ok(addresses)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn read() -> Result<Vec<IpAddr>, FetchError> {
    Err(FetchError::Unreadable)
}
