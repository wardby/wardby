//! The commands the webview may call. Tokens never leave Rust: commands return
//! server names, URLs, sign-in state and server JSON, and errors cross as
//! `{ kind, message, status? }`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

use crate::api::{KeychainStore, RefreshStore, Session};
use crate::cluster::CLUSTER_EVENT;
use crate::cluster::errors::ClusterError;
use crate::cluster::kubeconfig::{self, KubeContexts};
use crate::cluster::model::InfraEvent;
use crate::cluster::watch;
use crate::error::AppError;
use crate::events::{
    EventsConfig, EventsHandle, SessionBuilder, StreamFrame, is_retryable, spawn_events_lazy,
};
use crate::loopback;
use crate::oauth;
use crate::servers::{self, ServerConfig, normalize_server_url};

/// Tauri event that carries every stream frame to the UI.
pub const FRAME_EVENT: &str = "viewer://frame";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const STORE_FILE: &str = "servers.json";
const STORE_KEY: &str = "servers";

fn epoch_of(map: &std::sync::Mutex<HashMap<String, u64>>, url: &str) -> u64 {
    map.lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(url)
        .copied()
        .unwrap_or(0)
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;

/// The event stream and the bookkeeping that keeps a slow `connect` from
/// replacing a newer one. Always locked briefly, never across an await.
#[derive(Default)]
struct Events {
    /// The current stream and the server it belongs to.
    stream: Option<(String, EventsHandle)>,
    /// Generation counter: every connect request takes the next number.
    next_gen: u64,
    /// The newest connect request that has not installed its stream yet.
    /// Cleared by installing, and by anything that stops that server's stream
    /// (`disconnect`, sign-out, removal, a dead grant), so a request that was
    /// overtaken or cancelled while it was busy never installs anything.
    pending: Option<(String, u64)>,
}

#[derive(Default)]
pub struct AppState {
    /// One slot per server (normalized URL). The slot's mutex is that server's
    /// AUTH LOCK: every session-lifecycle and Keychain-ownership step for the
    /// server (build from the Keychain, sign-in commit + install, sign-out,
    /// removal, dead-grant cleanup) runs holding it, so they are totally
    /// ordered and a stale session can never write over, or delete, a newer
    /// token. Lock order: auth lock -> a session's refresh lock (`revoke` waits
    /// on it), never the reverse; the refresh path itself never takes the auth
    /// lock. Per-server, so a slow server never blocks another. Slots are never
    /// removed.
    slots: std::sync::Mutex<HashMap<String, Slot>>,
    /// The current event stream (see `Events`).
    events: std::sync::Mutex<Events>,
    /// Serialises read-modify-write of the saved server list.
    config: std::sync::Mutex<()>,
    /// Per-server cancel counter, bumped by every `cancel_sign_in`. A sign-in
    /// remembers the value it started at and its commit is skipped under the
    /// auth lock if it has changed (see `commit_sign_in`).
    cancel_epochs: Arc<std::sync::Mutex<HashMap<String, u64>>>,
    /// Sign-ins in flight, by server URL.
    signins: std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Live cluster watches and the requests that may install one (see
    /// `Clusters`).
    clusters: std::sync::Mutex<Clusters>,
}

/// Cluster watches by server URL, plus the bookkeeping that keeps a slow
/// `kube_connect` from installing after it was stopped or overtaken. Always
/// locked briefly, never across an await.
#[derive(Default)]
struct Clusters {
    /// Live watches. Aborting a handle stops every per-kind watch under it.
    handles: HashMap<String, tokio::task::JoinHandle<()>>,
    /// The newest generation per server; only a request holding it may
    /// install. Bumped by every `kube_connect` and every stop.
    current: HashMap<String, u64>,
    next_gen: u64,
}

/// Removes a sign-in's registration (and aborts it if still running) when the
/// command finishes or is dropped.
struct SignInGuard<'a> {
    state: &'a AppState,
    url: String,
    abort: tokio::task::AbortHandle,
}

impl Drop for SignInGuard<'_> {
    fn drop(&mut self) {
        self.abort.abort();
        self.state
            .signins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.url);
    }
}

impl AppState {
    fn clusters_slot(&self) -> std::sync::MutexGuard<'_, Clusters> {
        self.clusters.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a `kube_connect` for `url`, superseding any older one. Taken
    /// BEFORE the request awaits anything.
    fn begin_cluster(&self, url: &str) -> u64 {
        let mut cl = self.clusters_slot();
        cl.next_gen += 1;
        let gen_ = cl.next_gen;
        cl.current.insert(url.to_string(), gen_);
        gen_
    }

    /// Starts (`start`) and installs a watch only if `gen_` is still the
    /// newest request for `url`, replacing (aborting) any previous watch.
    /// Otherwise nothing is started, so a stopped or overtaken request never
    /// emits a frame. Returns whether it was installed.
    fn start_cluster(
        &self,
        url: &str,
        gen_: u64,
        start: impl FnOnce() -> tokio::task::JoinHandle<()>,
    ) -> bool {
        let mut cl = self.clusters_slot();
        if cl.current.get(url) != Some(&gen_) {
            return false;
        }
        if let Some(old) = cl.handles.insert(url.to_string(), start()) {
            old.abort();
        }
        true
    }

    /// Stops a server's cluster watch, if any, and cancels a `kube_connect`
    /// still in flight for it.
    fn stop_cluster(&self, url: &str) {
        let mut cl = self.clusters_slot();
        cl.next_gen += 1;
        let gen_ = cl.next_gen;
        cl.current.insert(url.to_string(), gen_);
        if let Some(h) = cl.handles.remove(url) {
            h.abort();
        }
    }

    fn events_slot(&self) -> std::sync::MutexGuard<'_, Events> {
        self.events.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a connect request, superseding any older pending one. Taken
    /// BEFORE the request awaits anything.
    fn begin_connect(&self, server_url: &str) -> u64 {
        let mut ev = self.events_slot();
        ev.next_gen += 1;
        let gen_ = ev.next_gen;
        ev.pending = Some((server_url.to_string(), gen_));
        gen_
    }

    fn connect_is_current(&self, server_url: &str, gen_: u64) -> bool {
        self.events_slot()
            .pending
            .as_ref()
            .is_some_and(|(u, g)| u == server_url && *g == gen_)
    }

    /// Installs the stream only if its request is still the latest one;
    /// otherwise the handle is dropped, which stops it. Replacing the current
    /// stream aborts it silently: the UI owns the `live` flag and clears it
    /// whenever it tears a server's view down (see `useViewer`).
    fn install_stream(&self, server_url: &str, gen_: u64, handle: EventsHandle) -> bool {
        let mut ev = self.events_slot();
        if !ev
            .pending
            .as_ref()
            .is_some_and(|(u, g)| u == server_url && *g == gen_)
        {
            return false;
        }
        ev.pending = None;
        ev.stream = Some((server_url.to_string(), handle));
        true
    }

    fn cancel_pending(&self, server_url: &str, gen_: u64) {
        let mut ev = self.events_slot();
        if ev
            .pending
            .as_ref()
            .is_some_and(|(u, g)| u == server_url && *g == gen_)
        {
            ev.pending = None;
        }
    }

    /// Stops a server's stream and cancels its pending connect, if any.
    fn stop_stream_for(&self, server_url: &str) {
        let mut ev = self.events_slot();
        if ev.stream.as_ref().is_some_and(|(u, _)| u == server_url) {
            ev.stream = None;
        }
        if ev.pending.as_ref().is_some_and(|(u, _)| u == server_url) {
            ev.pending = None;
        }
    }

    /// Whether the server has a live session in memory (without waiting on its
    /// auth lock: a busy lock just means "ask the Keychain instead").
    fn has_session(&self, server_url: &str) -> bool {
        let slot = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(server_url)
            .cloned();
        slot.is_some_and(|s| s.try_lock().is_ok_and(|g| g.is_some()))
    }

    /// Opens the server's event stream. The session is built first; if that
    /// fails for a reason that can pass (network, server trouble) the stream
    /// task is installed anyway and builds the session itself, backing off and
    /// emitting `Reconnecting` until it works. Failures that need the user
    /// (not signed in, Keychain) are returned. A request that was overtaken or
    /// cancelled while building installs nothing and reports success.
    async fn connect_stream<B, Fut>(
        &self,
        server_url: &str,
        build: B,
        emit: impl Fn(StreamFrame) + Send + Sync + 'static,
        on_dead: impl Fn(Arc<Session>) + Send + Sync + 'static,
        cfg: EventsConfig,
    ) -> Result<(), AppError>
    where
        B: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Arc<Session>, AppError>> + Send + 'static,
    {
        let gen_ = self.begin_connect(server_url);
        let build = Arc::new(build);
        let first = match build().await {
            Ok(s) => Some(s),
            Err(e) if is_retryable(&e) => None,
            Err(e) => {
                self.cancel_pending(server_url, gen_);
                return Err(e);
            }
        };
        if !self.connect_is_current(server_url, gen_) {
            return Ok(());
        }
        // The session the stream runs on, for a dead-grant cleanup.
        let current: Arc<std::sync::Mutex<Option<Arc<Session>>>> =
            Arc::new(std::sync::Mutex::new(first.clone()));
        let builder: SessionBuilder = {
            let (build, current) = (build.clone(), current.clone());
            Box::new(move || {
                let (build, current) = (build.clone(), current.clone());
                Box::pin(async move {
                    let s = build().await?;
                    *current.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
                    Ok(s)
                })
            })
        };
        let emit = move |frame: StreamFrame| {
            let dead = matches!(
                &frame,
                StreamFrame::Ended {
                    error: AppError::NotSignedIn
                }
            );
            emit(frame);
            if dead && let Some(s) = current.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                on_dead(s);
            }
        };
        let handle = spawn_events_lazy(first, builder, emit, cfg);
        self.install_stream(server_url, gen_, handle);
        Ok(())
    }

    fn slot(&self, server_url: &str) -> Slot {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(server_url.to_string())
            .or_default()
            .clone()
    }

    /// Ends a server's session under its auth lock: stops its stream, revokes
    /// the session (after any in-flight refresh has finished persisting, so it
    /// can never write the Keychain again), then runs `delete` (the Keychain
    /// delete) before any other step for this server can start.
    async fn end_session<F>(&self, server_url: &str, delete: F) -> Result<(), AppError>
    where
        F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
    {
        let slot = self.slot(server_url);
        let mut g = slot.lock().await;
        self.stop_stream_for(server_url);
        if let Some(s) = g.take() {
            s.revoke().await;
        }
        let url = server_url.to_string();
        tokio::task::spawn_blocking(move || delete(&url))
            .await
            .map_err(|_| AppError::Keychain("keychain task failed".to_string()))?
    }

    /// A session whose grant is dead (refresh refused): forget it and delete the
    /// stale Keychain item, so the server shows as signed out. All under the auth
    /// lock, and only if the slot still holds this very session: if a re-sign-in
    /// replaced it, its newly committed token is left alone.
    async fn drop_dead<F>(&self, session: &Arc<Session>, delete: F)
    where
        F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
    {
        let url = session.server_url().to_string();
        let slot = self.slot(&url);
        let mut g = slot.lock().await;
        if !g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, session)) {
            return;
        }
        *g = None;
        self.stop_stream_for(&url);
        session.revoke().await;
        let _ = tokio::task::spawn_blocking(move || delete(&url)).await;
    }

    /// The server's session, building it from the Keychain on first use.
    async fn session_for(
        &self,
        server_url: &str,
        client_id: Option<&str>,
        store: Arc<dyn RefreshStore>,
    ) -> Result<Arc<Session>, AppError> {
        let slot = self.slot(server_url);
        let mut g = slot.lock().await;
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let client_id = client_id.ok_or(AppError::NotSignedIn)?;
        let session = Arc::new(build_session(server_url, client_id, store).await?);
        *g = Some(session.clone());
        Ok(session)
    }

    /// Finishes a sign-in under the auth lock: revokes the session being
    /// replaced (so its in-flight refresh finishes, and can never persist an
    /// old-grant token over the new one), re-checks via `check` that the server
    /// is still saved, writes the FIRST refresh token to the store, and installs
    /// the new session.
    ///
    /// The commit runs as a DETACHED task: aborting the sign-in task (cancel,
    /// sign-out, removal) cannot drop it halfway, and the blocking Keychain
    /// write always finishes while the auth lock is still held, so a later
    /// `end_session` runs strictly after it. Cancellation is honoured by
    /// `epoch` (the server's cancel counter when the sign-in began): if it moved,
    /// the commit is skipped under the lock. A commit that had already started
    /// writing is NOT undone: the user is signed in until the following
    /// sign-out/removal (which is ordered after it) ends the session.
    async fn commit_sign_in<C>(
        &self,
        session: Session,
        refresh: String,
        store: Arc<dyn RefreshStore>,
        epoch: u64,
        check: C,
    ) -> Result<(), AppError>
    where
        C: FnOnce() -> Result<(), AppError> + Send + 'static,
    {
        let url = session.server_url().to_string();
        let slot = self.slot(&url);
        let epochs = self.cancel_epochs.clone();
        self.stop_stream_for(&url);
        tokio::spawn(async move {
            let mut g = slot.lock().await;
            if epoch_of(&epochs, &url) != epoch {
                return Err(AppError::Cancelled);
            }
            if let Some(old) = g.take() {
                old.revoke().await;
            }
            tokio::task::spawn_blocking(move || {
                check()?;
                store.set(&refresh)
            })
            .await
            .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
            *g = Some(Arc::new(session));
            Ok(())
        })
        .await
        .map_err(|_| AppError::Network("sign-in commit failed".to_string()))?
    }

    /// Runs one sign-in per server at a time, as its own task so
    /// `cancel_sign_in` can abort it (dropping its loopback listener).
    async fn single_flight<T, Fut>(&self, server_url: &str, fut: Fut) -> Result<T, AppError>
    where
        T: Send + 'static,
        Fut: Future<Output = Result<T, AppError>> + Send + 'static,
    {
        let (handle, _guard) = {
            let mut g = self.signins.lock().unwrap_or_else(|e| e.into_inner());
            if g.contains_key(server_url) {
                return Err(AppError::Protocol(
                    "sign-in already in progress".to_string(),
                ));
            }
            let handle = tokio::spawn(fut);
            let abort = handle.abort_handle();
            g.insert(server_url.to_string(), abort.clone());
            (
                handle,
                SignInGuard {
                    state: self,
                    url: server_url.to_string(),
                    abort,
                },
            )
        };
        match handle.await {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Err(AppError::Cancelled),
            Err(_) => Err(AppError::Network("sign-in task failed".to_string())),
        }
    }

    fn epoch(&self, server_url: &str) -> u64 {
        epoch_of(&self.cancel_epochs, server_url)
    }

    fn cancel_sign_in(&self, server_url: &str) -> bool {
        *self
            .cancel_epochs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(server_url.to_string())
            .or_insert(0) += 1;
        match self
            .signins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(server_url)
        {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }
}

// ------------------------------------------------------ saved servers

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ServerSummary {
    pub name: String,
    pub url: String,
    pub signed_in: bool,
    pub kube_context: Option<String>,
}

fn summaries(list: &[ServerConfig], signed_in: impl Fn(&str) -> bool) -> Vec<ServerSummary> {
    list.iter()
        .map(|c| ServerSummary {
            name: c.name.clone(),
            url: c.url.clone(),
            signed_in: signed_in(&c.url),
            kube_context: c.kube_context.clone(),
        })
        .collect()
}

/// Adds a server, or updates the name (and client id, when one is given) of the
/// one with the same normalized URL.
fn upsert_server(
    list: &mut Vec<ServerConfig>,
    name: &str,
    url: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    let url = normalize_server_url(url)?;
    let client_id = client_id
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let name = {
        let n = name.trim();
        if n.is_empty() {
            url::Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| url.clone())
        } else {
            n.to_string()
        }
    };
    match list.iter_mut().find(|c| c.url == url) {
        Some(existing) => {
            existing.name = name;
            if client_id.is_some() {
                existing.client_id = client_id;
            }
        }
        None => list.push(ServerConfig {
            name,
            url,
            client_id,
            kube_context: None,
        }),
    }
    Ok(())
}

/// Records a registered client id for a server that is still saved; an error if
/// it was removed meanwhile, so nothing is stored for a deleted server.
fn set_client_id(list: &mut [ServerConfig], url: &str, client_id: &str) -> Result<(), AppError> {
    let c = list
        .iter_mut()
        .find(|c| c.url == url)
        .ok_or_else(removed_error)?;
    c.client_id = Some(client_id.to_string());
    Ok(())
}

/// Records the kubeconfig context for a saved server; blank clears it.
fn set_kube_context_in(
    list: &mut [ServerConfig],
    url: &str,
    context: Option<String>,
) -> Result<(), AppError> {
    let c = list
        .iter_mut()
        .find(|c| c.url == url)
        .ok_or_else(|| AppError::Protocol("unknown server".to_string()))?;
    c.kube_context = context
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(())
}

fn removed_error() -> AppError {
    AppError::Protocol("server was removed".to_string())
}

fn load_servers(app: &AppHandle) -> Result<Vec<ServerConfig>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|_| AppError::Storage("could not open the saved servers".to_string()))?;
    match store.get(STORE_KEY) {
        None => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v)
            .map_err(|_| AppError::Storage("saved servers are unreadable".to_string())),
    }
}

fn save_servers(app: &AppHandle, list: &[ServerConfig]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|_| AppError::Storage("could not open the saved servers".to_string()))?;
    store.set(STORE_KEY, json!(list));
    store
        .save()
        .map_err(|_| AppError::Storage("could not save the servers".to_string()))
}

/// Read-modify-write of the saved list under the state's lock.
fn edit_servers<T>(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&mut Vec<ServerConfig>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _g = state.config.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_servers(app)?;
    let out = f(&mut list)?;
    save_servers(app, &list)?;
    Ok(out)
}

fn find_server(list: &[ServerConfig], url: &str) -> Result<ServerConfig, AppError> {
    list.iter()
        .find(|c| c.url == url)
        .cloned()
        .ok_or_else(|| AppError::Protocol("unknown server".to_string()))
}

// ------------------------------------------------------------ sign-in

struct SignedIn {
    session: Session,
    /// The first refresh token, to be committed (not yet stored anywhere).
    refresh: String,
}

type Hook = Box<dyn FnOnce(&str) -> Result<(), AppError> + Send>;

/// The side effects of a sign-in, injected so the flow is testable.
struct SignInHooks {
    /// Called with a freshly registered client id, BEFORE the browser opens, so
    /// a retry reuses it instead of registering again.
    on_registered: Hook,
    /// Opens the authorize URL in the system browser.
    open: Hook,
}

/// Discover, register if needed, send the user to the system browser, wait for
/// the loopback callback, exchange the code, and return the session with the
/// FIRST refresh token, which the caller commits via `commit_sign_in`.
async fn sign_in_flow(
    server_url: &str,
    saved_client_id: Option<String>,
    hooks: SignInHooks,
    store: Arc<dyn RefreshStore>,
    timeout: Duration,
    callback_port: u16,
) -> Result<SignedIn, AppError> {
    let http = oauth::http_client()?;
    let auth = oauth::discover(&http, server_url).await?;
    let client_id = match saved_client_id.filter(|c| !c.is_empty()) {
        Some(id) => id,
        None => {
            let id = oauth::register(&http, &auth, oauth::REGISTRATION_REDIRECT).await?;
            (hooks.on_registered)(&id)?;
            id
        }
    };

    let (callback, listener) = loopback::bind_on(callback_port).await?;
    let pkce = oauth::new_pkce();
    let state = oauth::new_state();
    let url = oauth::authorize_url(&auth, &client_id, &callback.redirect_uri, &pkce, &state);
    (hooks.open)(url.as_str())?;
    let code = loopback::wait_for_code(
        listener,
        &state,
        Some(&auth.issuer),
        auth.iss_required,
        timeout,
    )
    .await?;

    let tokens = oauth::exchange_code(
        &http,
        &auth,
        &client_id,
        &callback.redirect_uri,
        &code,
        &pkce,
    )
    .await?;
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| AppError::Protocol("server issued no refresh token".to_string()))?;
    let session = Session::new(server_url, auth, &client_id, store, Some(tokens))?;
    Ok(SignedIn { session, refresh })
}

/// A session for a server that is already signed in (Keychain holds its
/// refresh token); the first request refreshes to get an access token.
async fn build_session(
    server_url: &str,
    client_id: &str,
    store: Arc<dyn RefreshStore>,
) -> Result<Session, AppError> {
    let s = store.clone();
    let have = tokio::task::spawn_blocking(move || s.get())
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))??;
    if have.is_none() {
        return Err(AppError::NotSignedIn);
    }
    let http = oauth::http_client()?;
    let auth = oauth::discover(&http, server_url).await?;
    Session::new(server_url, auth, client_id, store, None)
}

// -------------------------------------------------------------- frames

fn frame_json(frame: StreamFrame) -> Value {
    match frame {
        StreamFrame::Hello { connected } => json!({"type": "hello", "connected": connected}),
        StreamFrame::Status { connected } => json!({"type": "status", "connected": connected}),
        StreamFrame::Resync => json!({"type": "resync"}),
        StreamFrame::Event { kind, data } => json!({"type": "event", "kind": kind, "data": data}),
        StreamFrame::Reconnecting { attempt, delay_ms } => {
            json!({"type": "reconnecting", "attempt": attempt, "delay_ms": delay_ms})
        }
        StreamFrame::Ended { error } => json!({"type": "ended", "error": error}),
    }
}

fn frame_payload(server: &str, frame: StreamFrame) -> Value {
    json!({"server": server, "frame": frame_json(frame)})
}

// ------------------------------------------------------------ commands

fn keychain_has(url: &str) -> bool {
    matches!(servers::keychain_get(url), Ok(Some(_)))
}

#[tauri::command]
pub async fn list_servers(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ServerSummary>, AppError> {
    let list = {
        let _g = state.config.lock().unwrap_or_else(|e| e.into_inner());
        load_servers(&app)?
    };
    // A live session in memory answers first (and spares the Keychain, which
    // may prompt after a rebuild); the Keychain decides for the rest.
    let live: std::collections::HashSet<String> = list
        .iter()
        .filter(|c| state.has_session(&c.url))
        .map(|c| c.url.clone())
        .collect();
    tokio::task::spawn_blocking(move || summaries(&list, |u| live.contains(u) || keychain_has(u)))
        .await
        .map_err(|_| AppError::Keychain("keychain task failed".to_string()))
}

#[tauri::command]
pub async fn add_server(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    url: String,
    client_id: Option<String>,
) -> Result<(), AppError> {
    edit_servers(&app, &state, |list| {
        upsert_server(list, &name, &url, client_id.as_deref())
    })
}

#[tauri::command]
pub async fn remove_server(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    // Config first: from here on a sign-in in flight can no longer commit.
    edit_servers(&app, &state, |list| {
        list.retain(|c| c.url != url);
        Ok(())
    })?;
    state.cancel_sign_in(&url);
    state.stop_cluster(&url);
    state.end_session(&url, servers::keychain_delete).await
}

#[tauri::command]
pub async fn sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    let cfg = find_server(&load_servers(&app)?, &url)?;
    let fut = {
        let app = app.clone();
        let url = url.clone();
        async move {
            let st = app.state::<AppState>();
            let epoch = st.epoch(&url);
            let hooks = SignInHooks {
                on_registered: {
                    let (app, url) = (app.clone(), url.clone());
                    Box::new(move |id| {
                        edit_servers(&app, &app.state::<AppState>(), |l| {
                            set_client_id(l, &url, id)
                        })
                    })
                },
                open: {
                    let app = app.clone();
                    Box::new(move |authorize| {
                        app.opener().open_url(authorize, None::<&str>).map_err(|_| {
                            AppError::Network("could not open the system browser".to_string())
                        })
                    })
                },
            };
            let store: Arc<dyn RefreshStore> = Arc::new(KeychainStore::new(&url));
            let signed = sign_in_flow(
                &url,
                cfg.client_id.clone(),
                hooks,
                store.clone(),
                SIGN_IN_TIMEOUT,
                loopback::CALLBACK_PORT,
            )
            .await?;
            // The server may have been removed during the browser step.
            let check = {
                let (app, url) = (app.clone(), url.clone());
                move || {
                    let st = app.state::<AppState>();
                    let _g = st.config.lock().unwrap_or_else(|e| e.into_inner());
                    find_server(&load_servers(&app)?, &url)
                        .map(|_| ())
                        .map_err(|_| removed_error())
                }
            };
            st.commit_sign_in(signed.session, signed.refresh, store, epoch, check)
                .await
        }
    };
    state.single_flight(&url, fut).await
}

#[tauri::command]
pub async fn cancel_sign_in(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    state.cancel_sign_in(&url);
    Ok(())
}

async fn sign_out_with<F>(state: &AppState, url: &str, delete: F) -> Result<(), AppError>
where
    F: FnOnce(&str) -> Result<(), AppError> + Send + 'static,
{
    // Revoke (waits out any in-flight refresh), then delete, under the auth lock.
    state.end_session(url, delete).await
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    state.cancel_sign_in(&url);
    state.stop_cluster(&url);
    sign_out_with(&state, &url, servers::keychain_delete).await
}

async fn session_of(
    app: &AppHandle,
    state: &AppState,
    url: &str,
) -> Result<Arc<Session>, AppError> {
    let cfg = find_server(&load_servers(app)?, url)?;
    let store: Arc<dyn RefreshStore> = Arc::new(KeychainStore::new(url));
    state
        .session_for(url, cfg.client_id.as_deref(), store)
        .await
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    find_server(&load_servers(&app)?, &url)?;
    let build = {
        let (app, url) = (app.clone(), url.clone());
        move || {
            let (app, url) = (app.clone(), url.clone());
            async move {
                let state = app.state::<AppState>();
                session_of(&app, &state, &url).await
            }
        }
    };
    let emit = {
        let (app, server) = (app.clone(), url.clone());
        move |frame: StreamFrame| {
            let _ = app.emit(FRAME_EVENT, frame_payload(&server, frame));
        }
    };
    let on_dead = {
        let app = app.clone();
        move |sess: Arc<Session>| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<AppState>()
                    .drop_dead(&sess, servers::keychain_delete)
                    .await;
            });
        }
    };
    state
        .connect_stream(&url, build, emit, on_dead, EventsConfig::default())
        .await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    // Only that server's stream: a late cleanup must not kill the next server's.
    state.stop_stream_for(&normalize_server_url(&url)?);
    Ok(())
}

fn graph_path(since: &str, limit: u32) -> Result<String, AppError> {
    let since = since.trim();
    if since.is_empty() {
        return Err(AppError::Protocol("missing since".to_string()));
    }
    let enc: String = url::form_urlencoded::byte_serialize(since.as_bytes()).collect();
    Ok(format!("/admin/api/graph?since={enc}&limit={limit}"))
}

fn run_path(id: &str) -> Result<String, AppError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(AppError::Protocol("invalid run id".to_string()));
    }
    Ok(format!("/admin/api/runs/{id}"))
}

/// GET through the server's session; a dead grant also clears the session and
/// the stale Keychain item so the server shows as signed out.
async fn fetch(
    app: &AppHandle,
    state: &AppState,
    url: &str,
    path: &str,
) -> Result<Value, AppError> {
    let session = session_of(app, state, url).await?;
    let r = session.get_json(path).await;
    if matches!(r, Err(AppError::NotSignedIn)) {
        state.drop_dead(&session, servers::keychain_delete).await;
    }
    r
}

#[tauri::command]
pub async fn fetch_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    since: String,
    limit: u32,
) -> Result<Value, AppError> {
    let url = normalize_server_url(&url)?;
    let path = graph_path(&since, limit)?;
    fetch(&app, &state, &url, &path).await
}

#[tauri::command]
pub async fn fetch_run(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    id: String,
) -> Result<Value, AppError> {
    let url = normalize_server_url(&url)?;
    let path = run_path(&id)?;
    fetch(&app, &state, &url, &path).await
}

const INFRA_PATH: &str = "/admin/api/infra";

#[tauri::command]
pub async fn fetch_infra(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<Value, AppError> {
    let url = normalize_server_url(&url)?;
    fetch(&app, &state, &url, INFRA_PATH).await
}

/// The contexts in the user's kubeconfig (names only, never credentials).
#[tauri::command]
pub async fn kube_contexts() -> Result<KubeContexts, ClusterError> {
    tokio::task::spawn_blocking(kubeconfig::list_contexts)
        .await
        .map_err(|_| ClusterError::Other {
            message: "kubeconfig task failed".to_string(),
        })?
}

/// Which kubeconfig context the Infrastructure view uses for a server
/// (`None` or blank clears it).
#[tauri::command]
pub async fn set_kube_context(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    context: Option<String>,
) -> Result<(), AppError> {
    let url = normalize_server_url(&url)?;
    edit_servers(&app, &state, |list| {
        set_kube_context_in(list, &url, context)
    })
}

/// Starts live, read-only watches of `namespace` through `context` for a
/// server, replacing any it already has. Frames arrive on `CLUSTER_EVENT`.
#[tauri::command]
pub async fn kube_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    context: String,
    namespace: String,
) -> Result<(), ClusterError> {
    let url = normalize_server_url(&url).map_err(|e| ClusterError::Other {
        message: e.to_string(),
    })?;
    watch::check_namespace(&namespace)?;
    // Registered before the await: a stop or a newer connect meanwhile wins.
    let gen_ = state.begin_cluster(&url);
    let client = kubeconfig::client_for(&context).await?;
    let source = Arc::new(watch::KubeSource::new(client));
    let server = url.clone();
    state.start_cluster(&url, gen_, || {
        watch::spawn_cluster(source, namespace, move |frame| {
            let _ = app.emit(CLUSTER_EVENT, json!({ "server": server, "frame": frame }));
        })
    });
    Ok(())
}

/// Stops a server's cluster watches.
#[tauri::command]
pub async fn kube_disconnect(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    state.stop_cluster(&normalize_server_url(&url)?);
    Ok(())
}

/// The newest events for one pod.
#[tauri::command]
pub async fn kube_pod_events(
    context: String,
    namespace: String,
    pod: String,
) -> Result<Vec<InfraEvent>, ClusterError> {
    // Validate before reading the kubeconfig (and running any exec plugin).
    watch::check_pod_target(&namespace, &pod)?;
    let client = kubeconfig::client_for(&context).await?;
    watch::pod_events(client, &namespace, &pod).await
}

/// The only links the webview may ask the system browser to open: absolute
/// `https://` URLs with a host and no embedded credentials.
fn check_open_url(raw: &str) -> Result<url::Url, AppError> {
    let reject = || AppError::Protocol("only https links can be opened".to_string());
    // The URL parser silently trims whitespace and strips control characters.
    if raw.trim() != raw || raw.chars().any(char::is_control) {
        return Err(reject());
    }
    // `https:///host` and `https:\\host` parse as `https://host/`; require the
    // literal authority form so what is checked is what the user sees.
    let literal = raw
        .get(..8)
        .filter(|p| p.eq_ignore_ascii_case("https://"))
        .map(|_| &raw[8..]);
    if literal.is_none_or(|rest| rest.starts_with(['/', '\\'])) {
        return Err(reject());
    }
    let parsed = url::Url::parse(raw).map_err(|_| reject())?;
    let has_host = parsed.host_str().is_some_and(|h| !h.is_empty());
    if parsed.scheme() != "https"
        || !has_host
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(reject());
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), AppError> {
    let parsed = check_open_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| AppError::Network("could not open the system browser".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_support::{MemStore, auth_for};
    use std::sync::atomic::{AtomicBool, Ordering};
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::events::spawn_events;

    fn pending_watch() -> tokio::task::JoinHandle<()> {
        tokio::spawn(futures_util::future::pending::<()>())
    }

    /// Starts a watch the way `kube_connect` would after its await; returns
    /// the abort handle if it was installed.
    fn start(st: &AppState, url: &str, gen_: u64) -> Option<tokio::task::AbortHandle> {
        let mut abort = None;
        st.start_cluster(url, gen_, || {
            let h = pending_watch();
            abort = Some(h.abort_handle());
            h
        });
        abort
    }

    #[tokio::test]
    async fn a_cluster_watch_is_stopped_by_replacement_and_by_stop() {
        let st = AppState::default();
        let url = "https://wardby.example.com";
        let g1 = st.begin_cluster(url);
        let first = start(&st, url, g1).expect("first installs");
        let g2 = st.begin_cluster(url);
        let second = start(&st, url, g2).expect("second installs");
        tokio::task::yield_now().await;
        assert!(first.is_finished(), "replaced watch keeps running");
        assert!(!second.is_finished());
        st.stop_cluster("https://other.example.com");
        assert!(!second.is_finished(), "another server's stop hit this one");
        st.stop_cluster(url);
        tokio::task::yield_now().await;
        assert!(second.is_finished());
        assert!(st.clusters_slot().handles.is_empty());
    }

    #[tokio::test]
    async fn disconnect_while_kube_connecting_installs_nothing() {
        let st = AppState::default();
        let url = "https://wardby.example.com";
        let g = st.begin_cluster(url);
        // kube_disconnect / sign_out / remove_server while client_for awaits.
        st.stop_cluster(url);
        assert!(
            start(&st, url, g).is_none(),
            "a stopped connect started a watch"
        );
        assert!(st.clusters_slot().handles.is_empty());
    }

    #[tokio::test]
    async fn kube_pod_events_rejects_bad_names_before_reading_the_kubeconfig() {
        // An unknown context would fail later; the name check must come first.
        let err = kube_pod_events("no-such-context".into(), "Bad NS".into(), "p".into())
            .await
            .unwrap_err();
        assert_eq!(
            err,
            ClusterError::Other {
                message: "invalid namespace name".into()
            }
        );
        let err = kube_pod_events("no-such-context".into(), "wardby".into(), "a,b".into())
            .await
            .unwrap_err();
        assert_eq!(
            err,
            ClusterError::Other {
                message: "invalid pod name".into()
            }
        );
    }

    #[tokio::test]
    async fn the_newer_kube_connect_wins() {
        let st = AppState::default();
        let url = "https://wardby.example.com";
        // Out of order: the newer connect finishes first.
        let older = st.begin_cluster(url);
        let newer = st.begin_cluster(url);
        let live = start(&st, url, newer).expect("newer installs");
        assert!(
            start(&st, url, older).is_none(),
            "older connect replaced the newer"
        );
        tokio::task::yield_now().await;
        assert!(!live.is_finished());
        // Another server's connect does not supersede this one.
        let other = st.begin_cluster("https://other.example.com");
        assert!(start(&st, "https://other.example.com", other).is_some());
        assert!(!live.is_finished());
        assert_eq!(st.clusters_slot().handles.len(), 2);
    }

    /// Installs a stream the way a connect request would.
    fn put(st: &AppState, url: &str, handle: EventsHandle) {
        let g = st.begin_connect(url);
        assert!(st.install_stream(url, g, handle));
    }

    // ---- connect_stream

    use crate::api::test_support::tokens;
    use tokio::sync::Notify;

    type Log = Arc<std::sync::Mutex<Vec<String>>>;

    fn log() -> (Log, impl Fn(StreamFrame) + Send + Sync + 'static) {
        let log: Log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let l = log.clone();
        (log, move |f| l.lock().unwrap().push(format!("{f:?}")))
    }

    fn fast() -> EventsConfig {
        EventsConfig {
            default_retry: Duration::from_millis(20),
            min_retry: Duration::from_millis(5),
            max_backoff: Duration::from_millis(80),
            idle_timeout: Duration::from_millis(500),
            stable_after: Duration::from_secs(10),
            max_event_bytes: 1024 * 1024,
        }
    }

    async fn events_server() -> MockServer {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/api/events"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "retry: 20\n\nevent: hello\ndata: {\"connected\":true}\n\n",
                "text/event-stream",
            ))
            .mount(&s)
            .await;
        s
    }

    fn live_session(base: &str) -> Arc<Session> {
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

    fn no_dead(_: Arc<Session>) {}

    /// A build step that parks until released, then yields `session`.
    #[allow(clippy::type_complexity)]
    fn gated(
        session: Arc<Session>,
    ) -> (
        impl Fn() -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<Session>, AppError>> + Send>>
        + Send
        + Sync
        + 'static,
        Arc<Notify>,
        Arc<Notify>,
    ) {
        let (started, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let (st, rel) = (started.clone(), release.clone());
        let build = move || {
            let (st, rel, session) = (st.clone(), rel.clone(), session.clone());
            Box::pin(async move {
                st.notify_one();
                rel.notified().await;
                Ok(session)
            }) as std::pin::Pin<Box<dyn Future<Output = _> + Send>>
        };
        (build, started, release)
    }

    fn ready(
        session: Arc<Session>,
    ) -> impl Fn() -> std::future::Ready<Result<Arc<Session>, AppError>> + Send + Sync + 'static
    {
        move || std::future::ready(Ok(session.clone()))
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    #[tokio::test]
    async fn a_slow_connect_cannot_replace_another_servers_stream() {
        let (sa, sb) = (events_server().await, events_server().await);
        let st = Arc::new(AppState::default());
        let (a_log, a_emit) = log();
        let (b_log, b_emit) = log();
        let (build_a, a_started, a_release) = gated(live_session(&sa.uri()));
        let a = {
            let (st, url) = (st.clone(), sa.uri());
            tokio::spawn(async move {
                st.connect_stream(&url, build_a, a_emit, no_dead, fast())
                    .await
            })
        };
        a_started.notified().await;
        // The user switched servers while A was still building.
        st.connect_stream(
            &sb.uri(),
            ready(live_session(&sb.uri())),
            b_emit,
            no_dead,
            fast(),
        )
        .await
        .unwrap();
        a_release.notify_one();
        a.await.unwrap().unwrap();
        settle().await;
        assert_eq!(st.events_slot().stream.as_ref().unwrap().0, sb.uri());
        assert!(a_log.lock().unwrap().is_empty(), "A's stream never started");
        assert!(
            !b_log.lock().unwrap().is_empty(),
            "B's stream is the live one"
        );
    }

    #[tokio::test]
    async fn a_slow_connect_cannot_replace_a_newer_one_for_the_same_server() {
        let s = events_server().await;
        let st = Arc::new(AppState::default());
        let (old_log, old_emit) = log();
        let (new_log, new_emit) = log();
        let (build, started, release) = gated(live_session(&s.uri()));
        let old = {
            let (st, url) = (st.clone(), s.uri());
            tokio::spawn(async move {
                st.connect_stream(&url, build, old_emit, no_dead, fast())
                    .await
            })
        };
        started.notified().await;
        st.connect_stream(
            &s.uri(),
            ready(live_session(&s.uri())),
            new_emit,
            no_dead,
            fast(),
        )
        .await
        .unwrap();
        release.notify_one();
        old.await.unwrap().unwrap();
        settle().await;
        assert!(old_log.lock().unwrap().is_empty());
        assert!(!new_log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn disconnect_while_connecting_installs_nothing() {
        let s = events_server().await;
        let st = Arc::new(AppState::default());
        let (frames, emit) = log();
        let (build, started, release) = gated(live_session(&s.uri()));
        let c = {
            let (st, url) = (st.clone(), s.uri());
            tokio::spawn(async move { st.connect_stream(&url, build, emit, no_dead, fast()).await })
        };
        started.notified().await;
        st.stop_stream_for(&s.uri());
        release.notify_one();
        c.await.unwrap().unwrap();
        settle().await;
        assert!(st.events_slot().stream.is_none());
        assert!(frames.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_transient_failure_to_build_the_session_keeps_retrying() {
        let s = events_server().await;
        let sess = live_session(&s.uri());
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let a = attempts.clone();
        let build = move || {
            let n = a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let sess = sess.clone();
            async move {
                if n < 2 {
                    Err(AppError::Network("down".to_string()))
                } else {
                    Ok(sess)
                }
            }
        };
        let st = AppState::default();
        let (frames, emit) = log();
        st.connect_stream(&s.uri(), build, emit, no_dead, fast())
            .await
            .expect("a transient failure does not fail connect");
        assert!(st.events_slot().stream.is_some());
        for _ in 0..100 {
            if frames.lock().unwrap().iter().any(|f| f.contains("Hello")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let got = frames.lock().unwrap().clone();
        assert!(got[0].contains("Reconnecting"), "{got:?}");
        assert!(got.iter().any(|f| f.contains("Hello")), "{got:?}");
    }

    #[tokio::test]
    async fn a_failure_that_needs_the_user_is_returned_and_installs_nothing() {
        let st = AppState::default();
        let (frames, emit) = log();
        let err = st
            .connect_stream(
                "https://w.example",
                || std::future::ready(Err(AppError::NotSignedIn)),
                emit,
                no_dead,
                fast(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotSignedIn));
        assert!(st.events_slot().stream.is_none());
        assert!(st.events_slot().pending.is_none());
        assert!(frames.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn has_session_reflects_the_live_slot() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        assert!(!st.has_session(&s.uri()));
        st.session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        assert!(st.has_session(&s.uri()));
        sign_out_with(&st, &s.uri(), |_| Ok(())).await.unwrap();
        assert!(!st.has_session(&s.uri()));
    }

    fn cfg(name: &str, url: &str, id: Option<&str>) -> ServerConfig {
        ServerConfig {
            name: name.into(),
            url: url.into(),
            client_id: id.map(Into::into),
            kube_context: None,
        }
    }

    #[test]
    fn open_url_allows_only_https_with_a_host() {
        let ok = check_open_url("https://github.com/o/r/pull/7?x=1#f").unwrap();
        assert_eq!(ok.as_str(), "https://github.com/o/r/pull/7?x=1#f");
        assert!(check_open_url("HTTPS://Example.com").is_ok());
        for bad in [
            "http://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ftp://example.com/",
            "wardby://open",
            "slack://channel",
            "mailto:a@b.c",
            "https://user@example.com/",
            "https://user:pw@example.com/",
            "https:///nohost",
            "https:",
            "https:\\\\example.com",
            "//example.com/",
            "example.com",
            "",
            " https://example.com ",
        ] {
            assert!(check_open_url(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn upsert_normalizes_and_dedupes() {
        let mut list = Vec::new();
        upsert_server(
            &mut list,
            " Prod ",
            "HTTPS://Wardby.Example.com/",
            Some(" "),
        )
        .unwrap();
        assert_eq!(list, vec![cfg("Prod", "https://wardby.example.com", None)]);
        upsert_server(&mut list, "", "https://wardby.example.com", Some("cid")).unwrap();
        assert_eq!(
            list,
            vec![cfg(
                "wardby.example.com",
                "https://wardby.example.com",
                Some("cid")
            )]
        );
        // Re-adding without a client id keeps the saved one.
        upsert_server(&mut list, "x", "https://wardby.example.com/", None).unwrap();
        assert_eq!(list[0].client_id.as_deref(), Some("cid"));
        assert_eq!(list.len(), 1);
        assert!(upsert_server(&mut list, "bad", "ftp://h", None).is_err());
        assert!(upsert_server(&mut list, "bad", "http://remote.example", None).is_err());
        assert!(upsert_server(&mut list, "bad", "https://u:p@h.example", None).is_err());
        assert!(upsert_server(&mut list, "bad", "https://h.example/?q=1", None).is_err());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn summaries_never_carry_tokens_or_client_ids() {
        let list = vec![cfg("a", "https://a.example", Some("secretish"))];
        let s = summaries(&list, |u| u == "https://a.example");
        assert_eq!(
            s,
            vec![ServerSummary {
                name: "a".into(),
                url: "https://a.example".into(),
                signed_in: true,
                kube_context: None,
            }]
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v[0].as_object().unwrap().len(), 4);
    }

    #[test]
    fn kube_context_is_set_and_cleared_per_server() {
        let mut list = vec![
            cfg("a", "https://a.example", None),
            cfg("b", "https://b.example", None),
        ];
        set_kube_context_in(&mut list, "https://a.example", Some(" kind-dev ".into())).unwrap();
        assert_eq!(list[0].kube_context.as_deref(), Some("kind-dev"));
        assert_eq!(list[1].kube_context, None);
        let s = summaries(&list, |_| false);
        assert_eq!(s[0].kube_context.as_deref(), Some("kind-dev"));
        set_kube_context_in(&mut list, "https://a.example", Some("  ".into())).unwrap();
        assert_eq!(list[0].kube_context, None);
        set_kube_context_in(&mut list, "https://a.example", Some("gke".into())).unwrap();
        set_kube_context_in(&mut list, "https://a.example", None).unwrap();
        assert_eq!(list[0].kube_context, None);
        assert!(set_kube_context_in(&mut list, "https://gone.example", None).is_err());
    }

    #[tokio::test]
    async fn infra_is_fetched_from_the_admin_api() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(INFRA_PATH))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"namespace": "wardby"})),
            )
            .expect(1)
            .mount(&s)
            .await;
        let sess = live_session(&s.uri());
        assert_eq!(
            sess.get_json(INFRA_PATH).await.unwrap(),
            serde_json::json!({"namespace": "wardby"})
        );

        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(INFRA_PATH))
            .respond_with(ResponseTemplate::new(403))
            .mount(&s)
            .await;
        let sess = live_session(&s.uri());
        assert!(matches!(
            sess.get_json(INFRA_PATH).await,
            Err(AppError::Forbidden)
        ));
    }

    #[test]
    fn saved_config_has_no_token_field() {
        let v = serde_json::to_value(cfg("a", "https://a.example", Some("c"))).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 4);
        assert!(
            keys.iter()
                .all(|k| ["name", "url", "client_id", "kube_context"].contains(&k.as_str()))
        );
    }

    #[test]
    fn paths_are_encoded_and_validated() {
        assert_eq!(
            graph_path("2026-01-01T00:00:00+02:00", 50).unwrap(),
            "/admin/api/graph?since=2026-01-01T00%3A00%3A00%2B02%3A00&limit=50"
        );
        assert!(graph_path(" ", 1).is_err());
        assert_eq!(run_path("ckabc-1_x").unwrap(), "/admin/api/runs/ckabc-1_x");
        assert!(run_path("../x").is_err());
        assert!(run_path("").is_err());
    }

    #[test]
    fn frames_serialize_with_a_type_tag() {
        assert_eq!(
            frame_json(StreamFrame::Hello { connected: true }),
            json!({"type": "hello", "connected": true})
        );
        assert_eq!(frame_json(StreamFrame::Resync), json!({"type": "resync"}));
        assert_eq!(
            frame_json(StreamFrame::Event {
                kind: "run".into(),
                data: json!({"id": "r1"})
            }),
            json!({"type": "event", "kind": "run", "data": {"id": "r1"}})
        );
        assert_eq!(
            frame_json(StreamFrame::Reconnecting {
                attempt: 2,
                delay_ms: 500
            }),
            json!({"type": "reconnecting", "attempt": 2, "delay_ms": 500})
        );
        assert_eq!(
            frame_json(StreamFrame::Ended {
                error: AppError::Forbidden
            })["error"]["kind"],
            "forbidden"
        );
        let p = frame_payload("https://s", StreamFrame::Status { connected: false });
        assert_eq!(p["server"], "https://s");
        assert_eq!(p["frame"]["type"], "status");
    }

    async fn mount_server(s: &MockServer, with_registration: bool) {
        let base = s.uri();
        let issuer = format!("{base}/mcp");
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "resource": format!("{base}/mcp"), "authorization_servers": [issuer],
            })))
            .mount(s)
            .await;
        let mut meta = json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
        });
        if with_registration {
            meta["registration_endpoint"] = json!(format!("{base}/register"));
        }
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(meta))
            .mount(s)
            .await;
    }

    type TestHook = Box<dyn FnOnce(&str) -> Result<(), AppError> + Send>;

    fn hooks(open: impl FnOnce(&str) -> Result<(), AppError> + Send + 'static) -> SignInHooks {
        hooks_with(Box::new(|_| Ok(())), Box::new(open))
    }

    fn hooks_with(on_registered: TestHook, open: TestHook) -> SignInHooks {
        SignInHooks {
            on_registered,
            open,
        }
    }

    /// Stands in for the user's browser: follows the authorize URL's redirect
    /// back to the loopback listener with a code.
    fn fake_browser(issuer: String) -> impl FnOnce(&str) -> Result<(), AppError> {
        move |authorize: &str| {
            let u = url::Url::parse(authorize).unwrap();
            let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
            assert_eq!(q["scope"], "admin:view offline_access");
            assert_eq!(q["code_challenge_method"], "S256");
            assert!(q["redirect_uri"].starts_with("http://127.0.0.1:"));
            let mut cb = url::Url::parse(&q["redirect_uri"]).unwrap();
            cb.query_pairs_mut()
                .append_pair("code", "the-code")
                .append_pair("state", &q["state"])
                .append_pair("iss", &issuer);
            tokio::spawn(async move {
                let _ = reqwest::get(cb).await;
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn sign_in_registers_exchanges_and_stores_the_first_refresh_token() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .and(body_string_contains("http://127.0.0.1/callback"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"client_id": "reg-id"})))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("code=the-code"))
            .and(body_string_contains("client_id=reg-id"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT1", "token_type": "Bearer",
                "refresh_token": "RT1", "expires_in": 3600
            })))
            .expect(1)
            .mount(&s)
            .await;
        let store = MemStore::with("old");
        *store.token.lock().unwrap() = None;
        let issuer = format!("{}/mcp", s.uri());
        let registered = Arc::new(std::sync::Mutex::new(None::<String>));
        let (r1, r2) = (registered.clone(), registered.clone());
        let c_store2 = store.clone();
        let browser = fake_browser(issuer);
        let out = sign_in_flow(
            &s.uri(),
            None,
            hooks_with(
                Box::new(move |id| {
                    *r1.lock().unwrap() = Some(id.to_string());
                    Ok(())
                }),
                Box::new(move |u| {
                    // Registered client id is saved before the browser opens.
                    assert_eq!(r2.lock().unwrap().as_deref(), Some("reg-id"));
                    // And nothing is in the Keychain until the code exchange.
                    assert!(c_store2.token.lock().unwrap().is_none());
                    browser(u)
                }),
            ),
            store.clone(),
            Duration::from_secs(10),
            0,
        )
        .await
        .unwrap();
        assert_eq!(out.refresh, "RT1");
        assert_eq!(out.session.server_url(), s.uri());
        // The flow itself stores nothing; the commit does, under the auth lock.
        assert!(store.token.lock().unwrap().is_none());
        let st = AppState::default();
        st.commit_sign_in(out.session, out.refresh, store.clone(), 0, || Ok(()))
            .await
            .unwrap();
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT1"));
        assert!(st.slot(&s.uri()).lock().await.is_some());
    }

    #[tokio::test]
    async fn sign_in_without_registration_or_client_id_needs_one() {
        let s = MockServer::start().await;
        mount_server(&s, false).await;
        let opened = Arc::new(AtomicBool::new(false));
        let o = opened.clone();
        let err = sign_in_flow(
            &s.uri(),
            None,
            hooks(move |_| {
                o.store(true, Ordering::SeqCst);
                Ok(())
            }),
            MemStore::with("x"),
            Duration::from_secs(1),
            0,
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::NeedsClientId));
        assert!(!opened.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn sign_in_with_saved_client_id_skips_registration_and_can_time_out() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&s)
            .await;
        let err = sign_in_flow(
            &s.uri(),
            Some("saved".into()),
            hooks(|_| Ok(())),
            MemStore::with("x"),
            Duration::from_millis(150),
            0,
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
    }

    #[tokio::test]
    async fn build_session_needs_a_keychain_token() {
        let store = Arc::new(MemStore::default());
        let err = build_session("https://unused.invalid", "cid", store)
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AppError::NotSignedIn));
        // And no client id means not signed in either, without any lookup.
        let st = AppState::default();
        let err = st
            .session_for("https://unused.invalid", None, MemStore::with("rt"))
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AppError::NotSignedIn));
    }

    #[tokio::test]
    async fn session_is_built_once_and_reused() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let store = MemStore::with("rt");
        let a = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let b = st.session_for(&s.uri(), Some("cid"), store).await.unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn sign_out_deletes_the_keychain_item_and_drops_session_and_stream() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let other = MockServer::start().await;
        mount_server(&other, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        st.session_for(&other.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        put(&st, &s.uri(), spawn_events(a, |_| {}));

        let deleted = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let d = deleted.clone();
        // Signing out of a different server leaves the stream alone.
        sign_out_with(&st, &other.uri(), |_| Ok(())).await.unwrap();
        assert!(st.events_slot().stream.is_some());
        sign_out_with(&st, &s.uri(), move |u| {
            d.lock().unwrap().push(u.to_string());
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(*deleted.lock().unwrap(), vec![s.uri()]);
        assert!(st.events_slot().stream.is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }

    #[tokio::test]
    async fn replacing_the_stream_and_disconnect_drop_the_old_one() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        put(&st, "one", spawn_events(a.clone(), |_| {}));
        put(&st, "two", spawn_events(a, |_| {}));
        assert_eq!(st.events_slot().stream.as_ref().unwrap().0, "two");
        st.stop_stream_for("two");
        assert!(st.events_slot().stream.is_none());
    }

    #[tokio::test]
    async fn disconnect_only_stops_the_named_servers_stream() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = AppState::default();
        let a = st
            .session_for(&s.uri(), Some("cid"), MemStore::with("rt"))
            .await
            .unwrap();
        put(&st, "https://new.example", spawn_events(a, |_| {}));
        st.stop_stream_for("https://old.example");
        assert_eq!(
            st.events_slot().stream.as_ref().unwrap().0,
            "https://new.example"
        );
        st.stop_stream_for("https://new.example");
        assert!(st.events_slot().stream.is_none());
    }

    #[tokio::test]
    async fn registered_client_id_survives_a_failed_sign_in() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"client_id": "reg-id"})))
            .expect(1)
            .mount(&s)
            .await;
        let saved = Arc::new(std::sync::Mutex::new(None::<String>));
        let sv = saved.clone();
        let err = sign_in_flow(
            &s.uri(),
            None,
            hooks_with(
                Box::new(move |id| {
                    *sv.lock().unwrap() = Some(id.to_string());
                    Ok(())
                }),
                Box::new(|_| Ok(())),
            ),
            MemStore::with("x"),
            Duration::from_millis(150),
            0,
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
        let id = saved.lock().unwrap().clone();
        assert_eq!(id.as_deref(), Some("reg-id"));
        // The retry uses the saved id: /register is still at its one call.
        let err = sign_in_flow(
            &s.uri(),
            id,
            hooks(|_| Ok(())),
            MemStore::with("x"),
            Duration::from_millis(150),
            0,
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, AppError::Timeout));
    }

    #[tokio::test]
    async fn failed_commit_stores_nothing_and_installs_nothing() {
        let s = MockServer::start().await;
        let st = AppState::default();
        let store = Arc::new(MemStore::default());
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let err = st
            .commit_sign_in(session, "RT1".into(), store.clone(), 0, || {
                Err(removed_error())
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "server was removed"));
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }

    #[test]
    fn client_id_is_not_saved_for_a_removed_server() {
        let mut list = vec![cfg("a", "https://a.example", None)];
        set_client_id(&mut list, "https://a.example", "id").unwrap();
        assert_eq!(list[0].client_id.as_deref(), Some("id"));
        let err = set_client_id(&mut list, "https://gone.example", "id").unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }

    #[tokio::test]
    async fn second_sign_in_is_refused_and_cancel_aborts_and_closes_the_listener() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        let st = Arc::new(AppState::default());
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let first = {
            let st = st.clone();
            let uri = s.uri();
            tokio::spawn(async move {
                let key = uri.clone();
                st.single_flight(&key, async move {
                    sign_in_flow(
                        &uri,
                        Some("cid".into()),
                        hooks(move |authorize| {
                            let u = url::Url::parse(authorize).unwrap();
                            let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
                            let _ = tx.send(q["redirect_uri"].clone());
                            Ok(())
                        }),
                        MemStore::with("x"),
                        Duration::from_secs(60),
                        0,
                    )
                    .await
                    .map(|_| ())
                })
                .await
            })
        };
        let redirect = rx.await.unwrap();
        let err = st
            .single_flight(&s.uri(), async { Ok(()) })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "sign-in already in progress"));
        // Another server is unaffected.
        st.single_flight("https://other.example", async { Ok(()) })
            .await
            .unwrap();

        assert!(st.cancel_sign_in(&s.uri()));
        let r = first.await.unwrap();
        assert!(matches!(r, Err(AppError::Cancelled)));
        let addr = url::Url::parse(&redirect).unwrap();
        let port = addr.port().unwrap();
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "listener must be closed"
        );
        // And a new sign-in may start again.
        st.single_flight(&s.uri(), async { Ok(()) }).await.unwrap();
        assert!(!st.cancel_sign_in(&s.uri()));
    }

    #[tokio::test]
    async fn sign_out_during_a_refresh_cannot_be_undone_by_it() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(400))
                    .set_body_json(json!({
                        "access_token": "AT1", "token_type": "Bearer",
                        "refresh_token": "RT1", "expires_in": 3600
                    })),
            )
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/admin/api/graph"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("RT0");
        let session = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let inflight = {
            let session = session.clone();
            tokio::spawn(async move { session.get_json("/admin/api/graph").await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let wipe = store.clone();
        sign_out_with(&st, &s.uri(), move |_| {
            *wipe.token.lock().unwrap() = None;
            Ok(())
        })
        .await
        .unwrap();
        assert!(store.token.lock().unwrap().is_none(), "token resurrected");
        let _ = inflight.await;
        // No further refresh: the (single-call) token endpoint is not hit again.
        let err = session.get_json("/admin/api/graph").await.unwrap_err();
        assert!(matches!(err, AppError::NotSignedIn));
        assert!(store.token.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn dead_grant_clears_the_session_and_the_stale_keychain_item() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("rt");
        let old = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let err = old.get_json("/admin/api/graph").await.unwrap_err();
        assert!(matches!(err, AppError::NotSignedIn));

        let deleted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let d = deleted.clone();
        st.drop_dead(&old, move |_| {
            d.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        assert!(st.slot(&s.uri()).lock().await.is_none());

        // A session that was already replaced is left alone.
        let newer = st.session_for(&s.uri(), Some("cid"), store).await.unwrap();
        let d = deleted.clone();
        st.drop_dead(&old, move |_| {
            d.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(
            st.slot(&s.uri()).lock().await.as_ref().unwrap(),
            &newer
        ));
    }

    #[tokio::test]
    async fn slow_server_does_not_block_another() {
        let slow = MockServer::start().await;
        let base = slow.uri();
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&slow)
            .await;
        let fast = MockServer::start().await;
        mount_server(&fast, true).await;
        let st = Arc::new(AppState::default());
        let st2 = st.clone();
        let slow_build = tokio::spawn(async move {
            let _ = st2
                .session_for(&base, Some("cid"), MemStore::with("rt"))
                .await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let got = tokio::time::timeout(
            Duration::from_secs(2),
            st.session_for(&fast.uri(), Some("cid"), MemStore::with("rt")),
        )
        .await;
        assert!(got.unwrap().is_ok());
        slow_build.abort();
    }

    #[tokio::test]
    async fn re_sign_in_revokes_the_replaced_session_so_its_refresh_cannot_win() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(400))
                    .set_body_json(json!({
                        "access_token": "AT-old", "token_type": "Bearer",
                        "refresh_token": "RT-old-rotated", "expires_in": 3600
                    })),
            )
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/admin/api/graph"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&s)
            .await;
        let st = AppState::default();
        let store = MemStore::with("RT-old");
        // Built from the old Keychain token during the browser step.
        let old = st
            .session_for(&s.uri(), Some("cid"), store.clone())
            .await
            .unwrap();
        let inflight = {
            let old = old.clone();
            tokio::spawn(async move { old.get_json("/admin/api/graph").await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let new = Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        st.commit_sign_in(new, "RT-new".into(), store.clone(), 0, || Ok(()))
            .await
            .unwrap();
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        let _ = inflight.await;
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        assert!(matches!(
            old.get_json("/admin/api/graph").await,
            Err(AppError::NotSignedIn)
        ));
        let slot = st.slot(&s.uri());
        let g = slot.lock().await;
        assert!(!Arc::ptr_eq(g.as_ref().unwrap(), &old));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sign_out_vs_a_concurrent_rebuild_leaves_the_store_empty() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        for i in 0..20 {
            let st = Arc::new(AppState::default());
            let store = MemStore::with("rt");
            let uri = s.uri();
            let (wipe, st1, st2, store2, uri1, uri2) = (
                store.clone(),
                st.clone(),
                st.clone(),
                store.clone(),
                uri.clone(),
                uri.clone(),
            );
            let rebuild = tokio::spawn(async move {
                if i % 2 == 0 {
                    tokio::task::yield_now().await;
                }
                let _ = st2.session_for(&uri2, Some("cid"), store2).await;
            });
            let out = tokio::spawn(async move {
                sign_out_with(&st1, &uri1, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await
            });
            out.await.unwrap().unwrap();
            rebuild.await.unwrap();
            assert!(store.token.lock().unwrap().is_none());
            // Whatever order they ran in, no live session is left behind.
            assert!(st.slot(&uri).lock().await.is_none());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dead_session_cleanup_never_deletes_a_concurrently_committed_token() {
        let s = MockServer::start().await;
        mount_server(&s, true).await;
        for i in 0..20 {
            let st = Arc::new(AppState::default());
            let store = MemStore::with("rt");
            let old = st
                .session_for(&s.uri(), Some("cid"), store.clone())
                .await
                .unwrap();
            let new =
                Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
            let wipe = store.clone();
            let (st1, st2, store2) = (st.clone(), st.clone(), store.clone());
            let dead = tokio::spawn(async move {
                if i % 2 == 0 {
                    tokio::task::yield_now().await;
                }
                st1.drop_dead(&old, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await;
            });
            let commit = tokio::spawn(async move {
                st2.commit_sign_in(new, "RT-new".into(), store2, 0, || Ok(()))
                    .await
            });
            commit.await.unwrap().unwrap();
            dead.await.unwrap();
            assert_eq!(store.token.lock().unwrap().as_deref(), Some("RT-new"));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancel_and_sign_out_mid_write_leave_the_store_empty_and_no_session() {
        let s = MockServer::start().await;
        let st = Arc::new(AppState::default());
        let store = MemStore::with("old");
        store.set_delay_ms.store(400, Ordering::SeqCst);
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let uri = s.uri();
        let epoch = st.epoch(&uri);
        let signin = {
            let (st, store, uri) = (st.clone(), store.clone(), uri.clone());
            tokio::spawn(async move {
                let st2 = st.clone();
                st.single_flight(&uri, async move {
                    st2.commit_sign_in(session, "RT-new".into(), store, epoch, || Ok(()))
                        .await
                })
                .await
            })
        };
        // Land in the middle of the slow Keychain write.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wipe = store.clone();
        let out = {
            let (st, uri) = (st.clone(), uri.clone());
            tokio::spawn(async move {
                st.cancel_sign_in(&uri);
                sign_out_with(&st, &uri, move |_| {
                    *wipe.token.lock().unwrap() = None;
                    Ok(())
                })
                .await
            })
        };
        out.await.unwrap().unwrap();
        let _ = signin.await.unwrap();
        // The write finished under the lock first, then sign-out deleted it.
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&uri).lock().await.is_none());
    }

    #[tokio::test]
    async fn a_commit_cancelled_before_it_starts_is_skipped() {
        let s = MockServer::start().await;
        let st = AppState::default();
        let store = Arc::new(MemStore::default());
        let session =
            Session::new(&s.uri(), auth_for(&s.uri()), "cid", store.clone(), None).unwrap();
        let epoch = st.epoch(&s.uri());
        st.cancel_sign_in(&s.uri());
        let err = st
            .commit_sign_in(session, "RT".into(), store.clone(), epoch, || Ok(()))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert!(store.token.lock().unwrap().is_none());
        assert!(st.slot(&s.uri()).lock().await.is_none());
    }
}
