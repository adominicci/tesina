use super::FetchError;
use std::io::{self, Write};

const LIMIT: usize = 4_000_000;
#[derive(Default)]
struct Capped(Vec<u8>);
impl Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.0.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reference body limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) struct Body(Decoder);
enum Decoder {
    Identity(Capped),
    Gzip(flate2::write::MultiGzDecoder<Capped>),
}
impl Body {
    pub(super) fn new(encoding: Option<&str>) -> Result<Self, FetchError> {
        match encoding.map(str::trim) {
            None | Some("identity") => Ok(Self(Decoder::Identity(Capped::default()))),
            Some(value) if value.eq_ignore_ascii_case("gzip") => Ok(Self(Decoder::Gzip(
                flate2::write::MultiGzDecoder::new(Capped::default()),
            ))),
            _ => Err(FetchError::Unreadable),
        }
    }
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<(), FetchError> {
        match &mut self.0 {
            Decoder::Identity(out) => out.write_all(bytes),
            Decoder::Gzip(out) => out.write_all(bytes),
        }
        .map_err(|_| FetchError::Unreadable)
    }
    pub(super) fn finish(self) -> Result<String, FetchError> {
        let bytes = match self.0 {
            Decoder::Identity(out) => out.0,
            Decoder::Gzip(out) => out.finish().map_err(|_| FetchError::Unreadable)?.0,
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if text.len() > LIMIT {
            return Err(FetchError::Unreadable);
        }
        Ok(text)
    }
}
