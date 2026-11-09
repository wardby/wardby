//! Reconnecting reader for the server's `/admin/api/events` SSE stream.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::api::Session;
use crate::error::AppError;

/// What the stream tells the UI. Two connection signals only:
///
/// * `Reconnecting` - the connection is down (it dropped, failed, or went
///   quiet) and the task will try again after `delay_ms`. Show "reconnecting".
///   `attempt` counts consecutive reconnects since the last stable connection.
/// * `Ended` - the task has stopped for good and will not retry (not signed
///   in, or the account is forbidden). Show the error; restart after the user
///   fixes it.
///
/// After every (re)connect the server sends `Hello` first, then `Resync` once
/// it is live: refetch the graph on `Resync`.
#[derive(Debug)]
pub enum StreamFrame {
    Hello {
        connected: bool,
    },
    Status {
        connected: bool,
    },
    Resync,
    Event {
        kind: String,
        data: serde_json::Value,
    },
    Reconnecting {
        attempt: u32,
        delay_ms: u64,
    },
    Ended {
        error: AppError,
    },
}

#[derive(Clone, Debug)]
pub struct EventsConfig {
    /// Used until the server sends its own `retry:`.
    pub default_retry: Duration,
    /// Floor for any delay (a server `retry: 0` must not cause a tight loop).
    pub min_retry: Duration,
    /// Cap for the exponential backoff.
    pub max_backoff: Duration,
    /// No bytes (pings included) for this long means the connection is dead.
    pub idle_timeout: Duration,
    /// A connection must stay up this long before failures are forgiven.
    pub stable_after: Duration,
    /// Largest single SSE event (bytes since the last blank line).
    pub max_event_bytes: usize,
}

impl Default for EventsConfig {
    fn default() -> Self {
        Self {
            default_retry: Duration::from_millis(3000),
            min_retry: Duration::from_millis(500),
            max_backoff: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(45),
            stable_after: Duration::from_secs(30),
            max_event_bytes: 1024 * 1024,
        }
    }
}

/// Handle to the running stream task. Dropping it stops the stream.
pub struct EventsHandle {
    inner: tokio::task::JoinHandle<()>,
}

impl EventsHandle {
    pub fn abort(&self) {
        self.inner.abort();
    }

    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }

    /// Resolves when the task ends on its own (`Ended`) or is aborted.
    pub async fn wait(mut self) {
        let _ = (&mut self.inner).await;
    }
}

impl Drop for EventsHandle {
    fn drop(&mut self) {
        self.inner.abort();
    }
}

pub fn spawn_events(
    session: Arc<Session>,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
) -> EventsHandle {
    spawn_events_with(session, emit, EventsConfig::default())
}

pub fn spawn_events_with(
    session: Arc<Session>,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
    cfg: EventsConfig,
) -> EventsHandle {
    let never: SessionBuilder =
        Box::new(|| Box::pin(async { Err(AppError::Protocol("no session".to_string())) }));
    spawn_events_lazy(Some(session), never, emit, cfg)
}

/// Builds the session the stream runs on; called again after each failure
/// until it succeeds.
pub type SessionBuilder = Box<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Arc<Session>, AppError>> + Send>,
        > + Send
        + Sync,
>;

/// Like `spawn_events_with`, but the session may not exist yet: while `build`
/// fails with a retryable error the task emits `Reconnecting` and tries again
/// with the usual backoff, so a transient failure at startup heals by itself.
pub fn spawn_events_lazy(
    session: Option<Arc<Session>>,
    build: SessionBuilder,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
    cfg: EventsConfig,
) -> EventsHandle {
    EventsHandle {
        inner: tokio::spawn(run(session, build, emit, cfg)),
    }
}

/// Delay before reconnect number `failures` (1-based): the server's `retry`
/// (default 3 s), doubling per consecutive failure, bounded below and above.
fn backoff(base: Duration, failures: u32, cfg: &EventsConfig) -> Duration {
    let factor = 1u32 << failures.saturating_sub(1).min(16);
    base.saturating_mul(factor)
        .max(cfg.min_retry)
        .min(cfg.max_backoff)
}

/// Why a connection attempt cannot be retried.
fn is_fatal(e: &AppError) -> bool {
    matches!(e, AppError::NotSignedIn | AppError::Forbidden)
}

/// Errors worth another attempt: the network or server is unwell. Anything
/// else (not signed in, forbidden, Keychain or storage trouble) will not heal
/// by waiting, so it is reported instead.
pub fn is_retryable(e: &AppError) -> bool {
    matches!(
        e,
        AppError::Network(_) | AppError::Http { .. } | AppError::NotWardby | AppError::Protocol(_)
    )
}

async fn connect(session: &Session, cfg: &EventsConfig) -> Result<reqwest::Response, AppError> {
    let url = session.url_for("/admin/api/events")?;
    let send = session.authed_send(|tok| {
        session
            .stream_client()
            .get(&url)
            .bearer_auth(tok)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-store")
    });
    // The server sends headers and `hello` immediately, so silence here is a
    // dead connection just as it is mid-stream.
    let resp = tokio::time::timeout(cfg.idle_timeout, send)
        .await
        .map_err(|_| AppError::Network("request timed out".to_string()))??;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::from_status(status.as_u16()));
    }
    Ok(resp)
}

#[derive(Debug)]
struct StreamBroke;

impl std::fmt::Display for StreamBroke {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stream broke")
    }
}

impl std::error::Error for StreamBroke {}

/// Watches the raw bytes for what eventsource-stream hides or does not bound:
/// `retry:` lines (the server sends them in data-less blocks, which that crate
/// drops) and the size of the event being assembled. Lines end at `\n`
/// (wardby's framing); a trailing `\r` is ignored.
struct Tap {
    line: Vec<u8>,
    line_len: usize,
    event_bytes: usize,
    max_event_bytes: usize,
    retry_ms: Arc<AtomicU64>,
    oversize: Arc<AtomicBool>,
}

impl Tap {
    /// Returns false when the current event has grown past the limit.
    fn feed(&mut self, bytes: &[u8]) -> bool {
        for &b in bytes {
            self.event_bytes += 1;
            if self.event_bytes > self.max_event_bytes {
                self.oversize.store(true, Ordering::SeqCst);
                return false;
            }
            if b == b'\n' {
                self.end_line();
            } else {
                self.line_len += 1;
                // Only a short prefix is ever needed ("retry:" + digits).
                if self.line.len() < 32 {
                    self.line.push(b);
                }
            }
        }
        true
    }

    fn end_line(&mut self) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
            self.line_len -= 1;
        }
        if self.line_len == 0 {
            self.event_bytes = 0;
        } else if let Some(rest) = self.line.strip_prefix(b"retry:")
            && self.line_len == self.line.len()
            && let Ok(text) = std::str::from_utf8(rest)
            && let Ok(ms) = text.trim().parse::<u64>()
        {
            self.retry_ms.store(ms.max(1), Ordering::SeqCst);
        }
        self.line.clear();
        self.line_len = 0;
    }
}

/// The response body as a byte stream that yields one error and ends when the
/// connection fails, goes quiet for `idle`, or an event gets too large.
fn guarded_bytes(
    resp: reqwest::Response,
    idle: Duration,
    tap: Tap,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, StreamBroke>> {
    type Body =
        std::pin::Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;
    let body: Body = Box::pin(resp.bytes_stream());
    futures_util::stream::unfold(Some((body, tap)), move |state| async move {
        let (mut body, mut tap) = state?;
        match tokio::time::timeout(idle, body.next()).await {
            Ok(Some(Ok(b))) => {
                if tap.feed(&b) {
                    Some((Ok(b), Some((body, tap))))
                } else {
                    Some((Err(StreamBroke), None))
                }
            }
            Ok(None) => None,
            Ok(Some(Err(_))) | Err(_) => Some((Err(StreamBroke), None)),
        }
    })
}

#[derive(serde::Deserialize)]
struct Connected {
    connected: bool,
}

fn frame_for(name: &str, data: &str) -> Option<StreamFrame> {
    match name {
        "hello" => serde_json::from_str::<Connected>(data)
            .ok()
            .map(|c| StreamFrame::Hello {
                connected: c.connected,
            }),
        "status" => serde_json::from_str::<Connected>(data)
            .ok()
            .map(|c| StreamFrame::Status {
                connected: c.connected,
            }),
        "resync" => Some(StreamFrame::Resync),
        "run" | "service" | "outcome" | "step" => {
            serde_json::from_str(data)
                .ok()
                .map(|data| StreamFrame::Event {
                    kind: name.to_string(),
                    data,
                })
        }
        // Unknown names (and malformed payloads above) are skipped so a newer
        // server never breaks an older viewer.
        _ => None,
    }
}

async fn ensure_session(
    session: &mut Option<Arc<Session>>,
    build: &SessionBuilder,
) -> Result<Arc<Session>, AppError> {
    if let Some(s) = session {
        return Ok(s.clone());
    }
    let built = build().await?;
    *session = Some(built.clone());
    Ok(built)
}

async fn run(
    mut session: Option<Arc<Session>>,
    build: SessionBuilder,
    emit: impl Fn(StreamFrame) + Send + Sync + 'static,
    cfg: EventsConfig,
) {
    let mut failures: u32 = 0;
    let retry_ms = Arc::new(AtomicU64::new(0));
    loop {
        let attempt = match ensure_session(&mut session, &build).await {
            Ok(s) => connect(&s, &cfg).await,
            Err(e) if !is_retryable(&e) => {
                emit(StreamFrame::Ended { error: e });
                return;
            }
            Err(e) => Err(e),
        };
        match attempt {
            Err(e) if is_fatal(&e) => {
                emit(StreamFrame::Ended { error: e });
                return;
            }
            Err(_) => {}
            Ok(resp) => {
                let up_since = Instant::now();
                let tap = Tap {
                    line: Vec::new(),
                    line_len: 0,
                    event_bytes: 0,
                    max_event_bytes: cfg.max_event_bytes,
                    retry_ms: retry_ms.clone(),
                    oversize: Arc::new(AtomicBool::new(false)),
                };
                let mut events = Box::pin(guarded_bytes(resp, cfg.idle_timeout, tap).eventsource());
                while let Some(item) = events.next().await {
                    let Ok(ev) = item else { break };
                    if let Some(frame) = frame_for(&ev.event, &ev.data) {
                        emit(frame);
                    }
                }
                // Only a connection that stayed up long enough forgives the
                // failures before it; a flapping server keeps backing off.
                if up_since.elapsed() >= cfg.stable_after {
                    failures = 0;
                }
            }
        }
        failures = failures.saturating_add(1);
        let ms = retry_ms.load(Ordering::SeqCst);
        let base = if ms > 0 {
            Duration::from_millis(ms)
        } else {
            cfg.default_retry
        };
        let delay = backoff(base, failures, &cfg);
        emit(StreamFrame::Reconnecting {
            attempt: failures,
            delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        });
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_support::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn passes_step_frames_through() {
        let frame = frame_for("step", r#"{"kind":"step","runId":"r1","seq":3}"#);
        assert!(matches!(frame, Some(StreamFrame::Event { ref kind, .. }) if kind == "step"));
        assert!(frame_for("mystery", "{}").is_none());
    }

    fn fast() -> EventsConfig {
        EventsConfig {
            default_retry: Duration::from_millis(20),
            min_retry: Duration::from_millis(5),
            max_backoff: Duration::from_millis(80),
            idle_timeout: Duration::from_millis(200),
            stable_after: Duration::from_secs(10),
            max_event_bytes: 1024 * 1024,
        }
    }

    fn session(base: &str) -> Arc<Session> {
        Arc::new(
            Session::new(
                base,
                auth_for(base),
                "cid",
                MemStore::with("RT0"),
                Some(tokens("AT0")),
            )
            .unwrap(),
        )
    }

    type Frames = Arc<Mutex<Vec<String>>>;

    fn label(fr: &StreamFrame) -> String {
        match fr {
            StreamFrame::Hello { connected } => format!("hello:{connected}"),
            StreamFrame::Status { connected } => format!("status:{connected}"),
            StreamFrame::Resync => "resync".into(),
            StreamFrame::Event { kind, data } => format!("event:{kind}:{}", data["id"]),
            StreamFrame::Reconnecting { attempt, delay_ms } => {
                format!("reconnecting:{attempt}:{delay_ms}")
            }
            StreamFrame::Ended { error } => format!("ended:{}", error.kind()),
        }
    }

    fn collector() -> (Frames, impl Fn(StreamFrame) + Send + Sync + 'static) {
        let frames: Frames = Arc::new(Mutex::new(Vec::new()));
        let f = frames.clone();
        (frames, move |fr: StreamFrame| {
            f.lock().unwrap().push(label(&fr));
        })
    }

    async fn wait_for(frames: &Frames, n: usize) -> Vec<String> {
        for _ in 0..200 {
            if frames.lock().unwrap().len() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        frames.lock().unwrap().clone()
    }

    fn body_with_retry(retry: u32) -> String {
        format!(
            "retry: {retry}\n\nevent: hello\ndata: {{\"connected\":true}}\n\n: ping\n\nevent: status\ndata: {{\"connected\":true}}\n\nevent: resync\ndata: {{}}\n\nid: 1\nevent: run\ndata: {{\"id\":\"r1\"}}\n\nevent: mystery\ndata: {{}}\n\n"
        )
    }

    #[tokio::test]
    async fn maps_frames_in_order_ignores_pings_honours_server_retry_and_reconnects() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/api/events"))
            .and(header("authorization", "Bearer AT0"))
            .and(header("accept", "text/event-stream"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(body_with_retry(60), "text/event-stream"),
            )
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        let got = wait_for(&frames, 10).await;
        h.abort();
        let first = ["hello:true", "status:true", "resync", "event:run:\"r1\""];
        assert_eq!(got[..4], first, "{got:?}");
        // The server's retry (60 ms) replaces the 20 ms default; the second
        // consecutive short-lived connection doubles it, capped at 80 ms.
        assert_eq!(got[4], "reconnecting:1:60", "{got:?}");
        assert_eq!(got[5..9], first, "{got:?}");
        assert_eq!(got[9], "reconnecting:2:80", "{got:?}");
        assert!(s.received_requests().await.unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn unauthorized_refreshes_once_then_streams() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT0"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT1", "token_type": "Bearer", "refresh_token": "RT1"
            })))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(header("authorization", "Bearer AT1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(body_with_retry(20), "text/event-stream"),
            )
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        let got = wait_for(&frames, 1).await;
        h.abort();
        assert_eq!(got[0], "hello:true");
    }

    #[tokio::test]
    async fn not_signed_in_ends_the_task() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        tokio::time::timeout(Duration::from_secs(5), h.wait())
            .await
            .unwrap();
        assert_eq!(*frames.lock().unwrap(), ["ended:not_signed_in"]);
    }

    fn builder(
        fail_first: usize,
        err: fn() -> AppError,
        s: Arc<Session>,
    ) -> (SessionBuilder, Arc<std::sync::atomic::AtomicUsize>) {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = calls.clone();
        let b: SessionBuilder = Box::new(move || {
            let n = c.fetch_add(1, Ordering::SeqCst);
            let s = s.clone();
            Box::pin(async move { if n < fail_first { Err(err()) } else { Ok(s) } })
        });
        (b, calls)
    }

    #[tokio::test]
    async fn a_session_that_cannot_be_built_yet_is_retried_with_backoff() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/api/events"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(body_with_retry(20), "text/event-stream"),
            )
            .mount(&s)
            .await;
        let (build, calls) = builder(2, || AppError::Network("down".into()), session(&s.uri()));
        let (frames, emit) = collector();
        let h = spawn_events_lazy(None, build, emit, fast());
        let got = wait_for(&frames, 3).await;
        h.abort();
        assert_eq!(
            got[..3],
            ["reconnecting:1:20", "reconnecting:2:40", "hello:true"],
            "{got:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_built_session_is_reused_across_reconnects() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&s)
            .await;
        let (build, calls) = builder(0, || AppError::NotSignedIn, session(&s.uri()));
        let (frames, emit) = collector();
        let h = spawn_events_lazy(None, build, emit, fast());
        wait_for(&frames, 3).await;
        h.abort();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_session_that_can_never_be_built_ends_the_task() {
        let s = MockServer::start().await;
        let (build, _) = builder(usize::MAX, || AppError::NotSignedIn, session(&s.uri()));
        let (frames, emit) = collector();
        let h = spawn_events_lazy(None, build, emit, fast());
        tokio::time::timeout(Duration::from_secs(5), h.wait())
            .await
            .unwrap();
        assert_eq!(*frames.lock().unwrap(), ["ended:not_signed_in"]);
    }

    #[tokio::test]
    async fn forbidden_ends_the_task() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        tokio::time::timeout(Duration::from_secs(5), h.wait())
            .await
            .unwrap();
        assert_eq!(*frames.lock().unwrap(), ["ended:forbidden"]);
    }

    #[tokio::test]
    async fn server_errors_back_off_exponentially_up_to_the_cap() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        let got = wait_for(&frames, 5).await;
        h.abort();
        assert_eq!(
            got[..5],
            [
                "reconnecting:1:20",
                "reconnecting:2:40",
                "reconnecting:3:80",
                "reconnecting:4:80",
                "reconnecting:5:80"
            ],
            "{got:?}"
        );
    }

    /// Raw SSE server: `script(n, socket)` runs for the n-th connection (1-based)
    /// after the request has been read.
    async fn raw_server<F, Fut>(script: F) -> (String, Arc<std::sync::atomic::AtomicUsize>)
    where
        F: Fn(usize, tokio::net::TcpStream) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let conns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = conns.clone();
        let script = Arc::new(script);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else {
                    return;
                };
                let n = c2.fetch_add(1, Ordering::SeqCst) + 1;
                let script = script.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    script(n, sock).await;
                });
            }
        });
        (base, conns)
    }

    const HEAD: &str =
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";

    async fn send_chunk(sock: &mut tokio::net::TcpStream, chunk: &str) {
        let _ = sock
            .write_all(format!("{:x}\r\n{chunk}\r\n", chunk.len()).as_bytes())
            .await;
    }

    const HELLO: &str = "retry: 20\n\nevent: hello\ndata: {\"connected\":true}\n\n";

    #[tokio::test]
    async fn silent_stream_is_dropped_after_the_idle_timeout_and_reconnected() {
        let (base, conns) = raw_server(|_, mut sock| async move {
            let _ = sock.write_all(HEAD.as_bytes()).await;
            send_chunk(&mut sock, HELLO).await;
            // Then go silent without closing.
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&base), emit, fast());
        let got = wait_for(&frames, 3).await;
        h.abort();
        assert_eq!(
            got[..3],
            ["hello:true", "reconnecting:1:20", "hello:true"],
            "{got:?}"
        );
        assert!(conns.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn failures_are_forgiven_only_after_a_connection_stays_up() {
        // Connections 1 and 2 drop right after hello; 3 stays up past
        // `stable_after`; 4 drops right after hello.
        let (base, _) = raw_server(|n, mut sock| async move {
            let _ = sock.write_all(HEAD.as_bytes()).await;
            send_chunk(&mut sock, "event: hello\ndata: {\"connected\":true}\n\n").await;
            if n == 3 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            // Dropping the socket ends the stream (abrupt close).
        })
        .await;
        let cfg = EventsConfig {
            default_retry: Duration::from_millis(100),
            min_retry: Duration::from_millis(5),
            max_backoff: Duration::from_millis(400),
            idle_timeout: Duration::from_secs(5),
            stable_after: Duration::from_millis(300),
            max_event_bytes: 1024 * 1024,
        };
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&base), emit, cfg);
        let got = wait_for(&frames, 8).await;
        h.abort();
        let delays: Vec<_> = got
            .iter()
            .filter(|f| f.starts_with("reconnecting"))
            .cloned()
            .collect();
        assert_eq!(
            delays[..4],
            [
                "reconnecting:1:100",
                "reconnecting:2:200",
                "reconnecting:1:100",
                "reconnecting:2:200"
            ],
            "{got:?}"
        );
    }

    #[tokio::test]
    async fn oversized_event_is_cut_and_reconnected() {
        let (base, conns) = raw_server(|_, mut sock| async move {
            let _ = sock.write_all(HEAD.as_bytes()).await;
            send_chunk(&mut sock, HELLO).await;
            // One event that never ends: no blank line, endless data.
            send_chunk(&mut sock, "event: run\ndata: ").await;
            let filler = "x".repeat(4096);
            for _ in 0..40 {
                send_chunk(&mut sock, &filler).await;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;
        let cfg = EventsConfig {
            max_event_bytes: 16 * 1024,
            idle_timeout: Duration::from_secs(5),
            ..fast()
        };
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&base), emit, cfg);
        let got = wait_for(&frames, 3).await;
        h.abort();
        assert_eq!(
            got[..3],
            ["hello:true", "reconnecting:1:20", "hello:true"],
            "{got:?}"
        );
        assert!(conns.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn dropping_the_handle_stops_the_stream() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(body_with_retry(20), "text/event-stream"),
            )
            .mount(&s)
            .await;
        let (frames, emit) = collector();
        let h = spawn_events_with(session(&s.uri()), emit, fast());
        wait_for(&frames, 1).await;
        drop(h);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let n = s.received_requests().await.unwrap().len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(s.received_requests().await.unwrap().len(), n);
        // The task's closure (and its Arc) is gone too.
        assert_eq!(Arc::strong_count(&frames), 1);
    }
}
