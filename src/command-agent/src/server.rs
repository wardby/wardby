//! `wardby-cmd serve`: the toolchain container's entrypoint.
//!
//! Listens on the run's loopback, waits for the workspace and runs the setup command once
//! (the gate), then runs each authenticated forwarded command in its own process group.
//! It never logs a header, environment, command or output: its only log lines are fixed.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::env;
use crate::frame::{self, kind};
use crate::header::{self, Header, HeaderError};
use crate::reaper::Reaper;
use crate::sys;

/// The exit code that means "wardby-cmd failed", not the command.
pub const AGENT_FAILURE: i32 = 125;

const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_POLL: Duration = Duration::from_millis(200);

pub struct ServeConfig {
    pub listen: String,
    pub token_file: PathBuf,
    pub wait_file: Option<PathBuf>,
    pub wait_timeout: Duration,
    pub require_shell: PathBuf,
    pub setup: Vec<String>,
}

/// Where the toolchain stands before it can run commands.
#[derive(Clone, PartialEq, Eq, Debug)]
enum GateState {
    Pending,
    Ready,
    /// A fixed reason token: `shell` or `setup_failed`.
    Failed(&'static str),
}

struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl Gate {
    fn set(&self, s: GateState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = s;
        self.changed.notify_all();
    }

    fn wait(&self) -> GateState {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while *s == GateState::Pending {
            s = self.changed.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        s.clone()
    }
}

/// Reads a token file: trimmed, non-empty.
pub fn read_token(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let token = raw.trim();
    (!token.is_empty()).then(|| token.to_string())
}

pub fn serve(cfg: ServeConfig) -> i32 {
    let Some(token) = read_token(&cfg.token_file) else {
        eprintln!("wardby-cmd: toolchain_unusable:agent");
        return AGENT_FAILURE;
    };
    let listener = match TcpListener::bind(&cfg.listen) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("wardby-cmd: cannot listen");
            return AGENT_FAILURE;
        }
    };
    eprintln!("wardby-cmd: listening");
    // Orphans reparent to the agent even when it is not PID 1 (tests, some runtimes).
    let _ = sys::become_subreaper();
    let reaper = Reaper::start();
    sys::on_termination(listener.as_raw_fd());

    let gate = Arc::new(Gate {
        state: Mutex::new(GateState::Pending),
        changed: Condvar::new(),
    });
    {
        let (gate, reaper) = (gate.clone(), reaper.clone());
        thread::spawn(move || gate.set(prepare(&cfg, &reaper)));
    }

    let token = Arc::new(token);
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let (token, gate, reaper) = (token.clone(), gate.clone(), reaper.clone());
        thread::spawn(move || handle(conn, &token, &gate, &reaper));
    }
    0
}

/// The gate: a shell, a ready workspace, and a successful setup command.
fn prepare(cfg: &ServeConfig, reaper: &Reaper) -> GateState {
    if !cfg.require_shell.is_file() {
        return GateState::Failed("shell");
    }
    if let Some(wait_file) = &cfg.wait_file {
        let deadline = Instant::now() + cfg.wait_timeout;
        while !wait_file.exists() {
            if Instant::now() >= deadline {
                return GateState::Failed("setup_failed");
            }
            thread::sleep(WAIT_POLL);
        }
    }
    if cfg.setup.is_empty() {
        return GateState::Ready;
    }
    let workdir = Path::new("/workspace");
    let mut cmd = Command::new(&cfg.setup[0]);
    cmd.args(&cfg.setup[1..])
        .process_group(0)
        // Setup output may echo serviceEnv values: never captured, only the exit code counts.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if workdir.is_dir() {
        cmd.current_dir(workdir);
    }
    let Ok(mut child) = reaper.spawn(&mut cmd) else {
        return GateState::Failed("setup_failed");
    };
    let deadline = Instant::now() + cfg.wait_timeout;
    loop {
        match reaper.try_wait(&mut child) {
            Ok(Some(status)) if status.success() => return GateState::Ready,
            Ok(Some(_)) | Err(_) => return GateState::Failed("setup_failed"),
            Ok(None) if Instant::now() >= deadline => {
                sys::kill_group(child.id() as i32);
                let _ = reaper.wait(&mut child);
                return GateState::Failed("setup_failed");
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

type Writer = Arc<Mutex<TcpStream>>;

fn send(w: &Writer, k: u8, payload: &[u8]) -> io::Result<()> {
    let mut s = w.lock().unwrap_or_else(|e| e.into_inner());
    frame::write_frame(&mut *s, k, payload)
}

fn fail(w: &Writer, reason: &str) {
    let _ = send(w, kind::FAILURE, reason.as_bytes());
    let _ = send(w, kind::EXIT, &AGENT_FAILURE.to_be_bytes());
}

fn handle(conn: TcpStream, token: &str, gate: &Gate, reaper: &Reaper) {
    let _ = conn.set_read_timeout(Some(HEADER_TIMEOUT));
    let Ok(mut reader) = conn.try_clone() else {
        return;
    };
    let w: Writer = Arc::new(Mutex::new(conn));
    let Ok((kind::HEADER, payload)) = frame::read_frame(&mut reader) else {
        return;
    };
    let h = match Header::decode(&payload) {
        Ok(h) => h,
        Err(HeaderError::Version(_)) => return fail(&w, "version"),
        // A malformed or unauthenticated header gets nothing back.
        Err(HeaderError::Invalid) => return,
    };
    if !header::token_matches(h.token.as_bytes(), token.as_bytes()) || h.argv.is_empty() {
        return;
    }
    let _ = reader.set_read_timeout(None);
    match gate.wait() {
        GateState::Ready => {}
        GateState::Failed(reason) => return fail(&w, reason),
        GateState::Pending => unreachable!("gate.wait returns only a settled state"),
    }
    let code = run_command(&h, reader, &w, reaper);
    let _ = send(&w, kind::EXIT, &code.to_be_bytes());
    let _ = w
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .shutdown(Shutdown::Write);
}

fn build_command(h: &Header) -> Command {
    let mut cmd = Command::new(&h.argv[0]);
    cmd.args(&h.argv[1..]).current_dir(&h.cwd);
    // No Wardby value reaches a command, whichever side it came from.
    let inherited: Vec<OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| k.to_string_lossy().starts_with("WARDBY_"))
        .collect();
    for k in inherited {
        cmd.env_remove(k);
    }
    for (k, v) in &h.env {
        if env::is_forwardable(k) {
            cmd.env(k, v);
        }
    }
    cmd
}

/// Where the reader thread sends stdin and window sizes.
enum Input {
    Pipe(Option<Box<dyn Write + Send>>),
    Tty(File),
}

fn run_command(h: &Header, reader: TcpStream, w: &Writer, reaper: &Reaper) -> i32 {
    let mut cmd = build_command(h);
    let mut pumps = Vec::new();
    let (mut child, input): (Child, Input) = if let Some(window) = h.tty {
        let Ok((master, slave)) = sys::openpty(window) else {
            return cannot_start(w);
        };
        let (Ok(s1), Ok(s2), Ok(out), Ok(inp)) = (
            slave.try_clone(),
            slave.try_clone(),
            master.try_clone(),
            master.try_clone(),
        ) else {
            return cannot_start(w);
        };
        cmd.stdin(Stdio::from(s1))
            .stdout(Stdio::from(s2))
            .stderr(Stdio::from(slave));
        sys::new_session_on_tty(&mut cmd);
        let spawned = reaper.spawn(&mut cmd);
        // The parent's copies of the slave must close, or the master never sees the end.
        drop(cmd);
        let Ok(child) = spawned else {
            return cannot_start(w);
        };
        pumps.push(pump(out, w.clone(), kind::STDOUT, child.id() as i32));
        drop(master);
        (child, Input::Tty(inp))
    } else {
        cmd.process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let Ok(mut child) = reaper.spawn(&mut cmd) else {
            return cannot_start(w);
        };
        let pgid = child.id() as i32;
        if let Some(o) = child.stdout.take() {
            pumps.push(pump(o, w.clone(), kind::STDOUT, pgid));
        }
        if let Some(e) = child.stderr.take() {
            pumps.push(pump(e, w.clone(), kind::STDERR, pgid));
        }
        let stdin = child
            .stdin
            .take()
            .map(|s| Box::new(s) as Box<dyn Write + Send>);
        (child, Input::Pipe(stdin))
    };
    let pgid = child.id() as i32;
    // Set once the command has finished; afterwards a closing connection kills nothing.
    let done = Arc::new(Mutex::new(false));
    read_client(reader, input, pgid, done.clone());

    // The command ends when its output pipes close and it has exited; all output is sent first.
    for p in pumps {
        let _ = p.join();
    }
    let _ = sys::wait_exited_nowait(pgid);
    {
        let mut d = done.lock().unwrap_or_else(|e| e.into_inner());
        // The leader is not reaped yet, so its group id cannot have been reused.
        sys::kill_group(pgid);
        *d = true;
    }
    exit_code(reaper.wait(&mut child))
}

fn exit_code(status: io::Result<ExitStatus>) -> i32 {
    match status {
        Ok(s) => s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0)),
        Err(_) => AGENT_FAILURE,
    }
}

fn cannot_start(w: &Writer) -> i32 {
    let _ = send(w, kind::STDERR, b"wardby-cmd: cannot start the command\n");
    127
}

fn pump(
    mut from: impl Read + Send + 'static,
    w: Writer,
    k: u8,
    pgid: i32,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match from.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => {
                    if send(&w, k, &buf[..n]).is_err() {
                        // The client is gone: nobody will read the rest.
                        sys::kill_group(pgid);
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                // EIO on a pty master: every holder of the slave has closed it.
                Err(_) => return,
            }
        }
    })
}

/// Reads stdin, stdin EOF and window frames from the client. Stdin is written by its own
/// thread, so a command that never reads stdin cannot stop this thread from noticing that the
/// connection dropped, which kills the command's group.
fn read_client(mut reader: TcpStream, input: Input, pgid: i32, done: Arc<Mutex<bool>>) {
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    let (mut sink, window): (Option<Box<dyn Write + Send>>, Option<File>) = match input {
        Input::Pipe(s) => (s, None),
        Input::Tty(master) => {
            let writer = master
                .try_clone()
                .ok()
                .map(|m| Box::new(m) as Box<dyn Write + Send>);
            (writer, Some(master))
        }
    };
    let is_tty = window.is_some();
    thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match (msg, sink.as_mut()) {
                (Some(bytes), Some(s)) => {
                    if s.write_all(&bytes).and_then(|_| s.flush()).is_err() {
                        sink = None;
                    }
                }
                (None, _) => sink = None,
                (Some(_), None) => {}
            }
        }
    });
    thread::spawn(move || {
        loop {
            match frame::read_frame(&mut reader) {
                Ok((kind::STDIN, bytes)) => {
                    let _ = tx.send(Some(bytes));
                }
                // A terminal has no EOF to close; the program reads ^D if it wants one.
                Ok((kind::STDIN_EOF, _)) if !is_tty => {
                    let _ = tx.send(None);
                }
                Ok((kind::WINDOW, p)) => {
                    if let (Some(m), Some(win)) = (window.as_ref(), header::parse_window(&p)) {
                        let _ = sys::set_window(m.as_raw_fd(), win);
                    }
                }
                Ok(_) => {}
                Err(_) => {
                    let d = done.lock().unwrap_or_else(|e| e.into_inner());
                    if !*d {
                        sys::kill_group(pgid);
                    }
                    return;
                }
            }
        }
    });
}
