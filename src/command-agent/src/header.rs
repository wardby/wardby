//! The `H` frame: what to run, where, with which environment, and whether on a terminal.
//!
//! Layout (all integers big-endian): `version u16 | token | argv count u32 + strings |
//! cwd | env count u32 + (key, value) strings | tty u8` where tty is `0` (none) or `1` followed by
//! `rows u16 | cols u16`. Each string is a u32 length and UTF-8 bytes without NUL. Counts are at
//! most `MAX_COUNT`; trailing bytes are refused.

use std::fmt;

/// The wire protocol version. Bump on any change to framing or the header layout.
pub const PROTOCOL_VERSION: u16 = 1;

/// The most argv entries or env pairs a header may carry.
pub const MAX_COUNT: u32 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Header {
    pub version: u16,
    pub token: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub tty: Option<Window>,
}

/// Never prints the token, argv, cwd or env: a header must not reach a log by accident.
impl fmt::Debug for Header {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Header")
            .field("version", &self.version)
            .field("argc", &self.argv.len())
            .field("envc", &self.env.len())
            .field("tty", &self.tty)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum HeaderError {
    /// The header names another protocol version; the rest is not parsed.
    Version(u16),
    /// The header is malformed.
    Invalid,
}

impl Header {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.version.to_be_bytes());
        put_str(&mut out, &self.token);
        out.extend_from_slice(&(self.argv.len() as u32).to_be_bytes());
        for a in &self.argv {
            put_str(&mut out, a);
        }
        put_str(&mut out, &self.cwd);
        out.extend_from_slice(&(self.env.len() as u32).to_be_bytes());
        for (k, v) in &self.env {
            put_str(&mut out, k);
            put_str(&mut out, v);
        }
        match self.tty {
            None => out.push(0),
            Some(w) => {
                out.push(1);
                out.extend_from_slice(&window_bytes(w));
            }
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Header, HeaderError> {
        let mut c = Cursor { bytes, at: 0 };
        let version = c.u16().ok_or(HeaderError::Invalid)?;
        if version != PROTOCOL_VERSION {
            return Err(HeaderError::Version(version));
        }
        let token = c.string().ok_or(HeaderError::Invalid)?;
        let argc = c.count().ok_or(HeaderError::Invalid)?;
        let mut argv = Vec::with_capacity(argc as usize);
        for _ in 0..argc {
            argv.push(c.string().ok_or(HeaderError::Invalid)?);
        }
        let cwd = c.string().ok_or(HeaderError::Invalid)?;
        let envc = c.count().ok_or(HeaderError::Invalid)?;
        let mut env = Vec::with_capacity(envc as usize);
        for _ in 0..envc {
            let k = c.string().ok_or(HeaderError::Invalid)?;
            let v = c.string().ok_or(HeaderError::Invalid)?;
            env.push((k, v));
        }
        let tty = match c.u8().ok_or(HeaderError::Invalid)? {
            0 => None,
            1 => Some(
                parse_window(c.take(4).ok_or(HeaderError::Invalid)?).ok_or(HeaderError::Invalid)?,
            ),
            _ => return Err(HeaderError::Invalid),
        };
        if c.at != bytes.len() {
            return Err(HeaderError::Invalid);
        }
        Ok(Header {
            version,
            token,
            argv,
            cwd,
            env,
            tty,
        })
    }
}

/// The `W` frame payload and the header's window field: `rows u16 | cols u16`.
pub fn window_bytes(w: Window) -> [u8; 4] {
    let r = w.rows.to_be_bytes();
    let c = w.cols.to_be_bytes();
    [r[0], r[1], c[0], c[1]]
}

pub fn parse_window(p: &[u8]) -> Option<Window> {
    match p {
        [r0, r1, c0, c1] => Some(Window {
            rows: u16::from_be_bytes([*r0, *r1]),
            cols: u16::from_be_bytes([*c0, *c1]),
        }),
        _ => None,
    }
}

/// Constant-time token comparison (the length is not secret).
pub fn token_matches(given: &[u8], expected: &[u8]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    given
        .iter()
        .zip(expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let s = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn count(&mut self) -> Option<u32> {
        self.u32().filter(|n| *n <= MAX_COUNT)
    }
    fn string(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let raw = self.take(len)?;
        if raw.contains(&0) {
            return None;
        }
        String::from_utf8(raw.to_vec()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(tty: Option<Window>) -> Header {
        Header {
            version: PROTOCOL_VERSION,
            token: "tok-123".into(),
            argv: vec!["/bin/sh".into(), "-c".into(), "echo hi".into()],
            cwd: "/workspace".into(),
            env: vec![("A".into(), "1".into()), ("EMPTY".into(), String::new())],
            tty,
        }
    }

    #[test]
    fn round_trip_without_tty() {
        let h = sample(None);
        assert_eq!(Header::decode(&h.encode()).unwrap(), h);
    }

    #[test]
    fn round_trip_with_tty() {
        let h = sample(Some(Window {
            rows: 40,
            cols: 120,
        }));
        assert_eq!(Header::decode(&h.encode()).unwrap(), h);
    }

    #[test]
    fn other_version_is_reported_without_parsing_the_rest() {
        let mut bytes = 99u16.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"garbage");
        assert_eq!(Header::decode(&bytes), Err(HeaderError::Version(99)));
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut bytes = sample(None).encode();
        bytes.push(0);
        assert_eq!(Header::decode(&bytes), Err(HeaderError::Invalid));
    }

    #[test]
    fn truncated_header_is_refused() {
        let bytes = sample(Some(Window { rows: 1, cols: 2 })).encode();
        for n in 0..bytes.len() {
            assert_eq!(
                Header::decode(&bytes[..n]),
                Err(HeaderError::Invalid),
                "prefix {n}"
            );
        }
    }

    #[test]
    fn nul_in_a_string_is_refused() {
        let mut h = sample(None);
        h.argv[2] = "echo\0hi".into();
        assert_eq!(Header::decode(&h.encode()), Err(HeaderError::Invalid));
    }

    #[test]
    fn invalid_utf8_is_refused() {
        let mut bytes = PROTOCOL_VERSION.to_be_bytes().to_vec();
        bytes.extend_from_slice(&2u32.to_be_bytes());
        bytes.extend_from_slice(&[0xc3, 0x28]);
        bytes.extend_from_slice(&0u32.to_be_bytes()); // argv
        bytes.extend_from_slice(&0u32.to_be_bytes()); // cwd ""
        bytes.extend_from_slice(&0u32.to_be_bytes()); // env
        bytes.push(0);
        assert_eq!(Header::decode(&bytes), Err(HeaderError::Invalid));
    }

    #[test]
    fn count_over_the_limit_is_refused() {
        let mut bytes = PROTOCOL_VERSION.to_be_bytes().to_vec();
        bytes.extend_from_slice(&0u32.to_be_bytes()); // token ""
        bytes.extend_from_slice(&(MAX_COUNT + 1).to_be_bytes());
        assert_eq!(Header::decode(&bytes), Err(HeaderError::Invalid));
    }

    #[test]
    fn unknown_tty_byte_is_refused() {
        let mut bytes = sample(None).encode();
        *bytes.last_mut().unwrap() = 2;
        assert_eq!(Header::decode(&bytes), Err(HeaderError::Invalid));
    }

    #[test]
    fn debug_never_shows_values() {
        let shown = format!("{:?}", sample(None));
        assert!(!shown.contains("tok-123"));
        assert!(!shown.contains("echo hi"));
        assert!(!shown.contains("/workspace"));
    }

    #[test]
    fn window_round_trips() {
        let w = Window { rows: 513, cols: 2 };
        assert_eq!(parse_window(&window_bytes(w)), Some(w));
        assert_eq!(parse_window(&[0, 1, 2]), None);
    }

    #[test]
    fn token_comparison() {
        assert!(token_matches(b"abc", b"abc"));
        assert!(!token_matches(b"abd", b"abc"));
        assert!(!token_matches(b"ab", b"abc"));
        assert!(!token_matches(b"", b"abc"));
    }
}
