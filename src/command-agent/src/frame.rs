//! Framing: 1 type byte, a 4-byte big-endian payload length, then the payload.

use std::io::{self, Read, Write};

/// The largest payload either side sends or accepts.
pub const MAX_FRAME: usize = 1 << 20;

/// Frame types.
pub mod kind {
    /// Client → agent: the command header (first frame, once).
    pub const HEADER: u8 = b'H';
    /// Client → agent: stdin bytes.
    pub const STDIN: u8 = b'I';
    /// Client → agent: stdin reached end of file.
    pub const STDIN_EOF: u8 = b'E';
    /// Client → agent: the terminal's new window size.
    pub const WINDOW: u8 = b'W';
    /// Agent → client: stdout bytes (all terminal output with a tty).
    pub const STDOUT: u8 = b'O';
    /// Agent → client: stderr bytes.
    pub const STDERR: u8 = b'R';
    /// Agent → client: the exit code, an i32 big-endian. Always the last frame.
    pub const EXIT: u8 = b'X';
    /// Agent → client: a fixed failure reason token, followed by `EXIT` 125.
    pub const FAILURE: u8 = b'F';
}

/// Writes one frame with a single `write_all`, so frames from several threads sharing a locked
/// writer never interleave.
pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame too large",
        ));
    }
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    w.write_all(&buf)?;
    w.flush()
}

/// Reads one frame. A length over `MAX_FRAME` is refused before anything is allocated.
pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(k: u8, payload: &[u8]) {
        let mut buf = Vec::new();
        write_frame(&mut buf, k, payload).unwrap();
        let (got_kind, got) = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(got_kind, k);
        assert_eq!(got, payload);
    }

    #[test]
    fn every_kind_round_trips() {
        for k in [
            kind::HEADER,
            kind::STDIN,
            kind::STDIN_EOF,
            kind::WINDOW,
            kind::STDOUT,
            kind::STDERR,
            kind::EXIT,
            kind::FAILURE,
        ] {
            round_trip(k, b"payload bytes \x00\xff");
        }
    }

    #[test]
    fn empty_payload_round_trips() {
        round_trip(kind::STDIN_EOF, b"");
    }

    #[test]
    fn max_frame_round_trips() {
        round_trip(kind::STDOUT, &vec![7u8; MAX_FRAME]);
    }

    #[test]
    fn oversize_length_is_refused_on_read() {
        let mut buf = vec![kind::STDOUT];
        buf.extend_from_slice(&((MAX_FRAME as u32) + 1).to_be_bytes());
        let err = read_frame(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn oversize_payload_is_refused_on_write() {
        let mut buf = Vec::new();
        let err = write_frame(&mut buf, kind::STDOUT, &vec![0u8; MAX_FRAME + 1]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(buf.is_empty());
    }

    #[test]
    fn truncated_stream_is_eof() {
        let mut buf = Vec::new();
        write_frame(&mut buf, kind::STDOUT, b"hello").unwrap();
        buf.truncate(7);
        let err = read_frame(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        let err = read_frame(&mut &buf[..3]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }
}
