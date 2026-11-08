// WebSocket 协议层（对应 index.js 的 handleWs / wss.connection）
use crate::pool;
use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

type Subs = Arc<tokio::sync::Mutex<HashMap<String, JoinHandle<()>>>>;

pub async fn ws_handler(ws: WebSocketUpgrade, State(st): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

async fn handle_socket(socket: WebSocket, st: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    // 每个连接一条出站队列：全局广播 + 会话广播 + 直发都写进来
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let out_tx_handler = out_tx.clone();
    
    let mut all_rx = st.tx_all.subscribe();

    // 全局事件泵（Node: broadcastAll 的投递 + probe 转发）
    let global_pump = tokio::spawn(async move {
        loop {
            match all_rx.recv().await {
                Ok(msg) => {
                    if out_tx.send(msg).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // 告诉新接入的页面当前进行中的对话（刷新后恢复用）
    {
        let chat_id = { st.agent.lock().await.chat_id.clone() };
        if let Some(chat_id) = chat_id {
            let title = crate::chats::get_chat(crate::CHAT_KEY, &chat_id)
                .map(|c| c.get("title").cloned().unwrap_or(json!("对话")))
                .unwrap_or(json!("对话"));
            let busy = st.agent.lock().await.busy;
            let _ = out_tx_handler.send(json!({ "type": "chat-meta", "chatId": chat_id, "title": title, "busy":busy }).to_string());
        }
    }

    // 会话级订阅：sessionId → 转发任务句柄（detach / 关闭时终止）
    let subs: Subs = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    // 出站泵：out_rx → WebSocket
    let outbound = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // 入站处理
    while let Some(Ok(msg)) = ws_rx.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
        let request_type=m["type"].as_str().unwrap_or("").to_string();
        if let Some(error)=crate::storage_fault(){if request_type!="chat-stop"{let _=out_tx_handler.send(json!({"type":"storage-error","error":error}).to_string());continue;}}
        if let Err(e) = handle_ws(&st, &out_tx_handler, &subs, m).await {
            let _ = out_tx_handler.send(json!({ "type": "error", "message": e,"requestType":request_type }).to_string());
        }
    }

    global_pump.abort();
    outbound.abort();
    // Node: ws.close → 从所有会话的 clients 移除（终止全部订阅即等价）
    for (_, h) in subs.lock().await.drain() {
        h.abort();
    }
}

/// 订阅一个终端会话的输出（Node: s.clients.add(ws)）
async fn subscribe_session(st: &Arc<AppState>, subs: &Subs, sid: &str, out_tx: &mpsc::UnboundedSender<String>) {
    let Some(session) = st.sessions.lock().await.get(sid).cloned() else { return };
    let out = out_tx.clone();
    let handle = tokio::spawn(async move {
        let mut rx = session.tx.subscribe();
        loop {
            match rx.recv().await {
                Ok(m) => {
                    if out.send(m).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    let mut map = subs.lock().await;
    if let Some(old) = map.insert(sid.to_string(), handle) {
        old.abort();
    }
}

async fn unsubscribe_session(subs: &Subs, sid: &str) {
    if let Some(h) = subs.lock().await.remove(sid) {
        h.abort();
    }
}

async fn handle_ws(
    st: &Arc<AppState>,
    out_tx: &mpsc::UnboundedSender<String>,
    subs: &Subs,
    m: Value,
) -> Result<(), String> {
    let mtype = m.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // 终端类消息优先按 sessionId 定位会话（兼容旧客户端只带 hostId）
    let skey = m
        .get("sessionId")
        .and_then(|v| v.as_str())
        .or_else(|| m.get("hostId").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    match mtype.as_str() {
        "attach" => {
            let sid = m.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let host_id = m.get("hostId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !sid.is_empty() && !host_id.is_empty() {
                let cwd = m.get("cwd").and_then(|v| v.as_str()).map(String::from);
                crate::sessions::ensure_session(st, &sid, &host_id, out_tx, cwd.as_deref()).await;
                subscribe_session(st, subs, &sid, out_tx).await;
            }
            Ok(())
        }
        "term-input" => {
            let data = m.get("data").and_then(|v| v.as_str()).unwrap_or("").as_bytes().to_vec();
            let s = st.sessions.lock().await.get(skey.as_str()).cloned();
            if let Some(s) = s {
                let _ = s.input_tx.send(crate::sessions::InputMsg::Data(data));
            }
            Ok(())
        }
        "term-resize" => {
            let cols = m.get("cols").and_then(|v| v.as_i64()).unwrap_or(0) as u32;
            let rows = m.get("rows").and_then(|v| v.as_i64()).unwrap_or(0) as u32;
            let s = st.sessions.lock().await.get(skey.as_str()).cloned();
            if let Some(s) = s {
                if cols != 0 && rows != 0 {
                    let _ = s.input_tx.send(crate::sessions::InputMsg::Resize { cols, rows });
                }
            }
            Ok(())
        }
        "metrics-sub" => {
            let host_id = m.get("hostId").and_then(|v| v.as_str()).unwrap_or("");
            let samples = st.probes.history_tail(host_id, 180);
            let _ = out_tx.send(
                json!({ "type": "metrics-batch", "hostId": host_id, "samples": samples }).to_string(),
            );
            Ok(())
        }
        "chat" => {
            let id=crate::jobs::submit(st,&m).await?;
            let _=out_tx.send(json!({"type":"chat-accepted","jobId":id}).to_string());
            Ok(())
        }
        "chat-pause" => {crate::jobs::pause(st,true).await;Ok(())}
        "chat-resume" => {crate::jobs::pause(st,false).await;Ok(())}
        "chat-queue-remove" => {crate::jobs::edit(st,m["jobId"].as_str().unwrap_or(""),None).await}
        "chat-queue-edit" => {crate::jobs::edit(st,m["jobId"].as_str().unwrap_or(""),Some(m["text"].as_str().unwrap_or(""))).await}
        "chat-queue-clear" => {
            let mut agent=st.agent.lock().await;agent.queue.clear();crate::jobs::persist(&agent);drop(agent);crate::jobs::broadcast(st).await;Ok(())
        }
        "chat-clear" => {
            let mut agent = st.agent.lock().await;
            if agent.busy || !agent.queue.is_empty() { return Err("请先结束任务并处理队列，再新建对话".into()); }
            agent.messages.clear();
            agent.chat_id = None;
            agent.busy = false;
            drop(agent);
            st.broadcast_all(&json!({ "type": "chat-cleared" }));
            Ok(())
        }
        "chat-select" => {
            let chat_id = m.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(chat) = crate::chats::get_chat(crate::CHAT_KEY, chat_id) {
                let mut agent = st.agent.lock().await;
                if agent.busy || !agent.queue.is_empty() { return Err("请先停止当前任务并处理队列，再切换对话".into()); }
                agent.chat_id = chat.get("id").and_then(|v| v.as_str()).map(String::from);
                agent.messages = chat.get("messages").and_then(|mv| mv.as_array()).cloned().unwrap_or_default();
            }
            Ok(())
        }
        "agent-scope" => {
            let requested=m.get("hostIds").and_then(Value::as_array).map(|ids|ids.iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>()).unwrap_or_default();
            let scope=crate::operations::normalize_scope(&st.hosts.read().await,&requested);
            let mut agent = st.agent.lock().await;
            if agent.busy { return Err("任务执行中不能变更机器范围".into()); }
            agent.scope=scope.clone();
            drop(agent);
            st.broadcast_all(&json!({"type":"agent-scope","hostIds":scope}));
            Ok(())
        }
        "chat-stop" => {
            let agent=st.agent.lock().await;
            if let Some(cancel)=&agent.cancel { cancel.send_replace(true); }
            drop(agent);crate::jobs::pause(st,true).await;
            Ok(())
        }
        "tool-approve" => {
            let req_id = m.get("reqId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let remember = m.get("remember").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(command) = crate::approvals::resolve_approval(&req_id, true) {
                if remember && !command.is_empty() {
                    st.agent.lock().await.allowed.insert(command);
                }
            }
            Ok(())
        }
        "tool-deny" => {
            let req_id = m.get("reqId").and_then(|v| v.as_str()).unwrap_or("");
            crate::approvals::resolve_approval(req_id, false);
            Ok(())
        }
        "detach" => {
            let sid = m.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !sid.is_empty() {
                crate::sessions::destroy_session(st, &sid, "已关闭终端").await;
                unsubscribe_session(subs, &sid).await;
            }
            Ok(())
        }
        "close-host" => {
            let host_id = m.get("hostId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !host_id.is_empty() {
                crate::sessions::destroy_sessions_of_host(st, &host_id, "已在侧栏断开").await;
                pool::close_exec_conn(st, &host_id).await;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
