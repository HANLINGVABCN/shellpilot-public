pub mod util; pub use util::*;
pub mod store; pub use store::*;
pub mod storage;
pub mod crypt; pub use crypt::*;
pub mod safety; pub use safety::*;
pub mod chats; pub use chats::*;
pub mod metrics; pub use metrics::*;
pub mod import; pub use import::*;
pub mod backup;
pub mod ai; pub use ai::*;
pub mod ssh; pub use ssh::*;
pub mod pool; pub use pool::*;
pub mod sessions; pub use sessions::*;
pub mod terminal_history;
pub mod probe; pub use probe::*;
pub mod approvals; pub use approvals::*;
pub mod judge; pub use judge::*;
pub mod agent; pub use agent::*;
pub mod chat_stats;
pub mod workspace;
pub mod routes; pub use routes::*;
pub mod ws; pub use ws::*;
pub mod mcp; pub use mcp::*;
pub mod operations;
pub mod memories;
pub mod jobs;
pub mod external;
pub mod tool_runtime;

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// 全局 AI Agent 的可变状态（对应 Node 的 agent 对象）
pub struct AgentState {
    pub messages: Vec<Value>,
    pub chat_id: Option<String>,
    pub busy: bool,
    pub approval_mode: String,
    pub reasoning_effort: String,
    pub scope: Vec<String>,
    pub allowed: HashSet<String>,
    pub cancel: Option<tokio::sync::watch::Sender<bool>>,
    pub paused: bool,
    pub pause_ready: bool,
    pub pause_signal: tokio::sync::watch::Sender<bool>,
    pub queue: std::collections::VecDeque<crate::jobs::Job>,
    pub active_job: Option<crate::jobs::Job>,
    pub worker_running: bool,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            chat_id: None,
            busy: false,
            approval_mode: "full".into(),
            reasoning_effort: "medium".into(),
            scope: Vec::new(),
            allowed: HashSet::new(),
            cancel: None,
            paused:false,pause_ready:false,pause_signal:tokio::sync::watch::channel(false).0,
            queue:std::collections::VecDeque::new(),active_job:None,worker_running:false,
        }
    }
}

pub const CHAT_KEY: &str = "__global__";

/// 文件管理 / 全局 AI 共用的专用 exec 连接（Node: execConns）
/// Handle 不可 Clone：用互斥锁独占；开通道在锁内完成，通道独立后即可并发执行
pub struct ExecConn {
    pub handle: Arc<Mutex<russh::client::Handle<crate::ssh::ClientHandler>>>,
}

impl ExecConn {
    pub fn new(handle: russh::client::Handle<crate::ssh::ClientHandler>) -> Self {
        Self { handle: Arc::new(Mutex::new(handle)) }
    }

    /// Node: conn._sock.destroyed/writable 检查的等价物
    pub async fn is_alive(&self) -> bool {
        !self.handle.lock().await.is_closed()
    }
}

pub struct AppState {
    pub workspace:crate::workspace::WorkspaceHub,
    pub folder_picker:std::sync::RwLock<Option<Arc<dyn Fn()->Result<Option<String>,String>+Send+Sync>>>,
    pub external_opener:std::sync::RwLock<Option<Arc<dyn Fn(&str)->Result<(),String>+Send+Sync>>>,
    pub tool_operations: std::sync::atomic::AtomicUsize,
    pub hosts: RwLock<Vec<Value>>,
    pub agent: Mutex<AgentState>,
    /// 全量事件广播（Node: broadcastAll → wss.clients）
    pub tx_all: tokio::sync::broadcast::Sender<String>,
    /// 终端会话表（Node: sessions Map）
    pub sessions: Mutex<HashMap<String, Arc<crate::sessions::TermSession>>>,
    /// 会话创建去重锁
    pub session_creating: Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
    /// exec 连接池 + 建连去重锁（Node: execConns / pendingExecConns）
    pub exec_conns: Mutex<HashMap<String, Arc<ExecConn>>>,
    pub exec_connecting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub probes: crate::probe::ProbeHub,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        let (tx_all, _) = tokio::sync::broadcast::channel(4096);
        Arc::new(Self {
            workspace:crate::workspace::WorkspaceHub::new(),
            folder_picker:std::sync::RwLock::new(None),
            external_opener:std::sync::RwLock::new(None),
            tool_operations:std::sync::atomic::AtomicUsize::new(0),
            hosts: RwLock::new(Vec::new()),
            agent: Mutex::new(AgentState::default()),
            tx_all,
            sessions: Mutex::new(HashMap::new()),
            session_creating: Mutex::new(HashMap::new()),
            exec_conns: Mutex::new(HashMap::new()),
            exec_connecting: Mutex::new(HashMap::new()),
            probes: crate::probe::ProbeHub::new(),
        })
    }

    /// Node: broadcastAll —— 发给所有已连接的页面
    pub fn broadcast_all(&self, msg: &Value) {
        let _ = self.tx_all.send(msg.to_string());
    }

    /// 把主机列表写回磁盘（Node: saveHosts）
    pub async fn save_hosts(&self) {
        let hosts = self.hosts.read().await;
        crate::save_json("hosts.json", &json_arr(&hosts));
        drop(hosts);
        self.notify_hosts_changed().await;
    }

    pub async fn notify_hosts_changed(&self) {
        let hosts=self.hosts.read().await;
        let mut agent=self.agent.lock().await;
        let scope=crate::operations::normalize_scope(&hosts,&agent.scope);
        let changed=scope!=agent.scope;
        agent.scope=scope.clone();
        drop(agent); drop(hosts);
        self.broadcast_all(&serde_json::json!({"type":"hosts-changed"}));
        if changed { self.broadcast_all(&serde_json::json!({"type":"agent-scope","hostIds":scope})); }
    }
}

/// 载入 hosts 并启动探针（bin 与 Tauri 壳共用）
pub async fn bootstrap(st: &Arc<AppState>) {
    if let Err(error)=crate::validate_storage(){crate::store::report_storage_error(error);return;}
    st.workspace.load().await;
    crate::workspace::linux_runtime::lifecycle(st);
    crate::jobs::restore(st).await;
    let hosts: Vec<Value> = load_json_or("hosts.json", serde_json::json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default();
    *st.hosts.write().await = hosts.clone();
    st.probes.sync(st, &hosts).await;
}

/// 桌面/移动壳用：绑定端口并启动服务。
/// 固定端口被占用时，若已有 ShellPilot 实例（/api/probe 可达）则复用该端口，否则退回随机端口。
pub async fn start_server(st: Arc<AppState>, port_hint: u16) -> Result<u16, String> {
    let app = crate::routes::router(st.clone());
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port_hint)).await {
        Ok(l) => l,
        Err(_) => {
            let probe_url = format!("http://127.0.0.1:{}/api/probe", port_hint);
            let reuse = reqwest::get(&probe_url)
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if reuse {
                return Ok(port_hint);
            }
            tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| e.to_string())?
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port_hint);
    crate::save_json("runtime.json", &serde_json::json!({"port":port,"token":uuid::Uuid::new_v4().to_string()}));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}

pub fn json_arr(items: &[Value]) -> Value {
    Value::Array(items.to_vec())
}
