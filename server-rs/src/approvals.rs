// AI 想执行有风险的命令时，弹条等用户点确认（对应 server/approvals.js）
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<String, (oneshot::Sender<bool>, String)>>>;

static PENDING: LazyLock<Pending> = LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));
static DETAILS: LazyLock<Mutex<HashMap<String,serde_json::Value>>> = LazyLock::new(||Mutex::new(HashMap::new()));

pub fn pending_approvals()->Vec<serde_json::Value> { DETAILS.lock().unwrap().values().cloned().collect() }
pub fn cancel_ai_approvals() {
    let ids:Vec<String>=DETAILS.lock().unwrap().iter().filter(|(_,v)|v["source"]=="ai").map(|(id,_)|id.clone()).collect();
    for id in ids { resolve_approval(&id,false); }
}

/// Node: requestApproval —— 120 秒无人响应视为拒绝
pub fn request_approval(
    broadcast: &impl Fn(&serde_json::Value),
    command: &str,
    host_name: &str,
) -> oneshot::Receiver<bool> {
    request_approval_details(broadcast, command, host_name, "", None, "ai",None)
}

pub fn request_approval_details(
    broadcast: &impl Fn(&serde_json::Value), command: &str, host_name: &str,
    host_id: &str, preview: Option<serde_json::Value>, source:&str,st:Option<Arc<crate::AppState>>,
) -> oneshot::Receiver<bool> {
    let req_id = crate::rand_id("req");
    let (sx, rx) = oneshot::channel();
    PENDING.lock().unwrap().insert(req_id.clone(), (sx, format!("{host_id}\n{command}")));
    let event=json!({ "type": "tool-request", "reqId": req_id, "command": command, "host": host_name, "hostId":host_id, "preview":preview,"source":source,"expiresAt":crate::now_ms()+120000 });
    DETAILS.lock().unwrap().insert(req_id.clone(),event.clone());
    {
        let pending = PENDING.clone();
        let req_id2 = req_id.clone();
        tokio::spawn(async move {
            let mut elapsed=0u64;
            while elapsed<120000 {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                if !pending.lock().unwrap().contains_key(&req_id2){return;}
                let paused=if let Some(st)=&st{st.agent.lock().await.paused}else{false};
                if !paused{elapsed+=250;}
            }
            DETAILS.lock().unwrap().remove(&req_id2);
            if let Some((sx, _)) = pending.lock().unwrap().remove(&req_id2) {
                let _ = sx.send(false);
            }
            if let Some(st)=&st{st.broadcast_all(&json!({"type":"tool-request-expired","reqId":req_id2}));}
        });
    }
    broadcast(&event);
    rx
}

/// Node: resolveApproval —— 返回该请求对应的命令（供「记住此命令」加入白名单）
pub fn resolve_approval(req_id: &str, approve: bool) -> Option<String> {
    DETAILS.lock().unwrap().remove(req_id);
    let p = PENDING.lock().unwrap().remove(req_id);
    match p {
        Some((sx, command)) => {
            let _ = sx.send(approve);
            Some(command)
        }
        None => None,
    }
}
