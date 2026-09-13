use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};

// Hyper follows RFC normalization for conflicting framing. The sidecar contract
// is stricter: inspect the original bounded header before Hyper can discard it.
pub(super) struct GuardedStream {
    stream: TcpStream,
    header: Vec<u8>,
    complete: bool,
}
impl GuardedStream {
    pub(super) fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            header: Vec::new(),
            complete: false,
        }
    }
    fn inspect(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            if self.complete {
                break;
            }
            if self.header.len() == 16 * 1024 {
                return Err(invalid());
            }
            if (*byte == b'\n' && self.header.last() != Some(&b'\r'))
                || (self.header.last() == Some(&b'\r') && *byte != b'\n')
            {
                return Err(invalid());
            }
            self.header.push(*byte);
            if self.header.ends_with(b"\r\n\r\n") {
                validate_header(&self.header)?;
                self.complete = true;
                self.header.clear();
            }
        }
        Ok(())
    }
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid sidecar response framing",
    )
}
fn validate_header(bytes: &[u8]) -> io::Result<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut lines = text.split("\r\n");
    let status = lines.next().ok_or_else(invalid)?;
    // No interim response or protocol switch is part of the fixed protocol.
    if status
        .split(' ')
        .nth(1)
        .is_none_or(|code| code.starts_with('1'))
    {
        return Err(invalid());
    }
    let mut length = false;
    let mut transfer = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("content-length") {
            if length || transfer {
                return Err(invalid());
            }
            let value = value.trim();
            if value.is_empty()
                || !value.bytes().all(|b| b.is_ascii_digit())
                || value
                    .parse::<usize>()
                    .ok()
                    .is_none_or(|n| n > super::contract::OUTPUT_BYTES)
            {
                return Err(invalid());
            }
            length = true;
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if transfer || length || !value.trim().eq_ignore_ascii_case("chunked") {
                return Err(invalid());
            }
            transfer = true;
        }
    }
    Ok(())
}
impl AsyncRead for GuardedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let start = buf.filled().len();
        match Pin::new(&mut this.stream).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if !this.complete && buf.filled().len() == start {
                    return Poll::Ready(Err(invalid()));
                }
                Poll::Ready(this.inspect(&buf.filled()[start..]))
            }
            result => result,
        }
    }
}
impl AsyncWrite for GuardedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}
