//! The `bash` multi-call entry point: Codex's login shell in the worker.
//!
//! In a toolchain run (the client config file exists) `bash -c CMD [ARG0 ARGS...]`, with or
//! without `-l`/`--login`, is forwarded to the toolchain as `/bin/sh -c CMD [ARG0 ARGS...]`
//! (no login shell: the toolchain image's own environment stays in force). Every other
//! invocation, and every invocation outside a toolchain run, `exec`s the real `/bin/bash` with
//! the same arguments.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, exit};

use crate::client;
use crate::sys;

/// Written by the worker in a toolchain run: the agent's address, then the token file's path.
pub const CLIENT_CONFIG: &str = "/run/wardby/toolchain/client";

const REAL_BASH: &str = "/bin/bash";

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Forward {
        addr: String,
        token_file: PathBuf,
        argv: Vec<String>,
    },
    Exec,
}

/// The command string and its positional arguments of a `bash [-l] -c CMD ARGS...` call.
pub fn command_from_bash_args(args: &[String]) -> Option<(String, Vec<String>)> {
    let mut command_flag = false;
    let mut options_done = false;
    for (i, a) in args.iter().enumerate() {
        if !options_done {
            if a == "--login" {
                continue;
            }
            if a == "--" {
                options_done = true;
                continue;
            }
            if let Some(flags) = a.strip_prefix('-')
                && !flags.is_empty()
            {
                if !flags.chars().all(|c| c == 'l' || c == 'c') {
                    return None;
                }
                command_flag |= flags.contains('c');
                continue;
            }
            if a.starts_with('+') {
                return None;
            }
        }
        return command_flag.then(|| (a.clone(), args[i + 1..].to_vec()));
    }
    None
}

/// The address and token file from the client config, if it is well formed.
fn parse_config(text: &str) -> Option<(String, PathBuf)> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let addr = lines.next()?.to_string();
    let token_file = PathBuf::from(lines.next()?);
    if lines.next().is_some() || !token_file.is_absolute() {
        return None;
    }
    Some((addr, token_file))
}

fn decide(config: Option<&str>, args: &[String]) -> Action {
    let Some((addr, token_file)) = config.and_then(parse_config) else {
        return Action::Exec;
    };
    let Some((command, rest)) = command_from_bash_args(args) else {
        return Action::Exec;
    };
    let mut argv = vec!["/bin/sh".to_string(), "-c".to_string(), command];
    argv.extend(rest);
    Action::Forward {
        addr,
        token_file,
        argv,
    }
}

/// Runs as `bash`: forwards or becomes the real bash. Never returns.
pub fn bash_main(argv0: &str, args: &[String]) -> ! {
    let config = std::fs::read_to_string(Path::new(CLIENT_CONFIG)).ok();
    match decide(config.as_deref(), args) {
        Action::Forward {
            addr,
            token_file,
            argv,
        } => exit(client::run(&addr, &token_file, argv, sys::isatty(0))),
        Action::Exec => {
            // A login shell keeps its leading dash, as login(1) passed it.
            let name = if argv0.starts_with('-') {
                "-bash"
            } else {
                "bash"
            };
            // exec only returns on failure.
            let _ = Command::new(REAL_BASH).arg0(name).args(args).exec();
            eprintln!("wardby-cmd: cannot run {REAL_BASH}");
            exit(127)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(a: &[&str]) -> Vec<String> {
        a.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn command_forms() {
        for form in [
            &["-c", "x"][..],
            &["-lc", "x"],
            &["-cl", "x"],
            &["-l", "-c", "x"],
            &["--login", "-c", "x"],
        ] {
            assert_eq!(
                command_from_bash_args(&s(form)),
                Some(("x".to_string(), vec![])),
                "{form:?}"
            );
        }
        assert_eq!(
            command_from_bash_args(&s(&["-c", "x", "a0", "a1"])),
            Some(("x".into(), s(&["a0", "a1"])))
        );
        assert_eq!(
            command_from_bash_args(&s(&["-c", "--", "x"])),
            Some(("x".into(), vec![]))
        );
        assert_eq!(
            command_from_bash_args(&s(&["-c", "x", "-l"])),
            Some(("x".into(), s(&["-l"])))
        );
    }

    #[test]
    fn other_forms_are_not_forwarded() {
        for form in [
            &[][..],
            &["-i"],
            &["script.sh"],
            &["-l"],
            &["-c"],
            &["-e", "-c", "x"],
            &["--norc", "-c", "x"],
            &["+O", "extglob", "-c", "x"],
            &["-l", "script.sh"],
        ] {
            assert_eq!(command_from_bash_args(&s(form)), None, "{form:?}");
        }
    }

    #[test]
    fn config_parsing() {
        assert_eq!(
            parse_config("127.0.0.1:7071\n/opt/wardby-cmd/token\n"),
            Some((
                "127.0.0.1:7071".into(),
                PathBuf::from("/opt/wardby-cmd/token")
            ))
        );
        assert_eq!(parse_config(""), None);
        assert_eq!(parse_config("127.0.0.1:7071\n"), None);
        assert_eq!(parse_config("127.0.0.1:7071\nrelative/token\n"), None);
        assert_eq!(parse_config("a\n/b\nc\n"), None);
    }

    #[test]
    fn forwards_only_with_a_config_and_a_command() {
        let config = "127.0.0.1:7071\n/opt/wardby-cmd/token\n";
        assert_eq!(
            decide(Some(config), &s(&["-lc", "echo $0", "zero"])),
            Action::Forward {
                addr: "127.0.0.1:7071".into(),
                token_file: PathBuf::from("/opt/wardby-cmd/token"),
                argv: s(&["/bin/sh", "-c", "echo $0", "zero"]),
            }
        );
        assert_eq!(decide(None, &s(&["-lc", "echo"])), Action::Exec);
        assert_eq!(decide(Some("garbage"), &s(&["-lc", "echo"])), Action::Exec);
        assert_eq!(decide(Some(config), &s(&["-i"])), Action::Exec);
    }
}
