// 全机探针：为每台服务器维持一个轻量 SSH 采集连接（对应 server/probe.js）
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::AppState;

pub struct ProbeState {
    pub host_id: String,
    pub cfg: Value,
    pub state: Mutex<String>,
    pub error: Mutex<Option<String>>,
    pub last: Mutex<Option<Value>>,
    pub samples: Mutex<Vec<Value>>,
    pub stop: Arc<AtomicBool>,
}

pub struct ProbeHub {
    pub map: Mutex<HashMap<String, Arc<ProbeState>>>,
}

/// Node: snapshotOf —— 不带 type 字段
fn snapshot_of(p: &ProbeState, state: &str, error: Option<&String>) -> Value {
    let last = p.last.try_lock().ok().and_then(|g| g.clone());
    json!({
        "hostId": p.host_id,
        "name": p.cfg.get("name").cloned().unwrap_or(Value::Null),
        "state": state,
        "error": error.map(|e| json!(e)).unwrap_or(Value::Null),
        "sample": last.unwrap_or(Value::Null)
    })
}

impl ProbeHub {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    /// Node: getProbeSnapshot
    pub async fn snapshot(&self) -> Value {
        let map = self.map.lock().await;
        let mut out = Vec::new();
        for p in map.values() {
            let state = p.state.lock().await.clone();
            let error = p.error.lock().await.clone();
            out.push(snapshot_of(p, &state, error.as_ref()));
        }
        json!(out)
    }

    /// Node: probeHistory
    pub async fn history(&self, host_id: &str) -> Vec<Value> {
        let map = self.map.lock().await;
        match map.get(host_id) {
            Some(p) => p.samples.lock().await.clone(),
            None => Vec::new(),
        }
    }

    pub fn history_tail(&self, host_id: &str, n: usize) -> Vec<Value> {
        if let Ok(map) = self.map.try_lock() {
            if let Some(p) = map.get(host_id) {
                if let Ok(samples) = p.samples.try_lock() {
                    let start = samples.len().saturating_sub(n);
                    return samples[start..].to_vec();
                }
            }
        }
        Vec::new()
    }

    /// Node: probeLast
    pub async fn last(&self, host_id: &str) -> Option<Value> {
        let map = self.map.lock().await;
        match map.get(host_id) {
            Some(p) => p.last.lock().await.clone(),
            None => None,
        }
    }

    /// Node: startProbe —— 同步插入表 + 派生采集循环
    fn start(&self, st: &Arc<AppState>, cfg: Value) {
        let host_id = cfg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let state = Arc::new(ProbeState {
            host_id: host_id.clone(),
            cfg: cfg.clone(),
            state: Mutex::new("connecting".into()),
            error: Mutex::new(None),
            last: Mutex::new(None),
            samples: Mutex::new(Vec::new()),
            stop: Arc::new(AtomicBool::new(false)),
        });
        if let Ok(mut map) = self.map.try_lock() {
            map.insert(host_id.clone(), state.clone());
        }
        let st2 = st.clone();
        let state2 = state.clone();
        tokio::spawn(async move {
            probe_loop(st2, state2).await;
        });
        st.broadcast_all(&{
            let mut v = snapshot_of(&state, "connecting", None);
            v["type"] = json!("probe");
            v
        });
    }

    /// Node: stopProbe
    pub async fn stop(&self, host_id: &str) {
        if let Some(p) = self.map.lock().await.remove(host_id) {
            p.stop.store(true, Ordering::SeqCst);
        }
    }

    /// Node: syncProbes —— 让探针列表与主机列表保持一致
    pub async fn sync(&self, st: &Arc<AppState>, hosts: &[Value]) {
        let want: HashSet<&str> = hosts
            .iter()
            .filter_map(|h| h.get("id").and_then(|v| v.as_str()))
            .collect();
        let stale: Vec<String> = {
            let map = self.map.lock().await;
            map.keys()
                .filter(|id| !want.contains(id.as_str()))
                .cloned()
                .collect()
        };
        for id in stale {
            self.stop(&id).await;
        }
        for h in hosts {
            let hid = h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let rebuild = {
                let mut map = self.map.lock().await;
                match map.get(&hid) {
                    None => true,
                    // 配置变了（IP/端口/凭据）→ 重建
                    Some(existing) => {
                        let same = strip_id(&existing.cfg) == strip_id(h);
                        if !same {
                            let old = map.remove(&hid).unwrap();
                            old.stop.store(true, Ordering::SeqCst);
                        }
                        !same
                    }
                }
            };
            if rebuild {
                self.start(st, h.clone());
            }
        }
    }
}

fn strip_id(v: &Value) -> Value {
    let mut o = v.as_object().cloned().unwrap_or_default();
    o.remove("id");
    Value::Object(o)
}

fn emit_snapshot(st: &AppState, p: &ProbeState) {
    let payload = {
        let state = p.state.try_lock().map(|g| g.clone()).unwrap_or_default();
        let error = p.error.try_lock().map(|g| g.clone()).unwrap_or_default();
        let mut v = snapshot_of(p, &state, error.as_ref());
        v["type"] = json!("probe");
        v
    };
    st.broadcast_all(&payload);
}

async fn probe_loop(st: Arc<AppState>, p: Arc<ProbeState>) {
    let mut prev: Option<crate::metrics::PrevSample> = None;
    let mut windows=false;
    loop {
        if p.stop.load(Ordering::SeqCst) {
            return;
        }
        *p.state.lock().await = "connecting".into();
        emit_snapshot(&st, &p);
        match crate::ssh::ssh_connect(&p.cfg.clone()).await {
            Ok(mut handle) => {
                if p.stop.load(Ordering::SeqCst) {
                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                    return;
                }
                *p.state.lock().await = "online".into();
                *p.error.lock().await = None;
                emit_snapshot(&st, &p);
                // 采集循环：连上后立即采第一帧，之后每 3s 一次（与 Node setInterval+立即 tick 一致）
                let mut first = true;
                loop {
                    if !first {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                    first = false;
                    if p.stop.load(Ordering::SeqCst) {
                        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                        return;
                    }
                    let command=if windows {crate::metrics::powershell_command(crate::metrics::WINDOWS_SCRIPT)}else{crate::metrics::COLLECT.into()};
                    let mut collected=crate::ssh::ssh_exec(&mut handle,&command,12000).await;
                    if !windows && (collected.as_ref().map(|text|crate::metrics::parse_sample(text,prev.as_ref()).is_none()).unwrap_or(false)
                        || collected.as_ref().err().map(|error|error.kind==crate::ssh::ErrKind::CommandFailed).unwrap_or(false)) {
                        let native=crate::ssh::ssh_exec(&mut handle,&crate::metrics::powershell_command(crate::metrics::WINDOWS_SCRIPT),15000).await;
                        if native.as_ref().map(|text|crate::metrics::parse_windows_sample(text,prev.as_ref()).is_some()).unwrap_or(false) {windows=true;}
                        collected=native;
                    }
                    match collected {
                        Ok(text) => {
                            let parsed=if windows {crate::metrics::parse_windows_sample(&text,prev.as_ref())}else{crate::metrics::parse_sample(&text,prev.as_ref())};
                            if let Some(sample) = parsed {
                                prev = Some(crate::metrics::PrevSample {
                                    t: sample.t,
                                    cpu: sample.cpu,
                                    cpu_total: sample.cpu_total,
                                    cpu_idle: sample.cpu_idle,
                                    rx_sum: sample.rx_sum,
                                    tx_sum: sample.tx_sum,
                                });
                                let mut j = sample.to_json();
                                j["platform"]=json!(if windows {"windows"}else{"linux"});
                                if windows { if let Ok(value)=serde_json::from_str::<Value>(&text) {j["os"]=value["os"].clone();} }
                                *p.last.lock().await = Some(j.clone());
                                {
                                    let mut samples = p.samples.lock().await;
                                    samples.push(j.clone());
                                    if samples.len() > 360 {
                                        samples.remove(0);
                                    }
                                }
                                st.broadcast_all(&json!({
                                    "type": "probe",
                                    "hostId": p.host_id,
                                    "name": p.cfg.get("name").cloned().unwrap_or(Value::Null),
                                    "state": "online",
                                    "sample": j
                                }));
                            } else {
                                st.broadcast_all(&json!({"type":"probe","hostId":p.host_id,"name":p.cfg["name"],"state":"online","metricsError":"采集结果格式异常，正在重试"}));
                            }
                        }
                        Err(e) => {
                            if e.kind==crate::ssh::ErrKind::CommandFailed && !handle.is_closed() {
                                st.broadcast_all(&json!({"type":"probe","hostId":p.host_id,"name":p.cfg["name"],"state":"online","metricsError":e.message}));
                                continue;
                            }
                            // 连接失效（服务器离线/WSL 回收/网络抖动）：标记离线并重建
                            *p.state.lock().await = "offline".into();
                            *p.error.lock().await = Some(e.message.clone());
                            emit_snapshot(&st, &p);
                            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                *p.state.lock().await = if e.host_key.is_some() {"host-key-required"} else {"offline"}.into();
                *p.error.lock().await = Some(e.message.clone());
                emit_snapshot(&st, &p);
                // Pause until identity has been explicitly trusted; do not retry every 12 seconds.
                if e.host_key.is_some() {
                    while !p.stop.load(Ordering::SeqCst) { tokio::time::sleep(std::time::Duration::from_millis(250)).await; }
                    return;
                }
            }
        }
        // 12s 后重试（可被打断）
        for _ in 0..120 {
            if p.stop.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}
