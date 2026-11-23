//! End-to-end: a real `wardby-cmd serve` and `wardby-cmd run` over loopback (Linux only).
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_wardby-cmd");

fn tempdir() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "wardby-cmd-e2e-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn free_addr() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().to_string()
}

struct Agent {
    child: Child,
    stderr: BufReader<ChildStderr>,
    addr: String,
    token_file: PathBuf,
    dir: PathBuf,
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Default)]
struct Opts<'a> {
    args: Vec<String>,
    env: Vec<(&'a str, &'a str)>,
    setup: Vec<String>,
}

fn start(opts: Opts) -> Agent {
    let dir = tempdir();
    let token_file = dir.join("token");
    std::fs::write(&token_file, "test-token-0123456789abcdef\n").unwrap();
    let addr = free_addr();
    let mut cmd = Command::new(BIN);
    cmd.arg("serve")
        .args(["--listen", &addr])
        .arg("--token-file")
        .arg(&token_file)
        .args(&opts.args)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    if !opts.setup.is_empty() {
        cmd.arg("--").args(&opts.setup);
    }
    let mut child = cmd.spawn().unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    assert_eq!(line, "wardby-cmd: listening\n");
    Agent {
        child,
        stderr,
        addr,
        token_file,
        dir,
    }
}

fn client(agent: &Agent, args: &[&str]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.arg("run")
        .arg(&agent.addr)
        .arg(&agent.token_file)
        .args(args)
        .current_dir(&agent.dir);
    cmd
}

fn run(agent: &Agent, args: &[&str]) -> Output {
    client(agent, args).stdin(Stdio::null()).output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn processes_with_cmdline(needle: &str) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        if let Ok(raw) = std::fs::read(entry.path().join("cmdline")) {
            let cmdline = text(&raw).replace('\0', " ");
            if cmdline.trim() == needle {
                found.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    found
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn read_frame(r: &mut impl Read) -> (u8, Vec<u8>) {
    let mut head = [0u8; 5];
    r.read_exact(&mut head).unwrap();
    let mut p = vec![0u8; u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize];
    r.read_exact(&mut p).unwrap();
    (head[0], p)
}

#[test]
fn exit_code_and_output() {
    let agent = start(Opts::default());
    let out = run(
        &agent,
        &["--", "/bin/sh", "-c", "echo out; echo err >&2; exit 3"],
    );
    assert_eq!(text(&out.stdout), "out\n");
    assert_eq!(text(&out.stderr), "err\n");
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn signal_exit_code() {
    let agent = start(Opts::default());
    let out = run(&agent, &["--", "/bin/sh", "-c", "kill -9 $$"]);
    assert_eq!(out.status.code(), Some(137));
}

#[test]
fn cwd_is_the_clients() {
    let agent = start(Opts::default());
    let sub = agent.dir.join("sub");
    std::fs::create_dir(&sub).unwrap();
    let out = client(&agent, &["--", "/bin/pwd"])
        .current_dir(&sub)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout).trim(), sub.to_str().unwrap());
}

#[test]
fn env_order() {
    let agent = start(Opts {
        env: vec![
            ("SERVER_ONLY", "image"),
            ("SHARED", "image"),
            ("WARDBY_SERVER", "1"),
        ],
        ..Opts::default()
    });
    let server_path = std::env::var("PATH").unwrap();
    let out = client(
        &agent,
        &[
            "--",
            "/bin/sh",
            "-c",
            "echo $SERVER_ONLY $SHARED ${WARDBY_X-unset} ${WARDBY_SERVER-unset}; echo $PATH",
        ],
    )
    .env("SHARED", "client")
    .env("PATH", "/nowhere")
    .env("WARDBY_X", "1")
    .stdin(Stdio::null())
    .output()
    .unwrap();
    assert_eq!(
        text(&out.stdout),
        format!("image client unset unset\n{server_path}\n")
    );
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn stdin_streams() {
    let agent = start(Opts::default());
    let mut c = client(&agent, &["--", "tr", "a-z", "A-Z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(b"hello\n").unwrap();
    let out = c.wait_with_output().unwrap();
    assert_eq!(text(&out.stdout), "HELLO\n");
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn wrong_token_gets_nothing() {
    let agent = start(Opts::default());
    let other = agent.dir.join("other-token");
    std::fs::write(&other, "not-the-token\n").unwrap();
    let out = Command::new(BIN)
        .arg("run")
        .arg(&agent.addr)
        .arg(&other)
        .args(["--", "/bin/sh", "-c", "echo ran"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: connection lost\n");
    assert!(out.stdout.is_empty());
}

#[test]
fn missing_token_file_is_unusable() {
    let agent = start(Opts::default());
    let out = Command::new(BIN)
        .arg("run")
        .arg(&agent.addr)
        .arg(agent.dir.join("absent"))
        .args(["--", "/bin/true"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: toolchain_unusable:agent\n");
}

#[test]
fn nothing_listening_is_unusable() {
    let agent = start(Opts::default());
    let out = Command::new(BIN)
        .arg("run")
        .arg(free_addr())
        .arg(&agent.token_file)
        .args(["--", "/bin/true"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: toolchain_unusable:agent\n");
}

#[test]
fn version_mismatch() {
    let agent = start(Opts::default());
    let mut s = TcpStream::connect(&agent.addr).unwrap();
    let mut header = 99u16.to_be_bytes().to_vec();
    header.extend_from_slice(b"whatever a future version sends");
    s.write_all(&frame(b'H', &header)).unwrap();
    assert_eq!(read_frame(&mut s), (b'F', b"version".to_vec()));
    assert_eq!(read_frame(&mut s), (b'X', 125i32.to_be_bytes().to_vec()));
}

#[test]
fn tty() {
    let agent = start(Opts::default());
    let out = run(
        &agent,
        &[
            "-t",
            "--",
            "/bin/sh",
            "-c",
            "test -t 0 && test -t 1 && echo tty; stty size",
        ],
    );
    let got = text(&out.stdout);
    assert!(got.contains("tty"), "{got:?}");
    assert!(got.contains("24 80"), "{got:?}");
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn disconnect_kills_group() {
    let agent = start(Opts::default());
    let mut c = client(&agent, &["--", "/bin/sh", "-c", "sleep 3011 & sleep 3012"])
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_secs(1));
    assert_eq!(processes_with_cmdline("sleep 3012").len(), 1);
    c.kill().unwrap();
    c.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let left = [
            processes_with_cmdline("sleep 3011"),
            processes_with_cmdline("sleep 3012"),
        ]
        .concat();
        if left.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "still running: {left:?}");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn termination_signal_kills_group() {
    let agent = start(Opts::default());
    let mut c = client(&agent, &["--", "/bin/sh", "-c", "sleep 3021"])
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_secs(1));
    Command::new("kill")
        .args(["-TERM", &c.id().to_string()])
        .status()
        .unwrap();
    assert_eq!(c.wait().unwrap().code(), Some(143));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !processes_with_cmdline("sleep 3021").is_empty() {
        assert!(Instant::now() < deadline, "sleep 3021 still running");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn pipes_then_exit() {
    let agent = start(Opts::default());
    let began = Instant::now();
    let out = run(
        &agent,
        &["--", "/bin/sh", "-c", "(sleep 1; echo late) & echo early"],
    );
    assert_eq!(text(&out.stdout), "early\nlate\n");
    assert!(began.elapsed() >= Duration::from_secs(1));
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn output_before_exit() {
    let agent = start(Opts::default());
    let out = run(
        &agent,
        &[
            "--",
            "/bin/sh",
            "-c",
            "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done",
        ],
    );
    let got = text(&out.stdout);
    let lines: Vec<&str> = got.lines().collect();
    assert_eq!(lines.len(), 2000);
    assert_eq!(lines[0], "line0");
    assert_eq!(lines[1999], "line1999");
}

#[test]
fn large_output_is_not_lost() {
    let agent = start(Opts::default());
    let out = run(
        &agent,
        &["--", "/bin/sh", "-c", "head -c 5000000 /dev/zero"],
    );
    assert_eq!(out.stdout.len(), 5_000_000);
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn setup_gate() {
    let dir = tempdir();
    let seeded = dir.join("seeded");
    let ran = dir.join("setup-ran");
    let agent = start(Opts {
        args: vec!["--wait-file".into(), seeded.to_str().unwrap().into()],
        setup: vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("echo ran > {}", ran.display()),
        ],
        ..Opts::default()
    });
    let mut c = client(&agent, &["--", "/bin/sh", "-c", "exit 0"])
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(700));
    assert!(
        c.try_wait().unwrap().is_none(),
        "the command ran before the workspace was ready"
    );
    assert!(!ran.exists());
    std::fs::write(&seeded, "").unwrap();
    assert_eq!(c.wait().unwrap().code(), Some(0));
    assert!(ran.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn setup_wait_times_out() {
    let agent = start(Opts {
        args: vec![
            "--wait-file".into(),
            "/nonexistent/seeded".into(),
            "--wait-timeout-sec".into(),
            "1".into(),
        ],
        ..Opts::default()
    });
    let out = run(&agent, &["--", "/bin/true"]);
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: toolchain_setup_failed\n");
}

#[test]
fn setup_failure() {
    let agent = start(Opts {
        setup: vec!["false".into()],
        ..Opts::default()
    });
    let out = run(&agent, &["--", "/bin/true"]);
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: toolchain_setup_failed\n");
}

#[test]
fn missing_shell() {
    let agent = start(Opts {
        args: vec!["--require-shell".into(), "/nonexistent".into()],
        ..Opts::default()
    });
    let out = run(&agent, &["--", "/bin/true"]);
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: toolchain_unusable:shell\n");
}

#[test]
fn command_that_cannot_start() {
    let agent = start(Opts::default());
    let out = run(&agent, &["--", "/nonexistent/program"]);
    assert_eq!(out.status.code(), Some(127));
    assert_eq!(text(&out.stderr), "wardby-cmd: cannot start the command\n");
}

#[test]
fn ready() {
    let mut agent = start(Opts::default());
    let status = Command::new(BIN)
        .args(["ready", &agent.addr])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
    agent.child.kill().unwrap();
    agent.child.wait().unwrap();
    let status = Command::new(BIN)
        .args(["ready", &agent.addr])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
}

#[test]
fn no_content_in_logs() {
    let mut agent = start(Opts::default());
    let out = client(
        &agent,
        &[
            "--",
            "/bin/sh",
            "-c",
            "echo fake-secret-9f2c; echo $SECRET_ENV >&2; exit 5",
            "fake-secret-9f2c",
        ],
    )
    .env("SECRET_ENV", "fake-secret-9f2c")
    .stdin(Stdio::null())
    .output()
    .unwrap();
    assert_eq!(out.status.code(), Some(5));
    // A version mismatch and a wrong token are not logged either.
    let mut s = TcpStream::connect(&agent.addr).unwrap();
    s.write_all(&frame(b'H', &7u16.to_be_bytes())).unwrap();
    let _ = read_frame(&mut s);
    agent.child.kill().unwrap();
    agent.child.wait().unwrap();
    let mut rest = String::new();
    agent.stderr.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "", "the agent logged more than its listening line");
}

#[test]
fn version_flag() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    let got = text(&out.stdout);
    assert!(got.starts_with("wardby-cmd "), "{got}");
    assert!(got.trim_end().ends_with("protocol 1"), "{got}");
}

#[test]
fn concurrent_commands() {
    let agent = start(Opts::default());
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let mut c = client(
                &agent,
                &["--", "/bin/sh", "-c", &format!("sleep 0.3; echo {i}")],
            );
            c.stdin(Stdio::null()).stdout(Stdio::piped());
            c.spawn().unwrap()
        })
        .collect();
    for (i, h) in handles.into_iter().enumerate() {
        let out = h.wait_with_output().unwrap();
        assert_eq!(text(&out.stdout), format!("{i}\n"));
    }
}

#[test]
fn escaped_orphans_are_reaped() {
    let agent = start(Opts::default());
    // setsid escapes the group kill, as today; when it exits, the agent (its subreaper) reaps it.
    let out = run(
        &agent,
        &[
            "--",
            "/bin/sh",
            "-c",
            "setsid sleep 0.3 >/dev/null 2>&1 & echo $!",
        ],
    );
    let pid = text(&out.stdout).trim().to_string();
    assert!(!pid.is_empty());
    let deadline = Instant::now() + Duration::from_secs(3);
    while std::fs::metadata(format!("/proc/{pid}")).is_ok() {
        assert!(Instant::now() < deadline, "orphan {pid} was not reaped");
        thread::sleep(Duration::from_millis(50));
    }
}

/// The binary linked as `bash` with no client config: the real bash runs, arguments unchanged.
fn bash_link() -> Option<(PathBuf, PathBuf)> {
    if !std::path::Path::new("/bin/bash").exists() {
        eprintln!("skipped: /bin/bash is not installed");
        return None;
    }
    if std::path::Path::new("/run/wardby/toolchain/client").exists() {
        eprintln!("skipped: a toolchain client config exists on this machine");
        return None;
    }
    let dir = tempdir();
    let link = dir.join("bash");
    std::os::unix::fs::symlink(BIN, &link).unwrap();
    Some((dir, link))
}

#[test]
fn bash_passes_through_without_a_toolchain() {
    let Some((dir, link)) = bash_link() else {
        return;
    };
    let out = Command::new(&link)
        .args(["-c", "echo $0 $1 $BASH_VERSION", "zero", "one"])
        .output()
        .unwrap();
    let got = text(&out.stdout);
    assert!(got.starts_with("zero one "), "{got:?}");
    assert!(
        got.trim_end().len() > "zero one ".len(),
        "not run by bash: {got:?}"
    );
    assert_eq!(out.status.code(), Some(0));

    let out = Command::new(&link)
        .args(["-lc", "exit 7"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));

    let script = dir.join("script.sh");
    std::fs::write(&script, "echo script $1\n").unwrap();
    let out = Command::new(&link)
        .arg(&script)
        .arg("arg")
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout), "script arg\n");

    let mut c = Command::new(&link)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin
        .take()
        .unwrap()
        .write_all(b"echo from stdin\n")
        .unwrap();
    assert_eq!(text(&c.wait_with_output().unwrap().stdout), "from stdin\n");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn bash_login_name_passes_through() {
    let Some((dir, link)) = bash_link() else {
        return;
    };
    let out = Command::new(&link)
        .arg0("-bash")
        .args(["-c", "shopt -q login_shell && echo login"])
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout), "login\n");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- `wardby-cmd once` (setup jobs) ----

const FAKE_SECRET: &str = "sk-fake-setup-secret-0123456789";

fn once_cmd(dir: &std::path::Path, extra: &[&str], timeout: &str, argv: &[&str]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.arg("once")
        .arg("--result-file")
        .arg(dir.join("result"))
        .args(extra)
        .args(["--timeout-sec", timeout, "--"])
        .args(argv)
        .current_dir(dir)
        .stdin(Stdio::null());
    cmd
}

fn once(dir: &std::path::Path, extra: &[&str], timeout: &str, argv: &[&str]) -> Output {
    once_cmd(dir, extra, timeout, argv).output().unwrap()
}

/// The result file's exact content, and that nothing else (no temp file) is left beside it.
fn result_of(dir: &std::path::Path) -> String {
    let names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".result") || n == "result")
        .collect();
    assert_eq!(
        names,
        vec!["result".to_string()],
        "leftover files: {names:?}"
    );
    std::fs::read_to_string(dir.join("result")).unwrap()
}

#[test]
fn once_success_and_cwd() {
    let dir = tempdir();
    // As root (the test container), create /workspace so the /workspace branch is exercised;
    // it is never removed, so concurrent tests never see it vanish.
    let _ = std::fs::create_dir("/workspace");
    let expected = if std::path::Path::new("/workspace").is_dir() {
        PathBuf::from("/workspace")
    } else {
        std::fs::canonicalize(&dir).unwrap()
    };
    let out = once(&dir, &[], "10", &["/bin/sh", "-c", "pwd"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(text(&out.stdout).trim(), expected.to_string_lossy());
    assert_eq!(result_of(&dir), "0");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_failure_code_and_signal() {
    let dir = tempdir();
    let out = once(&dir, &[], "10", &["/bin/sh", "-c", "exit 3"]);
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(result_of(&dir), "3");
    let out = once(&dir, &[], "10", &["/bin/sh", "-c", "kill -9 $$"]);
    assert_eq!(out.status.code(), Some(137));
    assert_eq!(result_of(&dir), "137");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_output_passes_through() {
    let dir = tempdir();
    let out = once(
        &dir,
        &[],
        "10",
        &["/bin/sh", "-c", "printf 'out\\n'; printf 'err\\n' >&2"],
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(text(&out.stdout), "out\n");
    assert_eq!(text(&out.stderr), "err\n");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_after_a_failed_job_does_not_run() {
    let dir = tempdir();
    let after = dir.join("earlier");
    std::fs::write(&after, "3").unwrap();
    let marker = dir.join("ran");
    let script = format!("touch {}", marker.display());
    let out = once(
        &dir,
        &["--after-file", after.to_str().unwrap()],
        "10",
        &["/bin/sh", "-c", &script],
    );
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(result_of(&dir), "125");
    assert!(!marker.exists(), "the command ran after a failed job");

    // `0` (with surrounding whitespace) means the earlier job succeeded.
    std::fs::write(&after, "0\n").unwrap();
    let out = once(
        &dir,
        &["--after-file", after.to_str().unwrap()],
        "10",
        &["/bin/sh", "-c", &script],
    );
    assert_eq!(out.status.code(), Some(0));
    assert!(marker.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_waits_for_files_beyond_its_timeout() {
    // The waits are not bounded by --timeout-sec: a 1 s job still runs after a 1.5 s wait.
    let dir = tempdir();
    let seeded = dir.join(".seeded");
    let after = dir.join("earlier");
    let marker = dir.join("ran");
    let script = format!("touch {}", marker.display());
    let mut child = once_cmd(
        &dir,
        &[
            "--wait-file",
            seeded.to_str().unwrap(),
            "--after-file",
            after.to_str().unwrap(),
        ],
        "1",
        &["/bin/sh", "-c", &script],
    )
    .spawn()
    .unwrap();
    thread::sleep(Duration::from_millis(800));
    // The after-file alone does not release it: the wait-file comes first.
    std::fs::write(&after, "0").unwrap();
    thread::sleep(Duration::from_millis(700));
    assert!(
        child.try_wait().unwrap().is_none(),
        "ran before the wait-file"
    );
    assert!(!marker.exists());
    std::fs::write(&seeded, "").unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(marker.exists());
    assert_eq!(result_of(&dir), "0");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_termination_while_waiting() {
    let dir = tempdir();
    let missing = dir.join("never");
    let mut child = once_cmd(
        &dir,
        &["--wait-file", missing.to_str().unwrap()],
        "10",
        &["/bin/true"],
    )
    .spawn()
    .unwrap();
    thread::sleep(Duration::from_millis(300));
    Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(143));
    assert_eq!(result_of(&dir), "143");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_timeout_kills_the_group() {
    let dir = tempdir();
    let started = Instant::now();
    let out = once(
        &dir,
        &[],
        "1",
        &["/bin/sh", "-c", "trap '' TERM; sleep 31 & sleep 31; wait"],
    );
    assert_eq!(out.status.code(), Some(124));
    assert_eq!(result_of(&dir), "124");
    let took = started.elapsed();
    assert!(took >= Duration::from_secs(3), "no SIGKILL grace: {took:?}");
    assert!(took < Duration::from_secs(10), "{took:?}");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !processes_with_cmdline("sleep 31").is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(processes_with_cmdline("sleep 31").is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_cannot_start() {
    let dir = tempdir();
    let missing = format!("/nonexistent/{FAKE_SECRET}");
    let out = once_cmd(&dir, &[], "10", &[&missing, FAKE_SECRET])
        .env("SETUP_TOKEN", FAKE_SECRET)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(127));
    assert_eq!(result_of(&dir), "127");
    assert_eq!(text(&out.stderr), "wardby-cmd: cannot start the command\n");
    assert!(out.stdout.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn once_logs_nothing_of_its_own() {
    let dir = tempdir();
    let out = once_cmd(&dir, &[], "10", &["/bin/sh", "-c", "true", FAKE_SECRET])
        .env("SETUP_TOKEN", FAKE_SECRET)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());

    // A result that cannot be written: a fixed line, exit 125, the path never echoed.
    let missing_dir = dir.join(FAKE_SECRET).join("result");
    let out = Command::new(BIN)
        .arg("once")
        .arg("--result-file")
        .arg(&missing_dir)
        .args(["--timeout-sec", "10", "--", "/bin/true", FAKE_SECRET])
        .env("SETUP_TOKEN", FAKE_SECRET)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
    assert_eq!(text(&out.stderr), "wardby-cmd: cannot write the result\n");
    assert!(!text(&out.stdout).contains(FAKE_SECRET));

    // Bad arguments print only the usage text.
    let out = Command::new(BIN)
        .args(["once", "--timeout-sec", "10", "--", FAKE_SECRET])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!text(&out.stderr).contains(FAKE_SECRET));
    let _ = std::fs::remove_dir_all(&dir);
}
