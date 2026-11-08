// 全局 AI 与文件管理共用的 exec 连接池（Node: execConns / pendingExecConns）
use crate::ssh::{exec_on_channel, ErrKind, SshError};
use crate::AppState;
use russh::client::Handle;
use serde_json::Value;

use std::sync::Arc;
use tokio::sync::Mutex;

// Closing the SSH session on future cancellation also interrupts ordinary remote jobs.
// Detached/background processes still need an explicit follow-up status check.
struct ClosingChannel(Option<russh::Channel<russh::client::Msg>>);
impl Drop for ClosingChannel {
    fn drop(&mut self) {
        if let (Some(mut channel),Ok(runtime))=(self.0.take(),tokio::runtime::Handle::try_current()) {
            runtime.spawn(async move { let _=channel.close().await; });
        }
    }
}

/// Node: execConnOf —— 带连接有效性检查与建连去重
pub async fn exec_conn_of(st: &AppState, host_id: &str) -> Result<Arc<crate::ExecConn>, SshError> {
    {
        let conns = st.exec_conns.lock().await;
        if let Some(c) = conns.get(host_id) {
            if c.is_alive().await {
                return Ok(c.clone());
            }
        }
    }
    // Node: pending 去重 —— 同一 hostId 并发请求共享同一次建连
    let lock = {
        let mut locks = st.exec_connecting.lock().await;
        locks
            .entry(host_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    {
        let conns = st.exec_conns.lock().await;
        if let Some(c) = conns.get(host_id) {
            if c.is_alive().await {
                return Ok(c.clone());
            }
        }
    }
    let cfg = find_host(host_id)
        .await
        .ok_or_else(|| SshError::new("主机不存在", ErrKind::Other))?;
    let handle: Handle<crate::ssh::ClientHandler> = match crate::ssh::ssh_connect(&cfg).await {
        Ok(handle)=>handle,
        Err(error)=>{
            if let Some(key)=&error.host_key { st.broadcast_all(&serde_json::json!({"type":"ssh-host-key-required","key":key,"retryHostId":host_id})); }
            return Err(error);
        }
    };
    let conn = Arc::new(crate::ExecConn::new(handle));
    st.exec_conns.lock().await.insert(host_id.to_string(), conn.clone());
    Ok(conn)
}

pub async fn find_host(host_id: &str) -> Option<Value> {
    let hosts = crate::load_json_or("hosts.json", serde_json::json!([]));
    hosts
        .as_array()
        .and_then(|a| a.iter().find(|h| h.get("id").and_then(|v| v.as_str()) == Some(host_id)))
        .cloned()
}

/// Node: closeExecConn
pub async fn close_exec_conn(st: &AppState, host_id: &str) {
    if let Some(c) = st.exec_conns.lock().await.remove(host_id) {
        let mut handle = c.handle.lock().await;
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    st.exec_connecting.lock().await.remove(host_id);
}

/// Node: connOf —— 主机存在性检查 + 死连接重建
pub async fn conn_of(st: &AppState, host_id: &str) -> Result<Arc<crate::ExecConn>, SshError> {
    {
        let hosts = st.hosts.read().await;
        if !hosts.iter().any(|h| h.get("id").and_then(|v| v.as_str()) == Some(host_id)) {
            let cfg_missing = find_host(host_id).await.is_none();
            if cfg_missing {
                return Err(SshError::new("主机不存在", ErrKind::Other));
            }
        }
    }
    exec_conn_of(st, host_id).await
}

fn transport_error(message: &str) -> bool {
    let m = message.to_lowercase();
    ["not connected", "closed", "ended", "broken", "send", "disconnect", "io error"]
        .iter()
        .any(|k| m.contains(k))
}

/// Node: safeSshExec —— 连接失效时自动重建重试一次
pub async fn safe_ssh_exec(st: &AppState, host_id: &str, cmd: &str, ms: u64) -> Result<String, SshError> {
    let conn = conn_of(st, host_id).await?;
    let mut channel = match open_channel(&conn).await {
        Ok(ch) => ch,
        Err(e) => {
            if transport_error(&e.message) {
                close_exec_conn(st, host_id).await;
                let conn = conn_of(st, host_id).await?;
                open_channel(&conn).await?
            } else {
                return Err(e);
            }
        }
    };
    match exec_on_channel(&mut channel, cmd, None, ms).await {
        Ok(out) => Ok(out),
        Err(err) => {
            if err.kind != ErrKind::CommandFailed && err.kind != ErrKind::Timeout && transport_error(&err.message) {
                close_exec_conn(st, host_id).await;
                let conn = conn_of(st, host_id).await?;
                let mut channel = open_channel(&conn).await?;
                return exec_on_channel(&mut channel, cmd, None, ms).await;
            }
            Err(err)
        }
    }
}

/// 在连接上打开一个独立通道（锁内开通道，随后可并发执行）
pub async fn open_channel(
    conn: &Arc<crate::ExecConn>,
) -> Result<russh::Channel<russh::client::Msg>, SshError> {
    let mut guard = conn.handle.lock().await;
    guard
        .channel_open_session()
        .await
        .map_err(|e| SshError::new(format!("{e}"), ErrKind::Other))
}

/// Node: connOf + sshExec（trash/mv 等直接路径）
pub async fn exec_via_conn(st: &AppState, host_id: &str, cmd: &str, ms: u64) -> Result<String, SshError> {
    let conn = conn_of(st, host_id).await?;
    let mut channel = open_channel(&conn).await?;
    exec_on_channel(&mut channel, cmd, None, ms).await
}

/// 执行命令（stderr 并入 stdout）；供 AI agent 使用（Node: ctx.execOn）
pub async fn exec_on_host(st: &AppState, host_id: &str, cmd: &str, ms: u64) -> Result<String, String> {
    exec_via_conn(st, host_id, cmd, ms).await.map_err(|e| e.message)
}

pub async fn exec_result(st: &AppState, host_id: &str, cmd: &str, ms: u64, limit: usize) -> Result<crate::ssh::ExecResult, String> {
    let conn = conn_of(st, host_id).await.map_err(|e| e.message)?;
    let mut channel = ClosingChannel(Some(open_channel(&conn).await.map_err(|e| e.message)?));
    crate::ssh::exec_bounded(channel.0.as_mut().unwrap(), cmd, ms.clamp(1000, 600000), limit).await
}

/// Node: sshExecStdin 走专用 exec 连接（写文件/上传）
pub async fn exec_stdin_on_host(
    st: &AppState,
    host_id: &str,
    cmd: &str,
    stdin: Vec<u8>,
    ms: u64,
) -> Result<String, SshError> {
    let conn = conn_of(st, host_id).await?;
    let mut channel = ClosingChannel(Some(open_channel(&conn).await?));
    exec_on_channel(channel.0.as_mut().unwrap(), cmd, Some(stdin), ms).await
}
