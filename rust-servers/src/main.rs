// Terminal Server Main Program
// Standalone terminal server that provides PTY functionality

mod router;
mod server;

// Feature modules
pub mod pty;

use server::{Server, ServerConfig};
use std::env;

const SERVER_VERSION: &str = match option_env!("TERMINAL_SERVER_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Logging macro
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] {}", format!($($arg)*));
        }
    };
}

#[derive(Debug, Clone, Copy)]
struct CliArgs {
    port: u16,
    parent_pid: Option<u32>,
}

/// Parse command-line arguments
fn parse_args() -> CliArgs {
    let args: Vec<String> = env::args().collect();
    let mut port: u16 = 0;
    let mut parent_pid: Option<u32> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-p" | "--port" => {
                if i + 1 < args.len() {
                    port = args[i + 1].parse().unwrap_or(0);
                    i += 1;
                }
            }
            arg if arg.starts_with("--port=") => {
                port = arg.trim_start_matches("--port=").parse().unwrap_or(0);
            }
            "--parent-pid" => {
                if i + 1 < args.len() {
                    parent_pid = args[i + 1].parse().ok();
                    i += 1;
                }
            }
            arg if arg.starts_with("--parent-pid=") => {
                parent_pid = arg.trim_start_matches("--parent-pid=").parse().ok();
            }
            "-h" | "--help" => {
                eprintln!("Usage: termy-server [OPTIONS]");
                eprintln!("Options:");
                eprintln!("  -p, --port <PORT>         监听端口 (0 表示随机端口) [默认: 0]");
                eprintln!(
                    "      --parent-pid <PID>    Obsidian/Electron 父进程 PID，用于孤儿进程清理"
                );
                eprintln!("  -h, --help                显示帮助信息");
                eprintln!("  -V, --version             显示版本信息");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("{}", SERVER_VERSION);
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    CliArgs { port, parent_pid }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse command-line arguments
    let args = parse_args();
    log_debug!(
        "启动参数: port={}, parent_pid={:?}",
        args.port,
        args.parent_pid
    );

    // Create the server configuration
    let config = ServerConfig {
        port: args.port,
        parent_pid: args.parent_pid,
    };

    // Create and start the server
    let server = Server::new(config);
    let port = server.start().await?;

    // Keep the main thread running
    log_info!("Terminal Server 已启动，监听端口: {}", port);

    // Wait for the Ctrl+C signal
    tokio::signal::ctrl_c().await?;
    log_info!("收到退出信号，正在关闭服务器...");

    Ok(())
}
