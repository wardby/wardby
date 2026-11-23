//! `wardby-cmd once`: a setup job's entrypoint. Runs one command after the run's services are
//! ready and before its agent starts, and records the command's exit code in a result file.
//!
//! ```text
//! wardby-cmd once --result-file PATH [--wait-file PATH] [--after-file PATH] --timeout-sec N -- ARGV...
//! ```
//!
//! 1. Waits until `--wait-file` exists, then until `--after-file` exists (each only if given).
//! 2. If the after-file's trimmed content is not exactly `0` (the job before failed), records
//!    125 without running ARGV.
//! 3. Runs ARGV in its own process group, cwd `/workspace` if present (else the current dir),
//!    stdin null, stdout and stderr inherited unchanged (the launcher reads the container's logs).
//! 4. After N seconds: SIGTERM the group, SIGKILL it 2 s later, record 124. A command that
//!    cannot start records 127; one killed by signal n records 128 + n.
//! 5. Writes the code (decimal, no newline) to `--result-file` atomically (a temp file in the
//!    same directory, then rename) and exits with it. A result that cannot be written exits 125.
//!
//! **Wait budget:** `--timeout-sec` bounds only the command's run, measured from its start. The
//! waits have no bound of their own. Job n waits for job n-1's result file, and job n-1 may take
//! the seed time plus its own (possibly much longer) timeout, so bounding job n's wait by job n's
//! N would fail a short job queued behind a long one. Every way a predecessor ends writes a
//! result (124, 125, 127, 128 + n, or its code), and the launcher bounds the run as a whole and
//! stops the pod or container, which ends the wait with a termination signal.
//!
//! On SIGTERM, SIGINT or SIGHUP (it may be PID 1, which ignores signals it has no handler for):
//! while waiting, records 128 + n at once; while running, stops the group as on a timeout and
//! records 128 + n. Its only stderr lines are fixed: it never prints the argv, the environment
//! or a path.

use std::fs;
use std::io::{self, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::reaper::Reaper;
use crate::sys;

/// The exit code that means "wardby-cmd failed" or "an earlier job failed", not the command.
pub const AGENT_FAILURE: i32 = 125;
pub const TIMED_OUT: i32 = 124;
pub const CANNOT_START: i32 = 127;

const WAIT_POLL: Duration = Duration::from_millis(200);
const RUN_POLL: Duration = Duration::from_millis(50);
const KILL_GRACE: Duration = Duration::from_secs(2);
const WORKSPACE: &str = "/workspace";

#[derive(Debug, PartialEq, Eq)]
pub struct OnceConfig {
    pub result_file: PathBuf,
    pub wait_file: Option<PathBuf>,
    pub after_file: Option<PathBuf>,
    pub timeout: Duration,
    pub argv: Vec<String>,
}

/// Parses the arguments after `once`. `None` on any unknown flag, a missing value, a missing
/// `--result-file` or `--timeout-sec`, a timeout of 0, or an empty ARGV.
pub fn parse(args: &[String]) -> Option<OnceConfig> {
    let mut result_file = None;
    let mut wait_file = None;
    let mut after_file = None;
    let mut timeout = None;
    let mut argv = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--result-file" => result_file = Some(PathBuf::from(it.next()?)),
            "--wait-file" => wait_file = Some(PathBuf::from(it.next()?)),
            "--after-file" => after_file = Some(PathBuf::from(it.next()?)),
            "--timeout-sec" => {
                let n: u64 = it.next()?.parse().ok()?;
                if n == 0 {
                    return None;
                }
                timeout = Some(Duration::from_secs(n));
            }
            "--" => {
                argv = it.cloned().collect();
                break;
            }
            _ => return None,
        }
    }
    if argv.is_empty() {
        return None;
    }
    Some(OnceConfig {
        result_file: result_file?,
        wait_file,
        after_file,
        timeout: timeout?,
        argv,
    })
}

pub fn once(cfg: OnceConfig) -> i32 {
    sys::record_termination();
    // Orphans reparent to wardby-cmd even when it is not PID 1 (tests, some runtimes).
    let _ = sys::become_subreaper();
    let reaper = Reaper::start();
    let code = decide(&cfg, &reaper);
    finish(&cfg.result_file, code)
}

fn decide(cfg: &OnceConfig, reaper: &Reaper) -> i32 {
    for file in [&cfg.wait_file, &cfg.after_file].into_iter().flatten() {
        if let Some(sig) = wait_for(file) {
            return 128 + sig;
        }
    }
    if let Some(after) = &cfg.after_file {
        let earlier_succeeded = fs::read_to_string(after).is_ok_and(|s| s.trim() == "0");
        if !earlier_succeeded {
            return AGENT_FAILURE;
        }
    }
    run(&cfg.argv, cfg.timeout, reaper)
}

/// Polls until `file` exists. `Some(signal)` if a termination signal came first.
fn wait_for(file: &Path) -> Option<i32> {
    loop {
        if let Some(sig) = sys::termination_signal() {
            return Some(sig);
        }
        if file.exists() {
            return None;
        }
        thread::sleep(WAIT_POLL);
    }
}

fn run(argv: &[String], timeout: Duration, reaper: &Reaper) -> i32 {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let workspace = Path::new(WORKSPACE);
    if workspace.is_dir() {
        cmd.current_dir(workspace);
    }
    let Ok(mut child) = reaper.spawn(&mut cmd) else {
        eprintln!("wardby-cmd: cannot start the command");
        return CANNOT_START;
    };
    let pgid = child.id() as i32;
    let deadline = Instant::now() + timeout;
    let mut forced: Option<i32> = None;
    // The leader is never reaped before the group is killed, so its group id stays reserved.
    while !sys::has_exited(pgid).unwrap_or(true) {
        if let Some(sig) = sys::termination_signal() {
            forced = Some(128 + sig);
        } else if Instant::now() >= deadline {
            forced = Some(TIMED_OUT);
        }
        if forced.is_some() {
            stop(pgid);
            break;
        }
        thread::sleep(RUN_POLL);
    }
    let _ = sys::wait_exited_nowait(pgid);
    // Whatever the command left running in its group ends with it.
    sys::kill_group(pgid);
    let status = reaper.wait(&mut child);
    if let Some(code) = forced {
        return code;
    }
    match status {
        Ok(s) => s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0)),
        Err(_) => AGENT_FAILURE,
    }
}

/// SIGTERM the group, then SIGKILL it if the leader has not exited within the grace period.
fn stop(pgid: i32) {
    sys::term_group(pgid);
    let grace = Instant::now() + KILL_GRACE;
    while Instant::now() < grace {
        if sys::has_exited(pgid).unwrap_or(true) {
            break;
        }
        thread::sleep(RUN_POLL);
    }
    sys::kill_group(pgid);
}

/// Records `code` and returns the exit code: `code`, or 125 if it could not be recorded.
fn finish(result_file: &Path, code: i32) -> i32 {
    if write_atomically(result_file, code.to_string().as_bytes()).is_err() {
        eprintln!("wardby-cmd: cannot write the result");
        return AGENT_FAILURE;
    }
    code
}

/// Writes a temp file beside `path` and renames it over `path`, so a reader sees either no
/// file or the whole content. The directory must already exist (the launcher creates it).
fn write_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments() {
        let cfg = parse(&strings(&[
            "--result-file",
            "/run/wardby/setup/migrate",
            "--wait-file",
            "/run/wardby/input/.seeded",
            "--after-file",
            "/run/wardby/setup/seed",
            "--timeout-sec",
            "600",
            "--",
            "npm",
            "run",
            "--timeout-sec",
        ]))
        .unwrap();
        assert_eq!(
            cfg,
            OnceConfig {
                result_file: PathBuf::from("/run/wardby/setup/migrate"),
                wait_file: Some(PathBuf::from("/run/wardby/input/.seeded")),
                after_file: Some(PathBuf::from("/run/wardby/setup/seed")),
                timeout: Duration::from_secs(600),
                argv: strings(&["npm", "run", "--timeout-sec"]),
            }
        );
        let minimal = parse(&strings(&[
            "--timeout-sec",
            "1",
            "--result-file",
            "r",
            "--",
            "x",
        ]));
        assert_eq!(minimal.unwrap().wait_file, None);
        for bad in [
            &["--timeout-sec", "1", "--", "x"][..],
            &["--result-file", "r", "--", "x"],
            &["--result-file", "r", "--timeout-sec", "1", "--"],
            &["--result-file", "r", "--timeout-sec", "1"],
            &["--result-file", "r", "--timeout-sec", "0", "--", "x"],
            &["--result-file", "r", "--timeout-sec", "x", "--", "x"],
            &[
                "--result-file",
                "r",
                "--timeout-sec",
                "1",
                "--bogus",
                "--",
                "x",
            ],
            &["--result-file"],
        ] {
            assert!(parse(&strings(bad)).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn atomic_write_leaves_only_the_result() {
        let dir = std::env::temp_dir().join(format!("wardby-once-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("job");
        assert_eq!(finish(&path, 3), 3);
        assert_eq!(finish(&path, 0), 0);
        assert_eq!(fs::read_to_string(&path).unwrap(), "0");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("job")]);
        assert_eq!(finish(&dir.join("missing").join("job"), 0), AGENT_FAILURE);
        fs::remove_dir_all(&dir).unwrap();
    }
}
