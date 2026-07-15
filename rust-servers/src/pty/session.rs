// PTY session management

use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
use libproc::processes::{pids_by_type, ProcFilter};

/// PTY session
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

/// PTY reader (independent, no lock required)
pub struct PtyReader {
    reader: Box<dyn Read + Send>,
}

/// PTY writer (independent, no lock required)
pub struct PtyWriter {
    writer: Box<dyn Write + Send>,
}

impl PtySession {
    /// Create a new PTY session and return (session, reader, writer)
    /// 
    /// # Parameters
    /// - `cols`: Terminal column count
    /// - `rows`: Terminal row count
    /// - `shell_type`: Optional shell type (cmd, powershell, wsl, bash, zsh, tmux, custom:/path)
    /// - `shell_args`: Optional shell startup arguments
    /// - `cwd`: Optional working directory
    /// - `env`: Optional environment variables
    pub fn new(
        cols: u16, 
        rows: u16, 
        shell_type: Option<&str>,
        shell_args: Option<&[String]>,
        cwd: Option<&str>,
        env: Option<&std::collections::HashMap<String, String>>
    ) -> Result<(Self, PtyReader, PtyWriter), Box<dyn std::error::Error>> {
        // Get the PTY system
        let pty_system = native_pty_system();
        
        // Create the PTY pair
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        
        // Get the command for the requested shell type
        let mut cmd = super::shell::get_shell_by_type(shell_type);
        cmd.env_remove("NO_COLOR");
        
        // Add startup arguments
        if let Some(args) = shell_args {
            for arg in args {
                cmd.arg(arg);
            }
        }
        
        // Set the working directory
        if let Some(cwd_path) = cwd {
            cmd.cwd(cwd_path);
        }
        
        // Set environment variables
        // Ensure the TERM environment variable exists, otherwise commands like clear and vim will not work correctly
        let term_value = env
            .and_then(|e| e.get("TERM").cloned())
            .or_else(|| std::env::var("TERM").ok())
            .unwrap_or_else(|| "xterm-256color".to_string());
        cmd.env("TERM", term_value);
        
        // Set UTF-8 locale environment variables so non-ASCII characters display correctly
        // Priority: user-provided value > system environment variable > UTF-8 default value
        let locale_vars = ["LANG", "LC_ALL", "LC_CTYPE"];
        for var in &locale_vars {
            let value = env
                .and_then(|e| e.get(*var).cloned())
                .or_else(|| std::env::var(*var).ok())
                .unwrap_or_else(|| {
                    // Use en_US.UTF-8 by default on macOS/Linux to support UTF-8 encoding
                    "en_US.UTF-8".to_string()
                });
            cmd.env(*var, value);
        }
        
        // Set other custom environment variables
        if let Some(env_vars) = env {
            for (key, value) in env_vars {
                // Skip environment variables that were already handled
                if key != "TERM" && key != "NO_COLOR" && !locale_vars.contains(&key.as_str()) {
                    cmd.env(key, value);
                }
            }
        }
        // Start the shell process
        let child = pair.slave.spawn_command(cmd)?;
        
        // Get the reader and writer (independent, no lock required)
        let reader = PtyReader {
            reader: pair.master.try_clone_reader()?,
        };
        let writer = PtyWriter {
            writer: pair.master.take_writer()?,
        };
        
        let session = Self {
            master: pair.master,
            child: Arc::new(Mutex::new(child)),
        };
        
        Ok((session, reader, writer))
    }

    /// Resize the PTY
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Box<dyn std::error::Error>> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// PID of the PTY session leader spawned by portable-pty.
    pub fn process_id(&self) -> Option<u32> {
        self.child.lock().ok()?.process_id()
    }

    /// Terminate the child process and reap it to avoid a zombie.
    pub fn kill(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(session_pid) = self.process_id() {
            // portable-pty starts the shell with setsid(). Interactive programs such as
            // Codex create their own foreground process groups inside that session, so
            // killing only the shell can leave those descendants holding the PTY open.
            kill_process_session(session_pid);
        }

        if let Ok(mut child) = self.child.lock() {
            // 进程可能已自行退出，kill 失败可忽略；关键是随后 wait 回收僵尸。
            let _ = child.kill();
            // SIGKILL 后进程立即结束，wait 几乎立刻返回，回收 PID 避免 <defunct> 堆积。
            let _ = child.wait();
        }
        Ok(())
    }

    /// Reap an already-exited child (用于 read task 检测到 EOF、shell 自行退出时)。
    /// EOF 意味着进程已退出，wait 立即返回。
    pub fn reap(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
    }

    /// 返回 PTY master 的 raw fd（用于读前台进程组，方案 A）
    pub fn master_raw_fd(&self) -> Option<i32> {
        self.master.as_raw_fd()
    }
}

/// Force-kill every process attached to a portable-pty session.
///
/// The PTY shell is a session leader, while interactive children may move into
/// separate process groups. Matching by session ID therefore covers both the
/// shell and foreground/background groups without touching other terminals.
#[cfg(unix)]
pub(super) fn kill_process_session(session_pid: u32) -> usize {
    let Ok(mut pids) = pids_by_type(ProcFilter::All) else {
        return 0;
    };

    // Kill the session leader last. This keeps the session identity stable while
    // the remaining members are being selected and signalled.
    pids.sort_by_key(|pid| *pid == session_pid);

    let own_pid = std::process::id();
    let mut killed = 0;
    for pid in pids {
        if pid == 0 || pid == own_pid {
            continue;
        }

        let sid = unsafe { libc::getsid(pid as libc::pid_t) };
        if sid != session_pid as libc::pid_t {
            continue;
        }

        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } == 0 {
            killed += 1;
        }
    }
    killed
}

#[cfg(not(unix))]
pub(super) fn kill_process_session(_session_pid: u32) -> usize {
    0
}

impl PtyReader {
    /// Read data from the PTY
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, Box<dyn std::error::Error>> {
        let n = self.reader.read(buf)?;
        Ok(n)
    }
}

impl PtyWriter {
    /// Write data to the PTY
    pub fn write(&mut self, data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }
}

/// 读取 fd 对应 PTY 的前台进程组 + 进程名 + 完整命令行（macOS，内核级前台进程组）。
///
/// 返回 (pid, name, cmdline)：
/// - pid     = 前台进程组 ID；对普通交互 CLI 通常等于前台进程 PID
/// - name    = argv[0] 的 basename（如 claude、codex、node、tmux、ssh）
/// - cmdline = 完整命令行（前端据此区分 node 包装的 claude/codex —— argv[0] 是 node，
///   但 cmdline 里含 codex.js / claude 路径）
///
/// 用 KERN_PROCARGS2 读 argv，而非 libproc::pidpath（只拿可执行名，认不出 node 包装的 CLI，
/// 也认不出 claude.exe），更非 libproc::proc_pid::name（对 claude 进程会 FFI 层段错误）。
#[cfg(target_os = "macos")]
pub fn foreground_process(fd: i32) -> Option<(i32, String, String)> {
    let pgid = unsafe { libc::tcgetpgrp(fd) };
    if pgid <= 0 {
        return None;
    }
    let cmdline = fg_cmdline(pgid)?;
    let name = cmdline
        .split(' ')
        .next()
        .map(|arg0| arg0.rsplit('/').next().unwrap_or(arg0).to_string())
        .unwrap_or_default();
    Some((pgid, name, cmdline))
}

/// 读取进程完整命令行 argv（macOS KERN_PROCARGS2，ps 同款机制）。
/// 全程对缓冲区做 `idx < size` 边界检查，from_utf8_lossy 不 panic。
#[cfg(target_os = "macos")]
fn fg_cmdline(pid: i32) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    unsafe {
        if libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) != 0
            || size == 0
        {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
        if size < 4 {
            return None;
        }
        let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let mut idx = 4usize;
        while idx < size && buf[idx] != 0 {
            idx += 1;
        } // 跳过 exec path
        while idx < size && buf[idx] == 0 {
            idx += 1;
        } // 跳过填充 null
        let mut args = Vec::new();
        for _ in 0..argc {
            let start = idx;
            while idx < size && buf[idx] != 0 {
                idx += 1;
            }
            if start < idx {
                args.push(String::from_utf8_lossy(&buf[start..idx]).into_owned());
            }
            idx += 1;
            if idx >= size {
                break;
            }
        }
        Some(args.join(" "))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn foreground_process(_fd: i32) -> Option<(i32, String, String)> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::thread;
    use std::time::{Duration, Instant};

    fn process_exists(pid: u32) -> bool {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn session_members(session_pid: u32) -> Vec<u32> {
        pids_by_type(ProcFilter::All)
            .unwrap_or_default()
            .into_iter()
            .filter(
                |pid| unsafe { libc::getsid(*pid as libc::pid_t) } == session_pid as libc::pid_t,
            )
            .collect()
    }

    #[test]
    fn kill_terminates_all_process_groups_in_pty_session() {
        let args = vec![
            "-c".to_string(),
            "set -m; trap '' HUP TERM; sleep 30 & wait".to_string(),
        ];
        let (mut session, _reader, _writer) =
            PtySession::new(80, 24, Some("custom:/bin/sh"), Some(&args), None, None)
                .expect("spawn test PTY");
        let session_pid = session.process_id().expect("PTY child pid");

        let deadline = Instant::now() + Duration::from_secs(2);
        let (members, has_separate_group) = loop {
            let members = session_members(session_pid);
            let has_separate_group = members.iter().any(|pid| {
                *pid != session_pid
                    && unsafe { libc::getpgid(*pid as libc::pid_t) } != session_pid as libc::pid_t
            });
            if members.len() >= 2 && has_separate_group {
                break (members, true);
            }
            if Instant::now() >= deadline {
                break (members, has_separate_group);
            }
            thread::sleep(Duration::from_millis(20));
        };

        // Always clean up before asserting, so a failed test cannot leak its helper.
        session.kill().expect("kill PTY process session");

        assert!(
            members.len() >= 2,
            "expected shell plus a child process, got {members:?}"
        );
        assert!(
            has_separate_group,
            "expected a child in a separate foreground/background process group"
        );

        let exit_deadline = Instant::now() + Duration::from_secs(2);
        for pid in members {
            while process_exists(pid) && Instant::now() < exit_deadline {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !process_exists(pid),
                "PTY session member {pid} survived cleanup"
            );
        }
    }
}
