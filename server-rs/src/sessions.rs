// 终端会话：SSH 连接 + PTY 交互 + scrollback 回放（对应 index.js 会话部分）
use crate::ssh::open_shell;
use crate::AppState;
use russh::ChannelMsg;
use russh::{Channel, Disconnect};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::mpsc;

pub enum InputMsg {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

pub struct TermSession {
    pub id: String,
    pub host_id: String,
    pub cfg: Value,
    pub os_info: StdMutex<String>,
    pub ready: AtomicBool,
    pub scrollback: StdMutex<String>,
    /// 会话内广播（Node: session.clients）
    pub tx: tokio::sync::broadcast::Sender<String>,
    /// 写入 PTY 的命令通道
    pub input_tx: mpsc::UnboundedSender<InputMsg>,
    pub handle: StdMutex<Option<russh::client::Handle<crate::ssh::ClientHandler>>>,
    pub dead: AtomicBool,
    pub integration: StdMutex<Option<String>>,
}

pub fn session_broadcast(s: &TermSession, msg: &Value) {
    let _ = s.tx.send(msg.to_string());
}

fn push_scrollback(s: &TermSession, text: &str) {
    let mut sb = s.scrollback.lock().unwrap();
    sb.push_str(text);
    let len = sb.chars().count();
    if len > 8000 {
        *sb = sb.chars().skip(len - 8000).collect();
    }
}

/// Node: createSession
async fn create_session(st: Arc<AppState>, sid: &str, host_id: &str) -> Result<Arc<TermSession>, crate::ssh::SshError> {
    let cfg = {
        let hosts = st.hosts.read().await;
        hosts
            .iter()
            .find(|h| h.get("id").and_then(|v| v.as_str()) == Some(host_id))
            .cloned()
            .ok_or_else(|| crate::ssh::SshError::new("主机不存在",crate::ssh::ErrKind::Other))?
    };
    let (tx, _) = tokio::sync::broadcast::channel(4096);
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<InputMsg>();
    let session = Arc::new(TermSession {
        id: sid.to_string(),
        host_id: host_id.to_string(),
        cfg: cfg.clone(),
        os_info: StdMutex::new(String::new()),
        ready: AtomicBool::new(false),
        scrollback: StdMutex::new(String::new()),
        tx: tx.clone(),
        input_tx,
        handle: StdMutex::new(None),
        dead: AtomicBool::new(false),
        integration: StdMutex::new(None),
    });
    st.sessions.lock().await.insert(sid.to_string(), session.clone());
    session_broadcast(&session, &json!({ "type": "status", "sessionId": sid, "hostId": host_id, "state": "connecting" }));

    let st_spawn = st.clone();
    let setup = async {
        let mut handle = crate::ssh::ssh_connect(&cfg).await?;
        let shell_name=crate::ssh::ssh_exec(&mut handle,"printf '%s' \"$SHELL\"",3000).await.unwrap_or_default();
        let token=crate::rand_id("terminal");
        let bootstrap=crate::terminal_history::bootstrap(shell_name.trim(),&token);
        if bootstrap.is_some(){*session.integration.lock().unwrap()=Some(token.clone());}
        let mut shell: Channel<russh::client::Msg> =
            open_shell(&mut handle, 120, 30).await?;
        if let Some(bootstrap)=&bootstrap{shell.data(bootstrap.as_bytes()).await.map_err(|error|crate::ssh::SshError::new(error.to_string(),crate::ssh::ErrKind::Other))?;}

        // 输出泵：channel.wait() → scrollback + 会话广播；输入命令 → 写入/resize
        let s2 = session.clone();
        let sid2 = sid.to_string();
        let hid2 = host_id.to_string();
        tokio::spawn(async move {
            let mut decoder=crate::terminal_history::Stream::new(bootstrap.as_ref().map(|_|token.as_str()));
            loop {
                tokio::select! {
                    _=tokio::time::sleep(std::time::Duration::from_secs(5)),if decoder.waiting=>{decoder.waiting=false;let _=shell.data(b"\r".as_slice()).await;},
                    input = input_rx.recv() => {
                        match input {
                            Some(InputMsg::Data(bytes)) => {
                                let _ = shell.data(&bytes[..]).await;
                            }
                            Some(InputMsg::Resize { cols, rows }) => {
                                let _ = shell.window_change(cols, rows, 0, 0).await;
                            }
                            None => break,
                        }
                    }
                    msg = shell.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data })|Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                let(text,histories)=decoder.feed(data);
                                if !text.is_empty(){push_scrollback(&s2, &text);session_broadcast(&s2, &json!({ "type": "term-data", "sessionId": sid2, "hostId": hid2, "data": text }));}
                                for history in histories{if let Ok(commands)=crate::terminal_history::merge(&hid2,&history){st_spawn.broadcast_all(&json!({"type":"terminal-history","hostId":hid2,"commands":commands}));}}
                            }
                            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) => {}
                            Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                }
            }
            // 只有仍然是当前会话时才销毁（防止被重连替换掉的旧会话误杀新会话）
            let st2 = st_spawn.clone();
            let sid3 = sid2.clone();
            tokio::spawn(async move {
                let current=st2.sessions.lock().await.get(&sid3).is_some_and(|current|Arc::ptr_eq(current,&s2));
                if current{destroy_session(&st2, &sid3, "SSH 会话已结束").await;}
            });
        });

        // os 信息探测（用完即放的临时借用）
        let os_info = {
            let out = crate::ssh::ssh_exec(
                &mut handle,
                "uname -srmo 2>/dev/null; grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d\\\" -f2",
                8000,
            )
            .await;
            let out=match out {
                Ok(text)=>text,
                Err(_)=>crate::ssh::ssh_exec(&mut handle,&crate::metrics::powershell_command("(Get-CimInstance Win32_OperatingSystem).Caption"),10000).await.unwrap_or_default(),
            };
            out.trim().to_string()
        };
        *session.os_info.lock().unwrap() = os_info;
        *session.handle.lock().unwrap() = Some(handle);
        session.ready.store(true, Ordering::SeqCst);
        session_broadcast(
            &session,
            &json!({
                "type": "status",
                "sessionId": sid,
                "hostId": host_id,
                "state": "connected",
                "os": session.os_info.lock().unwrap().clone()
                ,"shellIntegration":session.integration.lock().unwrap().clone()
            }),
        );
        crate::append_audit(json!({
            "ts": crate::now_ms(),
            "host": cfg.get("name").cloned().unwrap_or(Value::Null),
            "command": "(连接)",
            "action": "connect"
        }));
        Ok::<(), crate::ssh::SshError>(())
    }
    .await;

    if let Err(e) = setup {
        st.sessions.lock().await.remove(sid);
        return Err(e);
    }
    Ok(session)
}

/// Node: ensureSession —— 建连去重 + 回放 + metrics 批量
pub async fn ensure_session(
    st: &Arc<AppState>,
    sid: &str,
    host_id: &str,
    ws_tx: &mpsc::UnboundedSender<String>,
    cwd: Option<&str>,
) {
    let send = |m: Value| {
        let _ = ws_tx.send(m.to_string());
    };
    // 同一会话的并发创建去重：全局建连锁（创建频率低，串行即可）
    let exists = st.sessions.lock().await.get(sid).is_some();
    if !exists {
        let _create_lock = st.session_creating.lock().await;
        let exists = st.sessions.lock().await.get(sid).is_some();
        if !exists {
            send(json!({"type":"status","sessionId":sid,"hostId":host_id,"state":"connecting"}));
            let r = create_session(st.clone(), sid, host_id).await;
            if let Err(error)=r {
                let needs_identity=error.host_key.is_some();
                send(json!({ "type": "status", "sessionId": sid, "hostId": host_id,
                    "state": if needs_identity {"host-key-required"} else {"error"}, "message": error.message }));
                if let Some(key)=error.host_key { send(json!({"type":"ssh-host-key-required","key":key,"retryHostId":host_id})); }
                return;
            }
        }
    }
    let Some(s) = st.sessions.lock().await.get(sid).cloned() else { return };
    let state = if s.ready.load(Ordering::SeqCst) { "connected" } else { "connecting" };
    send(json!({ "type": "status", "sessionId": sid, "hostId": host_id, "state": state, "os": s.os_info.lock().unwrap().clone(),"shellIntegration":s.integration.lock().unwrap().clone() }));
    send(json!({ "type": "term-replay", "sessionId": sid, "hostId": host_id, "data": s.scrollback.lock().unwrap().clone() }));
    send(json!({
        "type": "metrics-batch",
        "sessionId": sid,
        "hostId": host_id,
        "samples": st.probes.history_tail(host_id, 180)
    }));
    if let Some(cwd) = cwd {
        if crate::valid_path(cwd) {
            let cmd = format!("cd {}\r", crate::shq(cwd));
            let tx = s.input_tx.clone();
            let scrollback_len = s.scrollback.lock().unwrap().chars().count();
            // Node: 已有输出 → 60ms 后 cd；否则等首帧/兜底 600ms 再 cd
            tokio::spawn(async move {
                let delay = if scrollback_len > 0 { 60 } else { 600 };
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                let _ = tx.send(InputMsg::Data(cmd.into_bytes()));
            });
        }
    }
}

/// Node: destroySession
pub async fn destroy_session(st: &Arc<AppState>, sid: &str, reason: &str) {
    let s = { st.sessions.lock().await.get(sid).cloned() };
    let Some(s) = s else { return };
    s.dead.store(true, Ordering::SeqCst);
    if let Some(h) = s.handle.lock().unwrap().take() {
        let mut h = h;
        tokio::spawn(async move {
            let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
        });
    }
    st.sessions.lock().await.remove(sid);
    session_broadcast(
        &s,
        &json!({
            "type": "status",
            "sessionId": sid,
            "hostId": s.host_id,
            "state": "closed",
            "message": if reason.is_empty() { "连接已断开" } else { reason }
        }),
    );
}

pub async fn sessions_of_host(st: &Arc<AppState>, host_id: &str) -> Vec<Arc<TermSession>> {
    st.sessions
        .lock()
        .await
        .values()
        .filter(|s| s.host_id == host_id)
        .cloned()
        .collect()
}

pub async fn destroy_sessions_of_host(st: &Arc<AppState>, host_id: &str, reason: &str) {
    for s in sessions_of_host(st, host_id).await {
        destroy_session(st, &s.id, reason).await;
    }
}

/// Node: osOf —— 该主机任一会话的 os 信息
pub async fn os_of_host(st: &Arc<AppState>, host_id: &str) -> String {
    sessions_of_host(st, host_id)
        .await
        .iter()
        .find(|s| !s.os_info.lock().unwrap().is_empty())
        .map(|s| s.os_info.lock().unwrap().clone())
        .unwrap_or_default()
}
