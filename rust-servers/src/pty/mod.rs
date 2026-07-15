// PTY module
// Provides terminal session management

mod osc_scanner;
mod session;
mod shell;

use session::kill_process_session;
pub use session::{PtyReader, PtySession, PtyWriter};
pub use shell::{get_default_shell, get_shell_by_type};

use crate::pty::osc_scanner::{OscEvent, OscScanner};
use crate::router::{ModuleHandler, ModuleMessage, ModuleType, RouterError, ServerResponse};
use crate::server::WsSender;
use futures_util::SinkExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use tokio::time::{self, Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

type SharedWsSender = Arc<TokioMutex<Option<WsSender>>>;

/// Logging macros
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] [PTY] {}", format!($($arg)*));
    };
}

macro_rules! log_error {
    ($($arg:tt)*) => {
        eprintln!("[ERROR] [PTY] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] [PTY] {}", format!($($arg)*));
        }
    };
}

async fn send_to_current_ws(ws_sender: &SharedWsSender, message: Message) -> Result<bool, String> {
    let current_sender = {
        let ws_sender = ws_sender.lock().await;
        ws_sender.clone()
    };

    let Some(current_sender) = current_sender else {
        return Ok(false);
    };

    let send_result = {
        let mut sender = current_sender.lock().await;
        sender.send(message).await
    };

    if let Err(error) = send_result {
        let mut ws_sender = ws_sender.lock().await;
        if ws_sender
            .as_ref()
            .map(|candidate| Arc::ptr_eq(candidate, &current_sender))
            .unwrap_or(false)
        {
            *ws_sender = None;
        }
        return Err(error.to_string());
    }

    Ok(true)
}

// ============================================================================
// PTY session context
// ============================================================================

/// Context for a single PTY session
///
/// Contains all resources required for one PTY session
struct PtySessionContext {
    /// PTY session
    session: Arc<TokioMutex<PtySession>>,
    /// PTY writer
    writer: Arc<Mutex<PtyWriter>>,
    /// Read task handle
    read_task: Option<tokio::task::JoinHandle<()>>,
    /// PID of the shell/session leader, retained for lock-free emergency cleanup.
    process_id: Option<u32>,
}

impl PtySessionContext {
    /// Create a new session context
    fn new(
        session: Arc<TokioMutex<PtySession>>,
        writer: Arc<Mutex<PtyWriter>>,
        process_id: Option<u32>,
    ) -> Self {
        Self {
            session,
            writer,
            read_task: None,
            process_id,
        }
    }
}

// ============================================================================
// PTY handler
// ============================================================================

/// PTY module handler
///
/// Manages the lifecycle of multiple PTY sessions and handles terminal-related messages
pub struct PtyHandler {
    /// Session registry: session_id -> PtySessionContext
    sessions: TokioMutex<HashMap<String, PtySessionContext>>,
    /// WebSocket sender (used to send PTY output)
    ws_sender: SharedWsSender,
}

impl PtyHandler {
    /// Create a new PTY handler
    pub fn new() -> Self {
        Self {
            sessions: TokioMutex::new(HashMap::new()),
            ws_sender: Arc::new(TokioMutex::new(None)),
        }
    }

    /// Set the WebSocket sender
    pub async fn set_ws_sender(&self, sender: WsSender) {
        let mut ws_sender = self.ws_sender.lock().await;
        *ws_sender = Some(sender);
    }

    /// Clear the WebSocket sender if it still points to the closing connection.
    pub async fn clear_ws_sender_if_current(&self, sender: &WsSender) {
        let mut ws_sender = self.ws_sender.lock().await;
        if ws_sender
            .as_ref()
            .map(|current| Arc::ptr_eq(current, sender))
            .unwrap_or(false)
        {
            *ws_sender = None;
        }
    }

    /// Handle the init message and create a PTY session
    async fn handle_init(
        &self,
        shell_type: Option<String>,
        shell_args: Option<Vec<String>>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Option<ServerResponse>, RouterError> {
        // Generate a unique session_id
        let session_id = Uuid::new_v4().to_string();
        let cols = cols.filter(|value| *value > 0).unwrap_or(80);
        let rows = rows.filter(|value| *value > 0).unwrap_or(24);

        log_info!(
            "初始化 PTY 会话: session_id={}, shell_type={:?}, cwd={:?}, size={}x{}",
            session_id,
            shell_type,
            cwd,
            cols,
            rows
        );

        // Create the PTY session
        let (pty_session, pty_reader, pty_writer) = PtySession::new(
            cols,
            rows,
            shell_type.as_deref(),
            shell_args.as_ref().map(|v| v.as_slice()),
            cwd.as_deref(),
            env.as_ref(),
        )
        .map_err(|e| RouterError::ModuleError(format!("创建 PTY 会话失败: {}", e)))?;

        // 提取 master fd（用于前台进程检测，方案 A；fd 在 session 存活期间有效）
        let master_fd = pty_session.master_raw_fd();
        let process_id = pty_session.process_id();

        // Create the session context
        let pty_session = Arc::new(TokioMutex::new(pty_session));
        let pty_reader = Arc::new(Mutex::new(pty_reader));
        let pty_writer = Arc::new(Mutex::new(pty_writer));

        let mut context = PtySessionContext::new(
            Arc::clone(&pty_session),
            Arc::clone(&pty_writer),
            process_id,
        );

        // Start the PTY output reader task
        // 传入 session 的 Arc 克隆：read task 持有它，保证 master fd 在前台进程轮询期间
        // 始终有效（避免 fd 被关闭/复用），并在 EOF 时用它回收子进程。
        let read_task = self
            .start_read_task(
                session_id.clone(),
                pty_reader,
                pty_writer,
                shell_type,
                master_fd,
                Arc::clone(&pty_session),
            )
            .await?;
        context.read_task = Some(read_task);

        // Store the session context
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.clone(), context);
        }

        log_info!("PTY 会话创建成功: session_id={}", session_id);

        // Return a success response that includes the session_id
        Ok(Some(ServerResponse::new(
            ModuleType::Pty,
            "init_complete",
            serde_json::json!({
                "success": true,
                "session_id": session_id
            }),
        )))
    }

    /// Start the PTY output reader task
    ///
    /// Returns the task handle, which the caller stores
    async fn start_read_task(
        &self,
        session_id: String,
        reader: Arc<Mutex<PtyReader>>,
        _writer: Arc<Mutex<PtyWriter>>,
        _shell_type: Option<String>,
        master_fd: Option<i32>,
        session: Arc<TokioMutex<PtySession>>,
    ) -> Result<tokio::task::JoinHandle<()>, RouterError> {
        const OUTPUT_BATCH_INTERVAL_MS: u64 = 4;
        const READ_BUFFER_SIZE: usize = 8192;
        let ws_sender = Arc::clone(&self.ws_sender);

        // Start the reader task
        let task = tokio::spawn(async move {
            // session 在整个任务期间持有：保证 master_fd 在前台进程轮询时始终有效
            // （PtySession 未被 drop → master 不会被关闭/复用），并用于 EOF 回收子进程。
            let session = session;

            enum ReadEvent {
                Data(Vec<u8>),
                Eof,
                Error(String),
            }

            let (read_tx, mut read_rx) = tokio::sync::mpsc::channel::<ReadEvent>(32);
            let reader_for_thread = Arc::clone(&reader);

            tokio::task::spawn_blocking(move || loop {
                let mut reader = match reader_for_thread.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                let mut local_buf = vec![0u8; READ_BUFFER_SIZE];
                match reader.read(&mut local_buf) {
                    Ok(0) => {
                        let _ = read_tx.blocking_send(ReadEvent::Eof);
                        break;
                    }
                    Ok(n) => {
                        local_buf.truncate(n);
                        if read_tx.blocking_send(ReadEvent::Data(local_buf)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = read_tx.blocking_send(ReadEvent::Error(e.to_string()));
                        break;
                    }
                }
            });

            let mut batch_buffer: Vec<u8> = Vec::new();
            let mut osc_scanner = OscScanner::new();
            let mut pending_shell_events: Vec<OscEvent> = Vec::new();

            let mut last_fg: Option<(i32, String, String)> = None;
            const FG_POLL_MS: u64 = 1000;

            loop {
                // 带超时地等输出；超时则仅做前台进程轮询（无输出时也能检测）
                let maybe_event =
                    match time::timeout(Duration::from_millis(FG_POLL_MS), read_rx.recv()).await {
                        Ok(Some(event)) => Some(event),
                        Ok(None) => break,
                        Err(_) => None,
                    };

                // 前台进程检测：变化则上报前端（tmux/ssh/claude/codex…）
                if let Some(fd) = master_fd {
                    let current = session::foreground_process(fd);
                    if current != last_fg {
                        last_fg = current.clone();
                        let (pid, name, cmdline) = current.clone().unwrap_or_default();
                        let fg_payload = serde_json::json!({
                            "session_id": session_id,
                            "pid": pid,
                            "name": name,
                            "cmdline": cmdline,
                        });
                        let response =
                            ServerResponse::new(ModuleType::Pty, "foreground", fg_payload);
                        if let Err(e) =
                            send_to_current_ws(&ws_sender, Message::Text(response.to_json().into()))
                                .await
                        {
                            log_error!("发送 foreground 失败: session_id={}, {}", session_id, e);
                        }
                    }
                }

                let first_event = match maybe_event {
                    Some(event) => event,
                    None => continue,
                };

                let mut pending_exit = false;
                let mut pending_error: Option<String> = None;

                match first_event {
                    ReadEvent::Data(data) => {
                        pending_shell_events.extend(osc_scanner.scan(&data));
                        batch_buffer.extend_from_slice(&data);
                    }
                    ReadEvent::Eof => pending_exit = true,
                    ReadEvent::Error(e) => pending_error = Some(e),
                }

                if pending_error.is_none() && !pending_exit {
                    let deadline = Instant::now() + Duration::from_millis(OUTPUT_BATCH_INTERVAL_MS);
                    loop {
                        match time::timeout_at(deadline, read_rx.recv()).await {
                            Ok(Some(ReadEvent::Data(data))) => {
                                pending_shell_events.extend(osc_scanner.scan(&data));
                                batch_buffer.extend_from_slice(&data);
                            }
                            Ok(Some(ReadEvent::Eof)) => {
                                pending_exit = true;
                                break;
                            }
                            Ok(Some(ReadEvent::Error(e))) => {
                                pending_error = Some(e);
                                break;
                            }
                            Ok(None) => {
                                break;
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }
                }

                if !batch_buffer.is_empty() {
                    log_debug!(
                        "读取 PTY 输出(批处理): session_id={}, {} 字节",
                        session_id,
                        batch_buffer.len()
                    );

                    // Build a binary frame prefixed with the session_id
                    // Format: [session_id_length: u8][session_id: bytes][data: bytes]
                    let session_id_bytes = session_id.as_bytes();
                    let session_id_len = session_id_bytes.len() as u8;

                    let mut frame =
                        Vec::with_capacity(1 + session_id_bytes.len() + batch_buffer.len());
                    frame.push(session_id_len);
                    frame.extend_from_slice(session_id_bytes);
                    frame.extend_from_slice(&batch_buffer);

                    if let Err(e) =
                        send_to_current_ws(&ws_sender, Message::Binary(frame.into())).await
                    {
                        log_error!("发送 PTY 输出失败: session_id={}, {}", session_id, e);
                    }
                }

                if !pending_shell_events.is_empty() {
                    for event in pending_shell_events.drain(..) {
                        let event_payload = serde_json::json!({
                            "session_id": session_id,
                            "event": event.event_name(),
                            "source": event.source_name(),
                            "exit_code": event.exit_code(),
                        });
                        let response =
                            ServerResponse::new(ModuleType::Pty, "shell_event", event_payload);
                        if let Err(e) =
                            send_to_current_ws(&ws_sender, Message::Text(response.to_json().into()))
                                .await
                        {
                            log_error!("发送 shell_event 失败: session_id={}, {}", session_id, e);
                        }
                    }
                }

                batch_buffer.clear();

                if let Some(e) = pending_error {
                    log_error!("PTY 输出读取错误: session_id={}, {}", session_id, e);
                    break;
                }

                if pending_exit {
                    // EOF: the process has exited
                    log_info!("PTY 输出结束: session_id={}", session_id);

                    // shell 自行退出（敲 exit / 进程结束）时前端不会发 destroy，
                    // 在此主动回收子进程，避免 <defunct> 僵尸堆积。EOF 说明进程已退出，
                    // reap 内部的 wait 立即返回，不会阻塞。
                    session.lock().await.reap();

                    // Send the exit event
                    let exit_response = ServerResponse::new(
                        ModuleType::Pty,
                        "exit",
                        serde_json::json!({
                            "session_id": session_id,
                            "code": 0
                        }),
                    );
                    if let Err(e) = send_to_current_ws(
                        &ws_sender,
                        Message::Text(exit_response.to_json().into()),
                    )
                    .await
                    {
                        log_error!("发送 exit 事件失败: session_id={}, {}", session_id, e);
                    }
                    break;
                }
            }
        });

        Ok(task)
    }

    /// Handle the resize message and resize the terminal
    async fn handle_resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Option<ServerResponse>, RouterError> {
        log_info!("调整终端尺寸: session_id={}, {}x{}", session_id, cols, rows);

        let sessions = self.sessions.lock().await;
        let context = sessions.get(session_id).ok_or_else(|| {
            RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id))
        })?;

        let mut pty = context.session.lock().await;
        pty.resize(cols, rows)
            .map_err(|e| RouterError::ModuleError(format!("调整终端尺寸失败: {}", e)))?;

        Ok(None) // resize does not require a response
    }

    /// Attach the current WebSocket connection to an existing PTY session.
    async fn handle_attach(&self, session_id: &str) -> Result<Option<ServerResponse>, RouterError> {
        let exists = {
            let sessions = self.sessions.lock().await;
            sessions.contains_key(session_id)
        };

        log_info!(
            "恢复 PTY 会话: session_id={}, exists={}",
            session_id,
            exists
        );

        Ok(Some(ServerResponse::new(
            ModuleType::Pty,
            "attach_complete",
            serde_json::json!({
                "success": exists,
                "session_id": session_id
            }),
        )))
    }

    /// Write data to the PTY for the specified session
    pub async fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), RouterError> {
        let sessions = self.sessions.lock().await;
        let context = sessions.get(session_id).ok_or_else(|| {
            RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id))
        })?;

        let mut w = context.writer.lock().unwrap();
        w.write(data)
            .map_err(|e| RouterError::ModuleError(format!("写入 PTY 失败: {}", e)))?;

        Ok(())
    }

    /// Destroy the specified session
    pub async fn handle_destroy(&self, session_id: &str) -> Result<(), RouterError> {
        log_info!("销毁 PTY 会话: session_id={}", session_id);

        let context = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
        };

        if let Some(context) = context {
            Self::cleanup_session(session_id, context).await;
            log_info!("PTY 会话已销毁: session_id={}", session_id);
            Ok(())
        } else {
            Err(RouterError::ModuleError(format!(
                "SESSION_NOT_FOUND: {}",
                session_id
            )))
        }
    }

    /// Clean up all sessions (called when the connection closes)
    pub async fn cleanup_all(&self) {
        log_info!("清理所有 PTY 会话");

        const REGISTRY_LOCK_TIMEOUT: Duration = Duration::from_secs(1);
        let contexts = match time::timeout(REGISTRY_LOCK_TIMEOUT, self.sessions.lock()).await {
            Ok(mut sessions) => sessions.drain().collect::<Vec<_>>(),
            Err(_) => {
                log_error!("清理 PTY 会话超时: 无法获取会话表锁");
                return;
            }
        };

        for (session_id, context) in contexts {
            Self::cleanup_session(&session_id, context).await;
        }

        log_info!("所有 PTY 会话已清理");
    }

    async fn cleanup_session(session_id: &str, mut context: PtySessionContext) {
        const SESSION_LOCK_TIMEOUT: Duration = Duration::from_secs(1);
        const READER_TASK_TIMEOUT: Duration = Duration::from_secs(2);

        log_info!("清理会话: {}", session_id);

        // Kill by session ID before taking the Tokio mutex. This remains effective
        // even if a reader/resize path is holding the session lock.
        if let Some(process_id) = context.process_id {
            let killed = kill_process_session(process_id);
            log_debug!(
                "已终止 PTY 进程会话: session_id={}, leader_pid={}, process_count={}",
                session_id,
                process_id,
                killed
            );
        }

        match time::timeout(SESSION_LOCK_TIMEOUT, context.session.lock()).await {
            Ok(mut session) => {
                let _ = session.kill();
            }
            Err(_) => {
                log_error!(
                    "回收 PTY 子进程超时: session_id={} (process tree already signalled)",
                    session_id
                );
            }
        }

        // Close the writer before waiting so the reader can observe PTY shutdown.
        drop(context.writer);

        if let Some(mut task) = context.read_task.take() {
            if time::timeout(READER_TASK_TIMEOUT, &mut task).await.is_err() {
                log_error!("读取任务退出超时，强制取消: session_id={}", session_id);
                task.abort();
            }
        }
    }

    /// Check whether any sessions are active
    pub async fn has_sessions(&self) -> bool {
        let sessions = self.sessions.lock().await;
        !sessions.is_empty()
    }
}

impl Default for PtyHandler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ModuleHandler for PtyHandler {
    fn module_type(&self) -> ModuleType {
        ModuleType::Pty
    }

    async fn handle(&self, msg: &ModuleMessage) -> Result<Option<ServerResponse>, RouterError> {
        log_debug!("处理 PTY 消息: {}", msg.msg_type);

        match msg.msg_type.as_str() {
            "init" => {
                let shell_type: Option<String> = msg.get_field("shell_type");
                let shell_args: Option<Vec<String>> = msg.get_field("shell_args");
                let cwd: Option<String> = msg.get_field("cwd");
                let env: Option<HashMap<String, String>> = msg.get_field("env");
                let cols: Option<u16> = msg.get_field("cols");
                let rows: Option<u16> = msg.get_field("rows");

                self.handle_init(shell_type, shell_args, cwd, env, cols, rows)
                    .await
            }
            "resize" => {
                // resize requires a session_id
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id
                    .ok_or_else(|| RouterError::ModuleError("SESSION_ID_REQUIRED".to_string()))?;

                let cols: u16 = msg.get_field("cols").unwrap_or(80);
                let rows: u16 = msg.get_field("rows").unwrap_or(24);

                self.handle_resize(&session_id, cols, rows).await
            }
            "attach" => {
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id
                    .ok_or_else(|| RouterError::ModuleError("SESSION_ID_REQUIRED".to_string()))?;

                self.handle_attach(&session_id).await
            }
            "destroy" => {
                // destroy requires a session_id
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id
                    .ok_or_else(|| RouterError::ModuleError("SESSION_ID_REQUIRED".to_string()))?;

                self.handle_destroy(&session_id).await?;
                Ok(None)
            }
            "env" => {
                // In the original implementation, the env command only logged data; actual environment variables are set during init
                let cwd: Option<String> = msg.get_field("cwd");
                let env: Option<HashMap<String, String>> = msg.get_field("env");
                log_info!("收到 env 命令: cwd={:?}, env={:?}", cwd, env);
                Ok(None)
            }
            _ => {
                log_debug!("未知的 PTY 消息类型: {}", msg.msg_type);
                Err(RouterError::ModuleError(format!(
                    "未知的 PTY 消息类型: {}",
                    msg.msg_type
                )))
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn cleanup_all_is_bounded_with_a_live_child_process() {
        let handler = PtyHandler::new();
        let shell_args = vec![
            "-c".to_string(),
            "set -m; trap '' HUP TERM; sleep 30 & wait".to_string(),
        ];

        handler
            .handle_init(
                Some("custom:/bin/sh".to_string()),
                Some(shell_args),
                None,
                None,
                Some(80),
                Some(24),
            )
            .await
            .expect("create PTY session");

        let process_id = {
            let sessions = handler.sessions.lock().await;
            sessions
                .values()
                .next()
                .and_then(|context| context.process_id)
                .expect("PTY process id")
        };

        time::timeout(Duration::from_secs(4), handler.cleanup_all())
            .await
            .expect("cleanup_all must not wait forever for the PTY reader");

        assert!(!handler.has_sessions().await);
        assert_ne!(unsafe { libc::kill(process_id as libc::pid_t, 0) }, 0);
    }
}
