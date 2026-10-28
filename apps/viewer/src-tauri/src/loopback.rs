//! One-shot loopback redirect listener (RFC 8252 section 7.3). Binds
//! 127.0.0.1 only, serves a single expected path, and is dropped (closing the
//! socket) after the first callback that carries a code or an error, or when the
//! timeout elapses.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use url::Url;

use crate::error::AppError;

pub const CALLBACK_PATH: &str = "/callback";
/// Fixed loopback port for the OAuth redirect. A constant rather than an
/// ephemeral port so a single Login redirect URI can be registered up-front
/// with the IdP: some authorization servers (e.g. Okta) match a loopback
/// redirect by its exact port instead of the RFC 8252 §7.3 port-agnostic rule,
/// and a fresh random port every sign-in can never match one registration.
/// Operators register `http://127.0.0.1:8585/callback` as the redirect URI.
pub const CALLBACK_PORT: u16 = 8585;
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CONNECTIONS: usize = 32;

#[derive(Debug, Clone)]
pub struct Callback {
    /// `http://127.0.0.1:<port>/callback`
    pub redirect_uri: String,
}

pub async fn bind() -> Result<(Callback, TcpListener), AppError> {
    bind_on(CALLBACK_PORT).await
}

/// Binds the callback listener on `port`. Production uses [`CALLBACK_PORT`] via
/// [`bind`]; tests pass `0` for an ephemeral port so they never collide on the
/// fixed one.
pub(crate) async fn bind_on(port: u16) -> Result<(Callback, TcpListener), AppError> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|_| {
        AppError::Network(format!(
            "could not open the local callback listener on 127.0.0.1:{port} (already in use?)"
        ))
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| AppError::Network("could not read the local callback port".to_string()))?
        .port();
    Ok((
        Callback {
            redirect_uri: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        },
        listener,
    ))
}

/// Constant-time equality for secrets of public length.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// Waits for the callback of this sign-in attempt and returns the code.
///
/// Requests that are not a callback for this attempt (other paths, missing or
/// wrong `state`, duplicate parameters) get an error page and are ignored; only
/// a callback whose `state` matches ends the wait. `expected_iss` is the RFC
/// 9207 issuer, checked when the server sends one; with `require_iss` (the
/// server advertised support) a callback without it is refused. Each connection is served in
/// its own task so a stalled client cannot block the real callback. Consumes
/// the listener, so the port closes on every exit path.
pub async fn wait_for_code(
    listener: TcpListener,
    expected_state: &str,
    expected_iss: Option<&str>,
    require_iss: bool,
    timeout: Duration,
) -> Result<String, AppError> {
    tokio::time::timeout(
        timeout,
        accept_loop(&listener, expected_state, expected_iss, require_iss),
    )
    .await
    .map_err(|_| AppError::Timeout)?
}

async fn accept_loop(
    listener: &TcpListener,
    expected_state: &str,
    expected_iss: Option<&str>,
    require_iss: bool,
) -> Result<String, AppError> {
    let (tx, mut rx) = mpsc::channel::<Result<String, AppError>>(1);
    // Dropping the set on return aborts any connection still in flight.
    let mut tasks: JoinSet<()> = JoinSet::new();
    let state: std::sync::Arc<str> = expected_state.into();
    let iss: Option<std::sync::Arc<str>> = expected_iss.map(Into::into);
    loop {
        tokio::select! {
            outcome = rx.recv() => return outcome.unwrap_or(Err(AppError::Timeout)),
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                while tasks.try_join_next().is_some() {}
                if !peer.ip().is_loopback() || tasks.len() >= MAX_CONNECTIONS {
                    continue;
                }
                tasks.spawn(handle_connection(
                    stream,
                    state.clone(),
                    iss.clone(),
                    require_iss,
                    tx.clone(),
                ));
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    expected_state: std::sync::Arc<str>,
    expected_iss: Option<std::sync::Arc<str>>,
    require_iss: bool,
    done: mpsc::Sender<Result<String, AppError>>,
) {
    let Some(target) = read_target(&mut stream).await else {
        respond(&mut stream, "400 Bad Request", PAGE_ERROR).await;
        return;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(&mut stream, "400 Bad Request", PAGE_ERROR).await;
        return;
    };
    if url.path() != CALLBACK_PATH {
        respond(&mut stream, "404 Not Found", PAGE_NOT_FOUND).await;
        return;
    }
    match interpret(&url, &expected_state, expected_iss.as_deref(), require_iss) {
        Verdict::Ignore => respond(&mut stream, "400 Bad Request", PAGE_ERROR).await,
        Verdict::Finish(outcome) => {
            let (status, page) = match &outcome {
                Ok(_) => ("200 OK", PAGE_OK),
                Err(_) => ("400 Bad Request", PAGE_ERROR),
            };
            respond(&mut stream, status, page).await;
            let _ = done.try_send(outcome);
        }
    }
}

enum Verdict {
    /// Not a callback for this attempt: keep listening.
    Ignore,
    /// The callback for this attempt: stop listening.
    Finish(Result<String, AppError>),
}

fn interpret(
    url: &Url,
    expected_state: &str,
    expected_iss: Option<&str>,
    require_iss: bool,
) -> Verdict {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut iss = None;
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            "iss" => &mut iss,
            _ => continue,
        };
        if slot.replace(v.into_owned()).is_some() {
            return Verdict::Ignore;
        }
    }
    match state {
        Some(s) if constant_time_eq(s.as_bytes(), expected_state.as_bytes()) => {}
        _ => return Verdict::Ignore,
    }
    // From here the request belongs to this attempt, so the outcome is final.
    if require_iss && iss.is_none() {
        return Verdict::Finish(Err(AppError::Protocol(
            "callback missing issuer".to_string(),
        )));
    }
    if let (Some(got), Some(want)) = (iss.as_deref(), expected_iss)
        && got.trim_end_matches('/') != want.trim_end_matches('/')
    {
        return Verdict::Finish(Err(AppError::Protocol(
            "callback issuer mismatch".to_string(),
        )));
    }
    if let Some(e) = error {
        return Verdict::Finish(Err(if e == "access_denied" {
            AppError::Denied
        } else {
            AppError::Protocol(format!("authorization error: {}", sanitize_error_code(&e)))
        }));
    }
    Verdict::Finish(match code {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err(AppError::Protocol("callback had no code".to_string())),
    })
}

/// OAuth error codes are short ASCII tokens; anything else is not echoed.
fn sanitize_error_code(code: &str) -> &str {
    let ok = !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { code } else { "unrecognized" }
}

/// Reads the request head and returns the target of a `GET`.
async fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let read = async {
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(2).any(|w| w == b"\r\n") {
                return Some(());
            }
            if buf.len() > MAX_REQUEST_BYTES {
                return None;
            }
        }
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.ok()??;
    let line_end = buf.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&buf[..line_end]).ok()?;
    let mut parts = line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    target.starts_with('/').then(|| target.to_string())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>wardby viewer</title>\
<style>body{font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center}</style>\
<h1>Signed in</h1><p>You can close this tab and return to wardby viewer.</p>";
const PAGE_ERROR: &str = "<!doctype html><meta charset=utf-8><title>wardby viewer</title>\
<style>body{font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center}</style>\
<h1>Sign-in did not complete</h1><p>Return to wardby viewer and try again.</p>";
const PAGE_NOT_FOUND: &str =
    "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found.</p>";

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(addr: std::net::SocketAddr, target: &str) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    type Waiter = tokio::task::JoinHandle<Result<String, AppError>>;

    async fn start_iss(
        state: &'static str,
        iss: Option<&'static str>,
        timeout: Duration,
    ) -> (std::net::SocketAddr, Waiter) {
        start_iss_req(state, iss, false, timeout).await
    }

    async fn start_iss_req(
        state: &'static str,
        iss: Option<&'static str>,
        require_iss: bool,
        timeout: Duration,
    ) -> (std::net::SocketAddr, Waiter) {
        let (_, listener) = bind_on(0).await.unwrap();
        let addr = listener.local_addr().unwrap();
        (
            addr,
            tokio::spawn(wait_for_code(listener, state, iss, require_iss, timeout)),
        )
    }

    async fn start(state: &'static str, timeout: Duration) -> (std::net::SocketAddr, Waiter) {
        start_iss(state, None, timeout).await
    }

    const LONG: Duration = Duration::from_secs(10);

    #[tokio::test]
    async fn binds_loopback_and_reports_redirect() {
        let (cb, l) = bind_on(0).await.unwrap();
        let addr = l.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(
            cb.redirect_uri,
            format!("http://127.0.0.1:{}/callback", addr.port())
        );
    }

    #[tokio::test]
    async fn production_bind_uses_the_fixed_registered_port() {
        // The IdP registration is `http://127.0.0.1:8585/callback`; bind() must
        // honour that exact port, not an ephemeral one.
        let (cb, l) = bind().await.unwrap();
        assert_eq!(l.local_addr().unwrap().port(), CALLBACK_PORT);
        assert_eq!(
            cb.redirect_uri,
            format!("http://127.0.0.1:{CALLBACK_PORT}/callback")
        );
    }

    #[tokio::test]
    async fn success_returns_code_and_serves_page() {
        let (addr, h) = start("st4te", LONG).await;
        let resp = get(addr, "/callback?code=abc%20123&state=st4te").await;
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(resp.contains("Signed in"));
        assert_eq!(h.await.unwrap().unwrap(), "abc 123");
    }

    #[tokio::test]
    async fn ignores_other_paths_then_accepts_callback() {
        let (addr, h) = start("s", LONG).await;
        assert!(get(addr, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(
            get(addr, "/other?code=x&state=s")
                .await
                .starts_with("HTTP/1.1 404")
        );
        get(addr, "/callback?code=good&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "good");
    }

    #[tokio::test]
    async fn wrong_state_gets_error_page_and_listener_keeps_waiting() {
        let (addr, h) = start("right", LONG).await;
        let resp = get(addr, "/callback?code=secretcode&state=wrong").await;
        assert!(resp.starts_with("HTTP/1.1 400"));
        assert!(!resp.contains("secretcode"));
        assert!(!h.is_finished());
        assert!(
            get(addr, "/callback?error=access_denied")
                .await
                .starts_with("HTTP/1.1 400")
        );
        assert!(!h.is_finished());
        get(addr, "/callback?code=real&state=right").await;
        assert_eq!(h.await.unwrap().unwrap(), "real");
    }

    #[tokio::test]
    async fn duplicate_params_are_ignored_not_terminal() {
        let (addr, h) = start("s", LONG).await;
        assert!(
            get(addr, "/callback?code=a&code=b&state=s")
                .await
                .starts_with("HTTP/1.1 400")
        );
        assert!(!h.is_finished());
        get(addr, "/callback?code=ok&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "ok");
    }

    #[tokio::test]
    async fn access_denied_with_valid_state_maps_to_denied() {
        let (addr, h) = start("s", LONG).await;
        let resp = get(addr, "/callback?error=access_denied&state=s").await;
        assert!(resp.starts_with("HTTP/1.1 400"));
        assert!(matches!(h.await.unwrap(), Err(AppError::Denied)));
    }

    #[tokio::test]
    async fn other_error_codes_become_protocol_errors_with_the_code() {
        let (addr, h) = start("s", LONG).await;
        get(addr, "/callback?error=invalid_scope&state=s").await;
        match h.await.unwrap() {
            Err(AppError::Protocol(m)) => assert!(m.contains("invalid_scope")),
            other => panic!("unexpected: {other:?}"),
        }
        let (addr, h) = start("s", LONG).await;
        get(addr, "/callback?error=%3Cscript%3E&state=s").await;
        match h.await.unwrap() {
            Err(AppError::Protocol(m)) => assert!(!m.contains("script")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn iss_mismatch_is_a_protocol_error_and_match_or_absence_is_fine() {
        let (addr, h) = start_iss("s", Some("https://as.example/mcp"), LONG).await;
        get(
            addr,
            "/callback?code=c&state=s&iss=https%3A%2F%2Fevil.example",
        )
        .await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Protocol(_))));
        let (addr, h) = start_iss("s", Some("https://as.example/mcp"), LONG).await;
        get(
            addr,
            "/callback?code=c&state=s&iss=https%3A%2F%2Fas.example%2Fmcp",
        )
        .await;
        assert_eq!(h.await.unwrap().unwrap(), "c");
        let (addr, h) = start_iss("s", Some("https://as.example/mcp"), LONG).await;
        get(addr, "/callback?code=c2&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "c2");
    }

    #[tokio::test]
    async fn a_required_iss_must_be_present_and_match() {
        let want = Some("https://as.example/mcp");
        let (addr, h) = start_iss_req("s", want, true, LONG).await;
        get(addr, "/callback?code=c&state=s").await;
        assert!(
            matches!(h.await.unwrap(), Err(AppError::Protocol(m)) if m == "callback missing issuer")
        );
        let (addr, h) = start_iss_req("s", want, true, LONG).await;
        get(
            addr,
            "/callback?code=c&state=s&iss=https%3A%2F%2Fevil.example",
        )
        .await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Protocol(_))));
        let (addr, h) = start_iss_req("s", want, true, LONG).await;
        get(
            addr,
            "/callback?code=c&state=s&iss=https%3A%2F%2Fas.example%2Fmcp",
        )
        .await;
        assert_eq!(h.await.unwrap().unwrap(), "c");
    }

    #[tokio::test]
    async fn non_get_is_ignored() {
        let (addr, h) = start("s", LONG).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"POST /callback?code=x&state=s HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 400"));
        get(addr, "/callback?code=ok&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "ok");
    }

    #[tokio::test]
    async fn stalled_connection_does_not_block_the_real_callback() {
        let (addr, h) = start("s", LONG).await;
        let _stalled = TcpStream::connect(addr).await.unwrap(); // sends nothing
        let started = std::time::Instant::now();
        get(addr, "/callback?code=fast&state=s").await;
        assert_eq!(h.await.unwrap().unwrap(), "fast");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn times_out_and_closes_port() {
        let (addr, h) = start("s", Duration::from_millis(150)).await;
        assert!(matches!(h.await.unwrap(), Err(AppError::Timeout)));
        assert!(TcpStream::connect(addr).await.is_err());
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
