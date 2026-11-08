// ShellPilot Rust 后端入口（对应 server/index.js 的启动段）
use shellpilot_server::AppState;

fn env_port() -> u16 {
    std::env::var("SHELLPILOT_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3737)
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp" || a == "mcp") {
        shellpilot_server::run_mcp_cli();
        return;
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("server runtime").block_on(run_server());
}

async fn run_server() {

    // 数据目录：SHELLPILOT_DATA 优先，默认 ./data（与 Node 版一致）
    let data_dir = std::env::var("SHELLPILOT_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("data"));
    shellpilot_server::init_data_dir(data_dir);

    let port = env_port();
    let st = AppState::new();
    shellpilot_server::bootstrap(&st).await;

    let app = shellpilot_server::router(st);
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if std::env::var("SHELLPILOT_ELECTRON").as_deref() == Ok("1") {
                // 桌面模式：已有实例在跑，窗口直接连它即可
                std::env::set_var("SHELLPILOT_PORT_BUSY", "1");
                println!("  ⚠️ 端口 {} 已被占用——ShellPilot 多半已经在运行了。", port);
                return;
            }
            println!();
            println!("  ⚠️ 端口 {} 已被占用——ShellPilot 多半已经在运行了。", port);
            println!("  📍 直接使用: http://127.0.0.1:{}", port);
            open_browser(&format!("http://127.0.0.1:{}", port));
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("listen error: {e}");
            std::process::exit(1);
        }
    };
    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    shellpilot_server::save_json("runtime.json", &serde_json::json!({"port":actual_port,"token":uuid::Uuid::new_v4().to_string()}));

    println!();
    println!("  🚀 ShellPilot 已启动");
    println!("  📍 浏览器打开: http://127.0.0.1:{}", actual_port);
    println!("  🔒 只监听本机 (127.0.0.1)，外部无法访问");
    println!();
    if std::env::var("SHELLPILOT_OPEN").as_deref() == Ok("1") {
        open_browser(&format!("http://127.0.0.1:{}", actual_port));
    }

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .unwrap();
}
