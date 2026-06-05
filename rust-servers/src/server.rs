// WebSocket server implementation
// WebSocket server for the terminal server that handles PTY module messages

use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use tokio::sync::Mutex as TokioMutex;

use crate::router::{MessageRouter, ModuleType, RouterError, ServerResponse};

/// Logging macro
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] {}", format!($($arg)*));
    };
}

macro_rules! log_error {
    ($($arg:tt)*) => {
        eprintln!("[ERROR] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] {}", format!($($arg)*));
        }
    };
}

// ============================================================================
// 自我了断：无活跃连接超时则退出，避免前端 reload 时残留旧 server
// ============================================================================

static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static LAST_ACTIVE_SECS: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 连接生命周期 RAII：进入 +1、离开 -1，并刷新最后活跃时间
struct ConnectionGuard;
impl ConnectionGuard {
    fn enter() -> Self {
        ACTIVE_CONNECTIONS.fetch_add(1, Ordering::SeqCst);
        LAST_ACTIVE_SECS.store(now_secs(), Ordering::SeqCst);
        ConnectionGuard
    }
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
        LAST_ACTIVE_SECS.store(now_secs(), Ordering::SeqCst);
    }
}

// ============================================================================
// Server configuration and implementation
// ============================================================================

/// WebSocket server configuration
pub struct ServerConfig {
    pub port: u16,
}

/// WebSocket server
pub struct Server {
    config: ServerConfig,
}

impl Server {
    pub fn new(config: ServerConfig) -> Self {
        Self { config }
    }

    /// Start the server
    pub async fn start(&self) -> Result<u16, Box<dyn std::error::Error>> {
        let addr = format!("127.0.0.1:{}", self.config.port);
        let listener = TcpListener::bind(&addr).await?;
        let local_addr = listener.local_addr()?;
        let port = local_addr.port();

        log_info!("服务器绑定到 {}", local_addr);

        // Write port information to stdout in JSON format
        // The TypeScript side parses this JSON to get the port number
        println!(
            r#"{{"port": {}, "pid": {}}}"#,
            port,
            std::process::id()
        );

        // 初始化最后活跃时间（启动后有宽限期等待前端首次连接）
        LAST_ACTIVE_SECS.store(now_secs(), Ordering::SeqCst);

        // 自我了断看门狗：无活跃连接持续超时则退出（彻底避免 reload 残留）
        tokio::spawn(async move {
            const IDLE_TIMEOUT_SECS: u64 = 30;
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                ticker.tick().await;
                let active = ACTIVE_CONNECTIONS.load(Ordering::SeqCst);
                let idle = now_secs().saturating_sub(LAST_ACTIVE_SECS.load(Ordering::SeqCst));
                if active == 0 && idle >= IDLE_TIMEOUT_SECS {
                    log_info!("无活跃 WebSocket 连接已 {}s，自我退出以避免残留", idle);
                    std::process::exit(0);
                }
            }
        });

        // Main loop: accept WebSocket connections
        tokio::spawn(async move {
            log_info!("正在监听 WebSocket 连接...");
            while let Ok((stream, addr)) = listener.accept().await {
                log_debug!("接受来自 {} 的连接", addr);
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream).await {
                        log_error!("连接处理错误: {}", e);
                    }
                });
            }
        });

        Ok(port)
    }
}

// ============================================================================
// Connection handling
// ============================================================================

/// WebSocket sender type alias
pub type WsSender = Arc<TokioMutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Message
>>>;

/// Handle a single WebSocket connection
async fn handle_connection(
    stream: tokio::net::TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Upgrade to WebSocket
    let ws_stream = accept_async(stream).await?;
    
    log_info!("WebSocket 连接已建立");

    // 连接计数（RAII：函数返回时自动 -1，供自我了断看门狗判断）
    let _conn_guard = ConnectionGuard::enter();

    // Split the read and write streams
    let (ws_sender, mut ws_receiver) = ws_stream.split();
    let ws_sender: WsSender = Arc::new(TokioMutex::new(ws_sender));
    
    // Create the message router
    let router = Arc::new(MessageRouter::new());
    
    // Set the WebSocket sender (used for PTY output)
    router.set_ws_sender(Arc::clone(&ws_sender)).await;
    
    // Message handling loop
    while let Some(msg_result) = ws_receiver.next().await {
        match msg_result {
            Ok(msg) => {
                log_debug!("收到消息类型: {:?}", std::mem::discriminant(&msg));
                
                match msg {
                    Message::Text(text) => {
                        // Handle text messages
                        if let Err(e) = handle_text_message(
                            &text,
                            &router,
                            &ws_sender
                        ).await {
                            log_error!("消息处理错误: {}", e);
                        }
                    }
                    Message::Binary(data) => {
                        // Binary data, written to the PTY
                        // Format: [session_id_length: u8][session_id: bytes][data: bytes]
                        log_debug!("收到二进制数据: {} 字节", data.len());
                        
                        if data.len() < 2 {
                            log_error!("二进制数据格式错误: 数据太短");
                            continue;
                        }
                        
                        let session_id_len = data[0] as usize;
                        if data.len() < 1 + session_id_len {
                            log_error!("二进制数据格式错误: session_id 长度不足");
                            continue;
                        }
                        
                        let session_id = match std::str::from_utf8(&data[1..1 + session_id_len]) {
                            Ok(s) => s,
                            Err(e) => {
                                log_error!("二进制数据格式错误: session_id 不是有效 UTF-8: {}", e);
                                continue;
                            }
                        };
                        
                        let pty_data = &data[1 + session_id_len..];
                        log_debug!("写入 PTY: session_id={}, {} 字节", session_id, pty_data.len());
                        
                        if let Err(e) = router.pty_handler().write_data(session_id, pty_data).await {
                            log_error!("写入 PTY 失败: session_id={}, {}", session_id, e);
                        }
                    }
                    Message::Close(_) => {
                        log_info!("客户端关闭连接");
                        break;
                    }
                    Message::Ping(data) => {
                        // Reply to Ping
                        let mut sender = ws_sender.lock().await;
                        sender.send(Message::Pong(data)).await?;
                    }
                    Message::Pong(_) => {
                        // Ignore Pong
                    }
                    _ => {
                        log_debug!("忽略的消息类型");
                    }
                }
            }
            Err(e) => {
                log_error!("消息接收错误: {}", e);
                break;
            }
        }
    }
    
    log_info!("WebSocket 连接已关闭");
    
    // Clean up all PTY sessions
    router.pty_handler().cleanup_all().await;
    
    Ok(())
}

/// Handle a text message
async fn handle_text_message(
    text: &str,
    router: &Arc<MessageRouter>,
    ws_sender: &WsSender,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Parse the message
    match router.parse_message(text) {
        Ok(msg) => {
            let module = msg.module;
            
            // Route the message to the matching module
            match router.route(msg).await {
                Ok(Some(response)) => {
                    // Send the response
                    send_response(ws_sender, &response).await?;
                }
                Ok(None) => {
                    // The module handled the message successfully and no response is needed
                    log_debug!("模块处理完成，无响应");
                }
                Err(e) => {
                    // Module handling failed, so send an error response
                    log_error!("模块处理错误: {}", e);
                    let error_response = router.create_error_response(module, &e);
                    send_response(ws_sender, &error_response).await?;
                }
            }
        }
        Err(e) => {
            // Message parsing failed
            log_error!("消息解析错误: {}", e);
            
            // Try to extract the module field from the raw JSON for the error response
            let module = extract_module_from_json(text);
            let error_response = create_parse_error_response(module, &e);
            send_response(ws_sender, &error_response).await?;
        }
    }
    
    Ok(())
}

/// Extract the module field from JSON
fn extract_module_from_json(text: &str) -> ModuleType {
    // Try to parse the JSON and extract the module field
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(module_str) = value.get("module").and_then(|v| v.as_str()) {
            if module_str == "pty" {
                return ModuleType::Pty;
            }
        }
    }
    
    // Default to the Pty module
    ModuleType::Pty
}

/// Create a parse error response
fn create_parse_error_response(module: ModuleType, error: &RouterError) -> ServerResponse {
    ServerResponse::error(
        module,
        "PARSE_ERROR",
        &format!("消息解析失败: {}", error)
    )
}

/// Send a response message
pub async fn send_response(
    ws_sender: &WsSender,
    response: &ServerResponse,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let json = serde_json::to_string(response)?;
    let mut sender = ws_sender.lock().await;
    sender.send(Message::Text(json.into())).await?;
    Ok(())
}

/// Send a raw JSON message
#[allow(dead_code)]
pub async fn send_json(
    ws_sender: &WsSender,
    json: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut sender = ws_sender.lock().await;
    sender.send(Message::Text(json.to_string().into())).await?;
    Ok(())
}

/// Send a binary message
#[allow(dead_code)]
pub async fn send_binary(
    ws_sender: &WsSender,
    data: Vec<u8>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut sender = ws_sender.lock().await;
    sender.send(Message::Binary(data.into())).await?;
    Ok(())
}
