// SSH 层：russh 客户端封装（对应 server/ssh.js）
// 提供：连接（含跳板机 forwardOut 链）、exec（stderr 并入 stdout 语义）、exec_stdin、PTY shell
use crate::util::shq;
use russh::client::{self, Handle};
use russh::{Channel, ChannelMsg, Disconnect};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

pub const READY_TIMEOUT: Duration = Duration::from_secs(15);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: u32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u64,
}

pub async fn exec_bounded(
    channel: &mut Channel<russh::client::Msg>, cmd: &str, timeout_ms: u64, limit: usize,
) -> Result<ExecResult, String> {
    let started = std::time::Instant::now();
    let limit = limit.clamp(1024, crate::operations::OUTPUT_LIMIT);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut exit_code = None;
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        channel.exec(true, cmd).await.map_err(|e| e.to_string())?;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                    let is_stderr = matches!(msg, ChannelMsg::ExtendedData { .. });
                    let target = if is_stderr { &mut stderr } else { &mut stdout };
                    let n = data.len().min(limit.saturating_sub(target.len()));
                    target.extend_from_slice(&data[..n]);
                    truncated |= n < data.len();
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::ExitSignal { signal_name, .. } => return Err(format!("命令被信号 {signal_name:?} 中止")),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<(), String>(())
    }).await;
    if result.is_err() {
        let _ = channel.close().await;
        return Err(format!("命令执行超过 {} 秒，通道已关闭；远程进程是否结束需再次检查", timeout_ms / 1000));
    }
    result.unwrap()?;
    let exit_code = exit_code.ok_or("SSH 连接中断，未收到退出状态")?;
    Ok(ExecResult { exit_code, stdout: String::from_utf8_lossy(&stdout).into(),
        stderr: String::from_utf8_lossy(&stderr).into(), truncated,
        duration_ms: started.elapsed().as_millis() as u64 })
}

#[derive(Debug, Clone, PartialEq)]
pub enum ErrKind {
    CommandFailed,
    Timeout,
    Interrupted,
    Other,
}

#[derive(Debug)]
pub struct SshError {
    pub message: String,
    pub kind: ErrKind,
    pub host_key: Option<Value>,
}

impl SshError {
    pub fn new(message: impl Into<String>, kind: ErrKind) -> Self {
        Self { message: message.into(), kind, host_key: None }
    }
    fn host_identity(record:Value)->Self {
        let changed=record["changed"].as_bool().unwrap_or(false);
        let name=record["name"].as_str().or_else(||record["host"].as_str()).unwrap_or("服务器");
        Self {message:format!("{}：{name}。请在当前页面的服务器身份提示中处理后连接",if changed {"服务器身份已变化，连接已暂停"} else {"首次连接，等待确认服务器身份"}),kind:ErrKind::Other,host_key:Some(record)}
    }
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SshError {}

/// Node: normalizeErr
pub fn normalize_connect_err(e: &russh::Error) -> SshError {
    let m = e.to_string();
    let lower = m.to_lowercase();
    if lower.contains("unknownkey") || lower.contains("unknown key") || lower.contains("unknown server key") {
        return SshError::new("SSH 服务器指纹尚未信任或已变化，请到设置中的「SSH 服务器指纹」核对确认",ErrKind::Other);
    }
    if lower.contains("authentication failed") || lower.contains("auth") && lower.contains("fail") {
        SshError::new("认证失败：用户名、密码或密钥不正确", ErrKind::Other)
    } else if ["timed out", "timeout", "connection refused", "failed to lookup", "name or service not known", "network is unreachable", "no route to host", "host unreachable"]
        .iter()
        .any(|k| lower.contains(k))
    {
        SshError::new("连接失败：请检查 IP、端口、防火墙与网络", ErrKind::Other)
    } else {
        SshError::new(m, ErrKind::Other)
    }
}

static HOST_KEYS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct ClientHandler { cfg: Value, identity_error: Arc<std::sync::Mutex<Option<Value>>> }
impl ClientHandler {
    fn new(cfg: &Value,identity_error:Arc<std::sync::Mutex<Option<Value>>>)->Self { Self { cfg:cfg.clone(),identity_error } }
}

pub fn trust_host_key(host_id:&str,fingerprint:&str)->Result<(),String> {
    let _guard=HOST_KEYS_LOCK.lock().map_err(|_|"主机指纹存储不可用")?;
    let mut observed=crate::load_json_or("observed-host-keys.json",serde_json::json!({}));
    let record=observed.as_object().and_then(|m|m.values().find(|v|v["hostId"].as_str()==Some(host_id) && v["fingerprint"].as_str()==Some(fingerprint))).cloned().ok_or("指纹已变化或尚未观察到，请刷新后确认")?;
    let key=record["key"].as_str().ok_or("无效的主机指纹")?;
    let mut trusted=crate::load_json_or("trusted-host-keys.json",serde_json::json!({}));
    trusted[key]=serde_json::json!(fingerprint);
    crate::save_json("trusted-host-keys.json",&trusted);
    observed.as_object_mut().map(|m|m.remove(key));
    crate::save_json("observed-host-keys.json",&observed);
    Ok(())
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint=server_public_key.fingerprint();
        let host=self.cfg["host"].as_str().unwrap_or("");
        let port=self.cfg["port"].as_u64().unwrap_or(22);
        let key=format!("{host}:{port}");
        let _guard=HOST_KEYS_LOCK.lock().unwrap();
        let mut trusted=crate::load_json_or("trusted-host-keys.json",serde_json::json!({}));
        if trusted[&key].as_str()==Some(fingerprint.as_str()) { return Ok(true); }
        let mut observed=crate::load_json_or("observed-host-keys.json",serde_json::json!({}));
        if trusted.get(&key).is_none() {
            // First use: pin the identity before authentication, no user interaction.
            // Subsequent changes are never accepted automatically.
            trusted[&key]=serde_json::json!(fingerprint);
            let text=serde_json::to_string_pretty(&trusted).unwrap();
            if let Err(error)=std::fs::write(crate::data_dir().join("trusted-host-keys.json"),text) {
                let record=serde_json::json!({"key":key,"hostId":self.cfg["id"],"name":self.cfg["name"],"host":host,"port":port,
                    "fingerprint":fingerprint,"changed":false,"storageError":format!("无法保存服务器身份：{error}")});
                *self.identity_error.lock().unwrap()=Some(record);
                return Ok(false);
            }
            observed.as_object_mut().map(|records|records.remove(&key));
            crate::save_json("observed-host-keys.json",&observed);
            crate::append_audit(serde_json::json!({"ts":crate::now_ms(),"action":"ssh-first-use","hostId":self.cfg["id"],"host":host,"port":port,"fingerprint":fingerprint}));
            return Ok(true);
        }
        let record=serde_json::json!({"key":key,"hostId":self.cfg["id"],"name":self.cfg["name"],"host":host,"port":port,
            "fingerprint":fingerprint,"previous":trusted[&key],"changed":trusted.get(&key).is_some()});
        *self.identity_error.lock().unwrap()=Some(record.clone());
        observed[&key]=record;
        crate::save_json("observed-host-keys.json",&observed);
        Ok(false)
    }
}

fn client_config() -> Arc<client::Config> {
    let mut config = client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(10));
    config.keepalive_max = 3;
    Arc::new(config)
}

/// 单机连接（不含跳板机逻辑）
async fn connect_direct(cfg: &Value) -> Result<Handle<ClientHandler>, SshError> {
    let host = cfg.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let port = cfg.get("port").and_then(|v| v.as_i64()).unwrap_or(22) as u16;
    let username = cfg.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let auth_type = cfg.get("authType").and_then(|v| v.as_str()).unwrap_or("password");

    // 先在连接前解析凭据（Node: buildClientConfig 同步抛错）
    enum Auth {
        Password(String),
        Key(Arc<russh::keys::key::KeyPair>),
    }
    let auth = match auth_type {
        "key" => {
            let key_content = cfg.get("keyContent").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let key_path = cfg.get("keyPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let pem = if !key_content.is_empty() {
                key_content
            } else if !key_path.is_empty() {
                std::fs::read_to_string(&key_path)
                    .map_err(|e| SshError::new(format!("读取私钥失败: {e}"), ErrKind::Other))?
            } else {
                return Err(SshError::new("未提供私钥：请填写私钥文件路径或粘贴私钥内容", ErrKind::Other));
            };
            let passphrase = cfg.get("passphrase").and_then(|v| v.as_str()).unwrap_or("");
            let key = russh::keys::decode_secret_key(&pem, if passphrase.is_empty() { None } else { Some(passphrase) })
                .map_err(|e| SshError::new(format!("私钥解析失败: {e}"), ErrKind::Other))?;
            Auth::Key(Arc::new(key))
        }
        _ => Auth::Password(cfg.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string()),
    };

    let identity_error=Arc::new(std::sync::Mutex::new(None));
    let connect = client::connect(client_config(), (host.as_str(), port), ClientHandler::new(cfg,identity_error.clone()));
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| SshError::new("连接失败：请检查 IP、端口、防火墙与网络", ErrKind::Other))?
        .map_err(|e| match identity_error.lock().unwrap().take() { Some(record)=>SshError::host_identity(record),None=>normalize_connect_err(&e) })?;

    let ok = match auth {
        Auth::Password(p) => handle.authenticate_password(&username, &p).await.unwrap_or(false),
        Auth::Key(k) => handle.authenticate_publickey(&username, k).await.unwrap_or(false),
    };
    if !ok {
        return Err(SshError::new("认证失败：用户名、密码或密钥不正确", ErrKind::Other));
    }
    Ok(handle)
}

/// Node: sshConnect —— 支持跳板机（ProxyJump / Bastion）链式转发
pub async fn ssh_connect(cfg: &Value) -> Result<Handle<ClientHandler>, SshError> {
    ssh_connect_visited(cfg, &mut std::collections::HashSet::new()).await
}

async fn ssh_connect_visited(
    cfg: &Value,
    visited: &mut std::collections::HashSet<String>,
) -> Result<Handle<ClientHandler>, SshError> {
    let jump_id = cfg.get("jumpHostId").and_then(|v| v.as_str()).unwrap_or("");
    if jump_id.is_empty() {
        return connect_direct(cfg).await;
    }
    if visited.contains(jump_id) {
        return Err(SshError::new("跳板机配置存在循环引用", ErrKind::Other));
    }
    let all_hosts = crate::load_json_or("hosts.json", serde_json::json!([]));
    let jump_cfg = all_hosts
        .as_array()
        .and_then(|a| a.iter().find(|h| h.get("id").and_then(|v| v.as_str()) == Some(jump_id)))
        .cloned()
        .ok_or_else(|| SshError::new("找不到指定的跳板机配置", ErrKind::Other))?;
    if let Some(id) = cfg.get("id").and_then(|v| v.as_str()) {
        visited.insert(id.to_string());
    }
    visited.insert(jump_id.to_string());

    let mut jump_handle = Box::pin(ssh_connect_visited(&jump_cfg, visited)).await?;
    let target_host = cfg.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let target_port = cfg.get("port").and_then(|v| v.as_i64()).unwrap_or(22) as u16;
    let channel = jump_handle
        .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0u32)
        .await
        .map_err(|e| SshError::new(format!("跳板机转发失败: {e}"), ErrKind::Other))?;
    let stream = channel.into_stream();
    let identity_error=Arc::new(std::sync::Mutex::new(None));
    let connect = client::connect_stream(client_config(), stream, ClientHandler::new(cfg,identity_error.clone()));
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| SshError::new("连接失败：请检查 IP、端口、防火墙与网络", ErrKind::Other))?
        .map_err(|e| {
            // 与 Node 一致：目标连接失败时同时关掉跳板机连接
            let _ = jump_handle.disconnect(Disconnect::ByApplication, "", "en");
            match identity_error.lock().unwrap().take() { Some(record)=>SshError::host_identity(record),None=>normalize_connect_err(&e) }
        })?;
    // The target connection has its own authentication, separate from the bastion.
    let username=cfg["username"].as_str().unwrap_or("");
    let authenticated=if cfg["authType"].as_str()==Some("key") {
        let content=cfg["keyContent"].as_str().unwrap_or("");
        let pem=if !content.trim().is_empty() { content.to_string() } else {
            std::fs::read_to_string(cfg["keyPath"].as_str().unwrap_or("")).map_err(|e|SshError::new(format!("读取目标私钥失败：{e}"),ErrKind::Other))?
        };
        let passphrase=cfg["passphrase"].as_str().filter(|s|!s.is_empty());
        let key=russh::keys::decode_secret_key(&pem,passphrase).map_err(|e|SshError::new(format!("目标私钥解析失败：{e}"),ErrKind::Other))?;
        handle.authenticate_publickey(username,Arc::new(key)).await.unwrap_or(false)
    } else { handle.authenticate_password(username,cfg["password"].as_str().unwrap_or("")).await.unwrap_or(false) };
    if !authenticated { return Err(SshError::new("目标服务器认证失败",ErrKind::Other)); }
    Ok(handle)
}

fn fail_from_exit(stderr_out: &str, stdout_out: &str, code: Option<u32>, signal: Option<String>) -> SshError {
    let status = match (&signal, code) {
        (Some(s), _) => format!("信号 {s}"),
        (None, Some(c)) => format!("退出码 {c}"),
        (None, None) => String::new(),
    };
    // Node: detail = (stderr.trim() || out.trim()).slice(-1000)
    let d = stderr_out.trim();
    let d = if d.is_empty() { stdout_out.trim() } else { d };
    let detail = tail_chars(d, 1000);
    let message = if detail.is_empty() {
        format!("命令失败（{status}）")
    } else {
        format!("{detail}（{status}）")
    };
    SshError::new(message, ErrKind::CommandFailed)
}

fn tail_chars(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        chars[chars.len() - n..].iter().collect()
    }
}

/// 执行命令并收集输出。
/// stdin=None 时与 Node sshExec 相同：stderr 并入 stdout；
/// stdin=Some 时与 Node sshExecStdin 相同：stderr 单独收集（仅用于报错详情）。
pub async fn exec_on_channel(
    channel: &mut Channel<russh::client::Msg>,
    cmd: &str,
    stdin: Option<Vec<u8>>,
    timeout_ms: u64,
) -> Result<String, SshError> {
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| SshError::new(format!("SSH 通道打开失败: {e}"), ErrKind::Other))?;

    let has_stdin = stdin.is_some();
    if let Some(input) = stdin {
        use tokio::io::AsyncWriteExt;
        let mut writer = channel.make_writer();
        const CHUNK: usize = 65536;
        for chunk in input.chunks(CHUNK) {
            writer
                .write_all(chunk)
                .await
                .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
        }
        writer
            .shutdown()
            .await
            .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
        drop(writer);
    }

    let mut out_bytes: Vec<u8> = Vec::new();
    let mut stderr_bytes: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;
    let mut exit_signal: Option<String> = None;

    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    out_bytes.extend_from_slice(data);
                }
                ChannelMsg::ExtendedData { ref data, .. } => {
                    stderr_bytes.extend_from_slice(data);
                    if !has_stdin {
                        // Node: sshExec 把 stderr 并入 stdout（按到达顺序）
                        out_bytes.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    exit_signal = Some(format!("{:?}", signal_name).to_uppercase());
                }
                ChannelMsg::Eof => {}
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;

    if result.is_err() {
        return Err(SshError::new(
            format!("执行超时（{} 秒）", timeout_ms / 1000),
            ErrKind::Timeout,
        ));
    }

    // 攒够字节后统一解码：跨包分割的 UTF-8 不会被截断（对应 Node StringDecoder）
    let out = String::from_utf8_lossy(&out_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    // Node: signal → 失败；code !== 0 → 失败；code === 0 → 成功；无退出状态 → 中断
    if let Some(sig) = exit_signal {
        return Err(fail_from_exit(&stderr, &out, exit_code, Some(sig)));
    }
    match exit_code {
        Some(0) => Ok(out),
        Some(c) => Err(fail_from_exit(&stderr, &out, Some(c), None)),
        None => Err(SshError::new(
            "SSH 命令已中断，未收到退出状态",
            ErrKind::Interrupted,
        )),
    }
}

/// Node: sshExec —— 语义：stderr 并入 stdout，非零退出/信号 → Err
/// 超时覆盖「打开通道 + 执行」全程（与 Node 一致）
pub async fn ssh_exec(
    handle: &mut Handle<ClientHandler>,
    cmd: &str,
    timeout_ms: u64,
) -> Result<String, SshError> {
    let fut = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
        exec_on_channel(&mut channel, cmd, None, timeout_ms).await
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(r) => r,
        Err(_) => Err(SshError::new(
            format!("执行超时（{} 秒）", timeout_ms / 1000),
            ErrKind::Timeout,
        )),
    }
}

/// Node: sshExecStdin —— 流式写入 stdin（用于大文件 / 写文件内容）
pub async fn ssh_exec_stdin(
    handle: &mut Handle<ClientHandler>,
    cmd: &str,
    stdin: Vec<u8>,
    timeout_ms: u64,
) -> Result<String, SshError> {
    let fut = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
        exec_on_channel(&mut channel, cmd, Some(stdin), timeout_ms).await
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(r) => r,
        Err(_) => Err(SshError::new(
            format!("执行超时（{} 秒）", timeout_ms / 1000),
            ErrKind::Timeout,
        )),
    }
}

/// 打开一个 PTY shell 通道（Node: sshShell，term: xterm-256color, 120x30）
pub async fn open_shell(
    handle: &mut Handle<ClientHandler>,
    cols: u32,
    rows: u32,
) -> Result<Channel<russh::client::Msg>, SshError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))?;
    Ok(channel)
}

/// 便捷：远端 shell 引号（供其他模块构造命令）
pub fn quote(s: &str) -> String {
    shq(s)
}
