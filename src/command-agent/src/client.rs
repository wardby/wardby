//! `wardby-cmd run`: forwards one command to the agent and becomes its stand-in: the remote
//! command's output on this process's stdout/stderr, its exit code as this process's.
//!
//! Every failure of wardby-cmd itself exits 125 with one fixed `wardby-cmd: <code>` line.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::env;
use crate::frame::{self, kind};
use crate::header::{self, Header, PROTOCOL_VERSION, Window};
use crate::server::{AGENT_FAILURE, read_token};
use crate::sys;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_WINDOW: Window = Window { rows: 24, cols: 80 };
const WINDOW_POLL: Duration = Duration::from_millis(250);

fn unusable() -> i32 {
    eprintln!("wardby-cmd: toolchain_unusable:agent");
    AGENT_FAILURE
}

/// The fixed line printed for an `F` reason token.
fn failure_line(reason: &[u8]) -> &'static str {
    match reason {
        b"shell" => "wardby-cmd: toolchain_unusable:shell",
        b"setup_failed" => "wardby-cmd: toolchain_setup_failed",
        _ => "wardby-cmd: toolchain_unusable:agent",
    }
}

fn resolve(addr: &str) -> Option<SocketAddr> {
    addr.to_socket_addrs().ok()?.next()
}

/// Connects within the timeout: `ready` and `run` both use it.
pub fn connect(addr: &str, timeout: Duration) -> Option<TcpStream> {
    TcpStream::connect_timeout(&resolve(addr)?, timeout).ok()
}

type Writer = Arc<Mutex<TcpStream>>;

fn send(w: &Writer, k: u8, payload: &[u8]) -> io::Result<()> {
    let mut s = w.lock().unwrap_or_else(|e| e.into_inner());
    frame::write_frame(&mut *s, k, payload)
}

/// Runs `argv` in the toolchain; returns the exit code to exit with.
pub fn run(addr: &str, token_file: &Path, argv: Vec<String>, tty: bool) -> i32 {
    let Some(token) = read_token(token_file) else {
        return unusable();
    };
    let Some(conn) = connect(addr, CONNECT_TIMEOUT) else {
        return unusable();
    };
    sys::on_termination(conn.as_raw_fd());
    let Ok(writer) = conn.try_clone() else {
        return unusable();
    };
    let w: Writer = Arc::new(Mutex::new(writer));

    let stdin_is_tty = sys::isatty(0);
    let vars = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "/".to_string());
    let h = Header {
        version: PROTOCOL_VERSION,
        token,
        argv,
        cwd,
        env: env::forwarded(vars),
        tty: tty.then(|| sys::window_of(0).unwrap_or(DEFAULT_WINDOW)),
    };
    if send(&w, kind::HEADER, &h.encode()).is_err() {
        return lost();
    }
    drop(h);

    let raw = if tty && stdin_is_tty {
        sys::raw_mode(0)
    } else {
        None
    };
    forward_stdin(w.clone());
    if tty && stdin_is_tty {
        forward_window(w.clone());
    }
    let code = receive(conn);
    drop(raw);
    code
}

fn lost() -> i32 {
    eprintln!("wardby-cmd: connection lost");
    AGENT_FAILURE
}

fn forward_stdin(w: Writer) {
    thread::spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        let mut stdin = io::stdin().lock();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => {
                    let _ = send(&w, kind::STDIN_EOF, &[]);
                    return;
                }
                Ok(n) => {
                    if send(&w, kind::STDIN, &buf[..n]).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => {
                    let _ = send(&w, kind::STDIN_EOF, &[]);
                    return;
                }
            }
        }
    });
}

fn forward_window(w: Writer) {
    thread::spawn(move || {
        let mut last = sys::window_of(0);
        loop {
            thread::sleep(WINDOW_POLL);
            let now = sys::window_of(0);
            if now != last {
                if let Some(win) = now
                    && send(&w, kind::WINDOW, &header::window_bytes(win)).is_err()
                {
                    return;
                }
                last = now;
            }
        }
    });
}

fn receive(mut conn: TcpStream) -> i32 {
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    loop {
        match frame::read_frame(&mut conn) {
            Ok((kind::STDOUT, p)) => {
                let _ = stdout.write_all(&p);
                let _ = stdout.flush();
            }
            Ok((kind::STDERR, p)) => {
                let _ = stderr.write_all(&p);
            }
            Ok((kind::FAILURE, reason)) => {
                let _ = writeln!(stderr, "{}", failure_line(&reason));
            }
            Ok((kind::EXIT, p)) => {
                let _ = stdout.flush();
                return match <[u8; 4]>::try_from(p.as_slice()) {
                    Ok(b) => i32::from_be_bytes(b),
                    Err(_) => lost(),
                };
            }
            Ok(_) => {}
            Err(_) => return lost(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_reasons_map_to_fixed_lines() {
        assert_eq!(
            failure_line(b"shell"),
            "wardby-cmd: toolchain_unusable:shell"
        );
        assert_eq!(
            failure_line(b"setup_failed"),
            "wardby-cmd: toolchain_setup_failed"
        );
        assert_eq!(
            failure_line(b"version"),
            "wardby-cmd: toolchain_unusable:agent"
        );
        assert_eq!(
            failure_line(b"anything else"),
            "wardby-cmd: toolchain_unusable:agent"
        );
    }
}
