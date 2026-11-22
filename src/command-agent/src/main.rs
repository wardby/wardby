//! `wardby-cmd`: runs a coding run's commands in a team's toolchain container.
//!
//! - `serve`: the toolchain container's entrypoint (the agent).
//! - `run`: the client, used by the tool runner to forward one command.
//! - `ready`: exits 0 when the agent is listening.
#![deny(unsafe_code)]

#[allow(dead_code)] // used from the server and client (next commits)
mod env;
#[allow(dead_code)]
mod frame;
#[allow(dead_code)]
mod header;
#[allow(dead_code)]
mod reaper;
#[allow(dead_code)]
#[allow(unsafe_code)] // the one module with system calls; see its SAFETY comments
mod sys;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") => {
            println!(
                "wardby-cmd {} protocol {}",
                env!("CARGO_PKG_VERSION"),
                header::PROTOCOL_VERSION
            );
        }
        _ => {
            eprintln!("usage: wardby-cmd --version");
            std::process::exit(2);
        }
    }
}
