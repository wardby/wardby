//! Reaps orphans (the agent is the toolchain container's PID 1) without stealing the exit status
//! of the commands the agent itself waits for.
//!
//! The loop peeks at an exited child without reaping it. A child started through
//! [`Reaper::spawn`] is left for its owner; anything else is an orphan and is reaped. `spawn`
//! holds the registry lock across `Command::spawn`, so a child (including one whose exec fails
//! and which std reaps itself) is registered before the loop can look at it.

use std::collections::HashSet;
use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use crate::sys;

pub struct Reaper {
    owned: Mutex<HashSet<i32>>,
}

impl Reaper {
    /// Starts the reaping thread.
    pub fn start() -> Arc<Reaper> {
        let reaper = Arc::new(Reaper {
            owned: Mutex::new(HashSet::new()),
        });
        let r = reaper.clone();
        thread::spawn(move || r.run());
        reaper
    }

    fn lock(&self) -> MutexGuard<'_, HashSet<i32>> {
        self.owned.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn run(&self) {
        loop {
            match sys::peek_exited() {
                Ok(pid) => {
                    let owned = self.lock();
                    if owned.contains(&pid) {
                        drop(owned);
                        thread::sleep(Duration::from_millis(20));
                    } else {
                        sys::reap(pid);
                    }
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
    }

    /// Spawns a child the caller will wait for itself.
    pub fn spawn(&self, cmd: &mut Command) -> io::Result<Child> {
        let mut owned = self.lock();
        let child = cmd.spawn()?;
        owned.insert(child.id() as i32);
        Ok(child)
    }

    /// Waits for a child started with [`Reaper::spawn`] and stops tracking it. The pid is
    /// released under the lock, so a new child reusing it is never forgotten by mistake.
    pub fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
        let pid = child.id() as i32;
        sys::wait_exited_nowait(pid)?;
        let mut owned = self.lock();
        let status = child.wait();
        owned.remove(&pid);
        status
    }

    /// Like [`Reaper::wait`] without blocking: `None` while the child runs.
    pub fn try_wait(&self, child: &mut Child) -> io::Result<Option<ExitStatus>> {
        let mut owned = self.lock();
        let status = child.try_wait()?;
        if status.is_some() {
            owned.remove(&(child.id() as i32));
        }
        Ok(status)
    }

    /// Stops tracking `pid` (for a child the caller reaped some other way).
    #[cfg(test)]
    pub fn forget(&self, pid: i32) {
        self.lock().remove(&pid);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Instant;

    fn state(pid: i32) -> Option<String> {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        status
            .lines()
            .find(|l| l.starts_with("State:"))
            .map(str::to_string)
    }

    // One test: the reaper reaps every unregistered child of the test process.
    #[test]
    fn reaps_orphans_but_not_owned_children() {
        sys::become_subreaper().unwrap();
        let reaper = Reaper::start();

        // An orphan: sh exits at once, its background sleep reparents to this process.
        let mut sh = reaper
            .spawn(
                Command::new("/bin/sh")
                    .args(["-c", "sleep 0.2 & echo $!"])
                    .stdout(Stdio::piped()),
            )
            .unwrap();
        let mut out = String::new();
        sh.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let orphan: i32 = out.trim().parse().unwrap();
        assert!(reaper.wait(&mut sh).unwrap().success());
        let deadline = Instant::now() + Duration::from_secs(2);
        while state(orphan).is_some() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(state(orphan), None, "orphan {orphan} was not reaped");

        // An owned child keeps its exit status for its owner, even after the reaper has seen it.
        let mut child = reaper
            .spawn(Command::new("/bin/sh").args(["-c", "exit 3"]))
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(child.wait().unwrap().code(), Some(3));
        reaper.forget(child.id() as i32);

        let mut child = reaper
            .spawn(Command::new("/bin/sh").args(["-c", "exit 4"]))
            .unwrap();
        assert_eq!(reaper.wait(&mut child).unwrap().code(), Some(4));
        assert!(reaper.lock().is_empty());
    }
}
