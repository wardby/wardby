//! `wardby-cmd`: runs a coding run's commands in a team's toolchain container.
//!
//! ```text
//! wardby-cmd serve --listen ADDR --token-file PATH [--wait-file PATH] [--wait-timeout-sec N]
//!                  [--require-shell PATH] [-- SETUP_ARGV...]
//! wardby-cmd run ADDR TOKEN_FILE [-t] -- ARGV...
//! wardby-cmd ready ADDR
//! wardby-cmd once --result-file PATH [--wait-file PATH] [--after-file PATH] --timeout-sec N
//!                 -- ARGV...
//! wardby-cmd --version
//! bash ...            (started under the name `bash`: see shell.rs)
//! ```
#![deny(unsafe_code)]

mod client;
mod env;
mod frame;
mod header;
mod once;
mod reaper;
mod server;
mod shell;
#[allow(unsafe_code)] // the one module with system calls; see its SAFETY comments
mod sys;

use std::path::PathBuf;
use std::process::exit;
use std::time::Duration;

const USAGE: &str = "usage: wardby-cmd serve --listen ADDR --token-file PATH [--wait-file PATH] \
[--wait-timeout-sec N] [--require-shell PATH] [-- SETUP_ARGV...]
       wardby-cmd run ADDR TOKEN_FILE [-t] -- ARGV...
       wardby-cmd ready ADDR
       wardby-cmd once --result-file PATH [--wait-file PATH] [--after-file PATH] --timeout-sec N \
-- ARGV...
       wardby-cmd --version";

const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(600);
const READY_TIMEOUT: Duration = Duration::from_secs(1);

fn usage() -> ! {
    eprintln!("{USAGE}");
    exit(2)
}

fn parse_serve(args: &[String]) -> Option<server::ServeConfig> {
    let mut listen = None;
    let mut token_file = None;
    let mut wait_file = None;
    let mut wait_timeout = DEFAULT_WAIT_TIMEOUT;
    let mut require_shell = PathBuf::from("/bin/sh");
    let mut setup = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--listen" => listen = Some(it.next()?.clone()),
            "--token-file" => token_file = Some(PathBuf::from(it.next()?)),
            "--wait-file" => wait_file = Some(PathBuf::from(it.next()?)),
            "--wait-timeout-sec" => wait_timeout = Duration::from_secs(it.next()?.parse().ok()?),
            "--require-shell" => require_shell = PathBuf::from(it.next()?),
            "--" => {
                setup = it.cloned().collect();
                break;
            }
            _ => return None,
        }
    }
    Some(server::ServeConfig {
        listen: listen?,
        token_file: token_file?,
        wait_file,
        wait_timeout,
        require_shell,
        setup,
    })
}

fn parse_run(args: &[String]) -> Option<(String, PathBuf, bool, Vec<String>)> {
    let [addr, token_file, rest @ ..] = args else {
        return None;
    };
    let (tty, rest) = match rest {
        [t, rest @ ..] if t == "-t" => (true, rest),
        _ => (false, rest),
    };
    let argv = match rest {
        [dd, argv @ ..] if dd == "--" => argv,
        argv => argv,
    };
    if argv.is_empty() {
        return None;
    }
    Some((addr.clone(), PathBuf::from(token_file), tty, argv.to_vec()))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let argv0 = args.first().map(String::as_str).unwrap_or("");
    let name = argv0.rsplit('/').next().unwrap_or("");
    if name == "bash" || name == "-bash" {
        shell::bash_main(name, &args[1..]);
    }
    match args.get(1).map(String::as_str) {
        Some("--version") => {
            println!(
                "wardby-cmd {} protocol {}",
                env!("CARGO_PKG_VERSION"),
                header::PROTOCOL_VERSION
            );
        }
        Some("serve") => {
            let cfg = parse_serve(&args[2..]).unwrap_or_else(|| usage());
            exit(server::serve(cfg));
        }
        Some("run") => {
            let (addr, token_file, tty, argv) = parse_run(&args[2..]).unwrap_or_else(|| usage());
            exit(client::run(&addr, &token_file, argv, tty));
        }
        Some("once") => {
            let cfg = once::parse(&args[2..]).unwrap_or_else(|| usage());
            exit(once::once(cfg));
        }
        Some("ready") if args.len() == 3 => {
            exit(if client::connect(&args[2], READY_TIMEOUT).is_some() {
                0
            } else {
                1
            });
        }
        _ => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn serve_arguments() {
        let cfg = parse_serve(&strings(&[
            "--listen",
            "127.0.0.1:7071",
            "--token-file",
            "/opt/wardby-cmd/token",
            "--wait-file",
            "/run/wardby/input/.seeded",
            "--wait-timeout-sec",
            "30",
            "--",
            "render-config",
            "--out",
            "/home/wardby/app.yaml",
        ]))
        .unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:7071");
        assert_eq!(cfg.token_file, PathBuf::from("/opt/wardby-cmd/token"));
        assert_eq!(
            cfg.wait_file,
            Some(PathBuf::from("/run/wardby/input/.seeded"))
        );
        assert_eq!(cfg.wait_timeout, Duration::from_secs(30));
        assert_eq!(cfg.require_shell, PathBuf::from("/bin/sh"));
        assert_eq!(
            cfg.setup,
            strings(&["render-config", "--out", "/home/wardby/app.yaml"])
        );
        assert!(parse_serve(&strings(&["--listen", "x"])).is_none());
        assert!(
            parse_serve(&strings(&["--listen", "x", "--token-file", "t", "--bogus"])).is_none()
        );
        assert!(
            parse_serve(&strings(&[
                "--listen",
                "x",
                "--token-file",
                "t",
                "--wait-timeout-sec",
                "x"
            ]))
            .is_none()
        );
    }

    #[test]
    fn run_arguments() {
        let (addr, token, tty, argv) =
            parse_run(&strings(&["a:1", "/t", "-t", "--", "sh", "-c", "x"])).unwrap();
        assert_eq!(
            (addr.as_str(), token, tty),
            ("a:1", PathBuf::from("/t"), true)
        );
        assert_eq!(argv, strings(&["sh", "-c", "x"]));
        let (_, _, tty, argv) = parse_run(&strings(&["a:1", "/t", "--", "-t"])).unwrap();
        assert!(!tty);
        assert_eq!(argv, strings(&["-t"]));
        assert!(parse_run(&strings(&["a:1", "/t", "--"])).is_none());
        assert!(parse_run(&strings(&["a:1"])).is_none());
    }
}
