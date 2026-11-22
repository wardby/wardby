//! Every system call the crate makes outside `std`. This is the only module allowed `unsafe`;
//! each block says why it is sound.

use std::fs::File;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI32, Ordering};

use crate::header::Window;

/// SIGKILLs every process in group `pgid`. Groups 0 and 1 (ours, init's) are never targeted.
pub fn kill_group(pgid: i32) {
    if pgid > 1 {
        // SAFETY: kill(2) takes plain integers and has no memory effects; a negative pid names
        // the process group. An already-empty group just returns ESRCH.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

fn winsize(w: Window) -> libc::winsize {
    libc::winsize {
        ws_row: w.rows,
        ws_col: w.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl(2) with F_GETFD/F_SETFD only reads and writes the descriptor's flags; `fd`
    // is a descriptor this process owns.
    let ok = unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        flags >= 0 && libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) == 0
    };
    if ok {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Opens a pseudo-terminal of size `w`: the master as a `File` (read output, write input) and
/// the slave for the child's stdio. Both are close-on-exec, so other commands never inherit them.
pub fn openpty(w: Window) -> io::Result<(File, OwnedFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = winsize(w);
    // SAFETY: openpty(3) writes two descriptors into the provided ints; the name buffer and
    // termios are null (allowed), and `ws` is a valid winsize that outlives the call.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            &ws,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success both descriptors are freshly opened and owned by nobody else; each is
    // wrapped exactly once, so each is closed exactly once.
    let (master, slave) = unsafe { (File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_cloexec(std::os::fd::AsRawFd::as_raw_fd(&master))?;
    set_cloexec(std::os::fd::AsRawFd::as_raw_fd(&slave))?;
    Ok((master, slave))
}

/// Sets a terminal's window size (on the master, the child sees SIGWINCH).
pub fn set_window(fd: RawFd, w: Window) -> io::Result<()> {
    let ws = winsize(w);
    // SAFETY: TIOCSWINSZ reads one winsize from the pointer, which is valid for the call.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The terminal's window size, if `fd` is a terminal with a non-zero size.
pub fn window_of(fd: RawFd) -> Option<Window> {
    let mut ws = MaybeUninit::<libc::winsize>::zeroed();
    // SAFETY: TIOCGWINSZ writes one winsize into the pointer, which is valid and sized for it.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, ws.as_mut_ptr()) };
    if rc != 0 {
        return None;
    }
    // SAFETY: zero-initialised, and on success fully written by the kernel.
    let ws = unsafe { ws.assume_init() };
    (ws.ws_row > 0 && ws.ws_col > 0).then_some(Window {
        rows: ws.ws_row,
        cols: ws.ws_col,
    })
}

pub fn isatty(fd: RawFd) -> bool {
    // SAFETY: isatty(3) only inspects the descriptor.
    unsafe { libc::isatty(fd) == 1 }
}

/// The terminal settings to restore on exit, set once by `raw_mode`. Kept in a static so the
/// termination handler can restore them too.
static SAVED_TERMIOS: OnceLock<(RawFd, libc::termios)> = OnceLock::new();

/// Restores the terminal's settings when dropped.
pub struct RawGuard {
    fd: RawFd,
    saved: libc::termios,
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        // SAFETY: tcsetattr(3) reads the termios captured from this same descriptor.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
        }
    }
}

/// Puts the terminal on `fd` in raw mode, so keystrokes (including ^C) go to the remote
/// terminal unchanged. `None` if `fd` is not a terminal.
pub fn raw_mode(fd: RawFd) -> Option<RawGuard> {
    let mut t = MaybeUninit::<libc::termios>::zeroed();
    // SAFETY: tcgetattr(3) fills the termios behind a valid pointer; it is zero-initialised so
    // reading it is defined either way, and it is used only when the call succeeded.
    let saved = unsafe {
        if libc::tcgetattr(fd, t.as_mut_ptr()) != 0 {
            return None;
        }
        t.assume_init()
    };
    let mut raw = saved;
    // SAFETY: cfmakeraw(3) edits the termios in place; tcsetattr(3) reads it.
    let rc = unsafe {
        libc::cfmakeraw(&mut raw);
        libc::tcsetattr(fd, libc::TCSANOW, &raw)
    };
    if rc != 0 {
        return None;
    }
    let _ = SAVED_TERMIOS.set((fd, saved));
    Some(RawGuard { fd, saved })
}

/// Makes the child a session leader whose controlling terminal is its stdin (the pty slave the
/// command's stdio was set to), so it gets job control and terminal signals like a login shell.
pub fn new_session_on_tty(cmd: &mut Command) {
    // SAFETY: the closure runs in the forked child before exec and calls only setsid(2) and
    // ioctl(2), both async-signal-safe; it touches no memory shared with the parent.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

fn siginfo_pid(
    flags: libc::c_int,
    idtype: libc::idtype_t,
    id: libc::id_t,
) -> io::Result<Option<i32>> {
    let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
    loop {
        // SAFETY: waitid(2) writes one siginfo_t into a valid, zeroed buffer.
        let rc = unsafe { libc::waitid(idtype, id, info.as_mut_ptr(), flags) };
        if rc == 0 {
            break;
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
    // SAFETY: the buffer was zeroed and waitid succeeded; si_pid reads the pid field, which is 0
    // when WNOHANG found nothing.
    let pid = unsafe { info.assume_init().si_pid() };
    Ok((pid != 0).then_some(pid))
}

/// Blocks until any child has exited and returns its pid, leaving it unreaped (WNOWAIT).
/// `ECHILD` when there are no children.
pub fn peek_exited() -> io::Result<i32> {
    siginfo_pid(libc::WEXITED | libc::WNOWAIT, libc::P_ALL, 0)?
        .ok_or_else(|| io::Error::from(io::ErrorKind::WouldBlock))
}

/// Blocks until child `pid` has exited, leaving it unreaped, so its process group id stays
/// reserved while the group is killed.
pub fn wait_exited_nowait(pid: i32) -> io::Result<()> {
    siginfo_pid(
        libc::WEXITED | libc::WNOWAIT,
        libc::P_PID,
        pid as libc::id_t,
    )
    .map(|_| ())
}

/// Reaps child `pid` if it has exited.
pub fn reap(pid: i32) {
    let mut status = 0;
    // SAFETY: waitpid(2) writes the status into a valid int; WNOHANG never blocks.
    unsafe {
        libc::waitpid(pid, &mut status, libc::WNOHANG);
    }
}

/// Makes orphaned descendants reparent to this process (as they would to PID 1), so the agent
/// reaps them even when it is not PID 1.
#[cfg(target_os = "linux")]
pub fn become_subreaper() -> io::Result<()> {
    // SAFETY: prctl(2) PR_SET_CHILD_SUBREAPER takes an integer flag and has no memory effects.
    let rc = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1 as libc::c_ulong, 0, 0, 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "linux"))]
pub fn become_subreaper() -> io::Result<()> {
    Ok(())
}

static TERMINATION_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = TERMINATION_FD.load(Ordering::SeqCst);
    // SAFETY: shutdown(2), tcsetattr(3) and _exit(2) are async-signal-safe. The saved termios
    // is written once before the handler can need it and never changes afterwards.
    unsafe {
        if fd >= 0 {
            libc::shutdown(fd, libc::SHUT_RDWR);
        }
        if let Some((tfd, t)) = SAVED_TERMIOS.get() {
            libc::tcsetattr(*tfd, libc::TCSANOW, t);
        }
        libc::_exit(128 + sig);
    }
}

/// On SIGTERM, SIGINT or SIGHUP: shut `socket_fd` down (so the far side sees the connection
/// drop at once), restore the terminal, and exit with 128 + the signal.
pub fn on_termination(socket_fd: RawFd) {
    TERMINATION_FD.store(socket_fd, Ordering::SeqCst);
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: a zeroed sigaction with an `extern "C" fn(c_int)` handler and an empty mask
        // is a valid argument; the handler only makes async-signal-safe calls.
        unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_signal as *const () as libc::sighandler_t;
            libc::sigemptyset(&mut sa.sa_mask);
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;

    #[test]
    fn pty_carries_slave_output_to_the_master() {
        let (mut master, slave) = openpty(Window { rows: 24, cols: 80 }).unwrap();
        let mut slave_file = File::from(slave);
        slave_file.write_all(b"hi\n").unwrap();
        let mut buf = [0u8; 16];
        let n = master.read(&mut buf).unwrap();
        assert!(buf[..n].starts_with(b"hi"), "{:?}", &buf[..n]);
    }

    #[test]
    fn window_size_round_trips() {
        let (master, slave) = openpty(Window { rows: 24, cols: 80 }).unwrap();
        assert_eq!(
            window_of(slave.as_raw_fd()),
            Some(Window { rows: 24, cols: 80 })
        );
        set_window(
            master.as_raw_fd(),
            Window {
                rows: 40,
                cols: 120,
            },
        )
        .unwrap();
        assert_eq!(
            window_of(slave.as_raw_fd()),
            Some(Window {
                rows: 40,
                cols: 120
            })
        );
        assert!(isatty(slave.as_raw_fd()));
    }

    #[test]
    fn a_pipe_is_not_a_terminal() {
        let file = File::open("/dev/null").unwrap();
        assert!(!isatty(file.as_raw_fd()));
        assert_eq!(window_of(file.as_raw_fd()), None);
        assert!(raw_mode(file.as_raw_fd()).is_none());
    }
}
