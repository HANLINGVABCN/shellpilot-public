// REST 路由（对应 server/index.js 的全部 API，契约一字不差）
use crate::pool;
use crate::util::*;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

type App = Arc<AppState>;

async fn open_external_url(State(st):State<App>,Json(body):Json<Value>)->Response{
    let url=match crate::external::web_url(body["url"].as_str().unwrap_or("")){Ok(url)=>url,Err(error)=>return err400(error)};
    let opener=st.external_opener.read().unwrap().clone();
    let result=match opener{Some(opener)=>opener(&url),None=>crate::external::open_default(&url)};
    match result{Ok(())=>Json(json!({"ok":true})).into_response(),Err(error)=>err400(error)}
}

async fn mcp_call(State(st): State<App>, headers: axum::http::HeaderMap, Json(body): Json<Value>) -> Response {
    let runtime = crate::load_json_or("runtime.json", json!({}));
    let expected = runtime["token"].as_str().unwrap_or("");
    if expected.is_empty() || headers.get(header::AUTHORIZATION).and_then(|v|v.to_str().ok()) != Some(format!("Bearer {expected}").as_str()) {
        return err(StatusCode::UNAUTHORIZED,"MCP authentication failed");
    }
    let context = match crate::mcp::context(st) { Ok(value) => value, Err(error) => return err400(error) };
    match context.call(body["name"].as_str().unwrap_or(""), &body.get("arguments").cloned().unwrap_or(json!({}))).await {
        Ok(value) => Json(value).into_response(), Err(error) => err400(error),
    }
}
async fn mcp_config() -> Response {
    let executable = std::env::current_exe().map(|p|p.to_string_lossy().to_string()).unwrap_or_default();
    Json(json!({"command":executable,"args":["--mcp"],"env":{"SHELLPILOT_DATA":crate::data_dir().to_string_lossy()}})).into_response()
}
async fn ssh_keys() -> Response {
    let observed=crate::load_json_or("observed-host-keys.json",json!({}));
    Json(json!(observed.as_object().map(|v|v.values().cloned().collect::<Vec<_>>()).unwrap_or_default())).into_response()
}
async fn ssh_trust(State(st):State<App>,Json(body):Json<Value>)->Response {
    let id=body["hostId"].as_str().unwrap_or("");
    match crate::ssh::trust_host_key(id,body["fingerprint"].as_str().unwrap_or("")) {
        Ok(())=>{
            crate::pool::close_exec_conn(&st,id).await;
            st.probes.stop(id).await;
            let hosts=st.hosts.read().await.clone();
            st.probes.sync(&st,&hosts).await;
            st.broadcast_all(&json!({"type":"ssh-host-key-trusted","hostId":id}));
            Json(json!({"ok":true})).into_response()
        },
        Err(error)=>err400(error),
    }
}
async fn agent_status(State(st):State<App>)->Response {
    let agent=st.agent.lock().await;
    let mut value=crate::jobs::status(&agent);value["messages"]=json!(agent.messages);value["scope"]=json!(agent.scope);value["approvals"]=json!(crate::approvals::pending_approvals());
    Json(value).into_response()
}
async fn memories_list()->Response{Json(json!({"memories":crate::memories::list(),"autoMemory":crate::get_settings()["autoMemory"]})).into_response()}
async fn memories_create(State(st):State<App>,Json(body):Json<Value>)->Response{
    match crate::memories::save(&body,None,false){Ok(value)=>{st.broadcast_all(&json!({"type":"memories-changed"}));Json(value).into_response()},Err(error)=>err400(error)}
}
async fn memories_update(State(st):State<App>,Path(id):Path<String>,Json(body):Json<Value>)->Response{
    let result=if body["content"].is_string(){crate::memories::save(&body,Some(&id),false)}
        else if let Some(enabled)=body["enabled"].as_bool(){crate::memories::change(&[id],Some(enabled)).map(|count|json!({"changed":count}))}
        else{return err400("请输入记忆内容或启用状态");};
    match result{Ok(value)=>{st.broadcast_all(&json!({"type":"memories-changed"}));Json(value).into_response()},Err(error)=>err400(error)}
}
async fn memories_delete(State(st):State<App>,Path(id):Path<String>)->Response{
    match crate::memories::change(&[id],None){Ok(count)=>{st.broadcast_all(&json!({"type":"memories-changed"}));Json(json!({"deleted":count})).into_response()},Err(error)=>err400(error)}
}
async fn memories_batch(State(st):State<App>,Json(body):Json<Value>)->Response{
    let Some(ids)=body["ids"].as_array()else{return err400("请选择记忆");};
    if ids.iter().any(|id|!id.is_string()){return err400("记忆 ID 格式错误");}
    let ids=ids.iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>();
    if body["action"]!="delete" && !body["enabled"].is_boolean(){return err400("请选择启用、停用或删除");}
    match crate::memories::change(&ids,if body["action"]=="delete"{None}else{body["enabled"].as_bool()}){
        Ok(count)=>{st.broadcast_all(&json!({"type":"memories-changed"}));Json(json!({"changed":count})).into_response()},Err(error)=>err400(error)
    }
}
async fn mcp_test()->Response {
    use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};
    let test=async {
        let executable=std::env::current_exe().map_err(|e|e.to_string())?;
        let mut child=tokio::process::Command::new(executable).arg("--mcp").env("SHELLPILOT_DATA",crate::data_dir())
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn().map_err(|e|e.to_string())?;
        let mut input=child.stdin.take().ok_or("MCP stdin unavailable")?;
        let mut output=BufReader::new(child.stdout.take().ok_or("MCP stdout unavailable")?).lines();
        input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"connection-test\",\"version\":\"1\"}}}\n").await.map_err(|e|e.to_string())?;
        let line=output.next_line().await.map_err(|e|e.to_string())?.ok_or("MCP 未返回初始化结果")?;
        let init:Value=serde_json::from_str(&line).map_err(|e|e.to_string())?;
        input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n").await.map_err(|e|e.to_string())?;
        let line=output.next_line().await.map_err(|e|e.to_string())?.ok_or("MCP 未返回工具列表")?;
        let tools:Value=serde_json::from_str(&line).map_err(|e|e.to_string())?;
        let _=child.kill().await;
        Ok::<Value,String>(json!({"tools":tools["result"]["tools"].as_array().map(Vec::len).unwrap_or(0),"protocolVersion":init["result"]["protocolVersion"]}))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15),test).await {
        Ok(Ok(value))=>Json(value).into_response(),Ok(Err(error))=>err400(error),Err(_)=>err400("MCP 连接测试超时"),
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn err400(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

async fn parse_body(
    raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Value {
    raw.map(|Json(v)| v).unwrap_or_else(|_| json!(null))
}

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(String::from)
}

// ---------- 主机管理 ----------

async fn hosts_list(State(st): State<App>) -> Response {
    let hosts = st.hosts.read().await;
    let out: Vec<Value> = hosts
        .iter()
        .map(|h| {
            let mut obj = h.as_object().cloned().unwrap_or_default();
            let has_password = obj.contains_key("password");
            let has_passphrase = obj.contains_key("passphrase");
            let has_key = obj.contains_key("keyContent");
            obj.remove("password");
            obj.remove("passphrase");
            obj.remove("keyContent");
            obj.insert("hasPassword".into(), json!(has_password));
            obj.insert("hasPassphrase".into(), json!(has_passphrase));
            obj.insert("hasKeyContent".into(), json!(has_key));
            Value::Object(obj)
        })
        .collect();
    Json(Value::Array(out)).into_response()
}

/// Node: applySecrets
fn apply_secrets(rec: &mut Value, body: &Value, is_edit: bool) {
    let auth_type = rec
        .get("authType")
        .and_then(|v| v.as_str())
        .unwrap_or("password")
        .to_string();
    let Some(obj) = rec.as_object_mut() else { return };
    for k in ["password", "passphrase", "keyContent", "keyPath"] {
        if let Some(v) = body.get(k) {
            let skip = is_edit && v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false);
            if !skip {
                obj.insert(k.into(), v.clone());
            }
        }
    }
    if auth_type == "password" {
        obj.remove("keyPath");
        obj.remove("keyContent");
    } else {
        obj.remove("password");
    }
}

async fn hosts_create(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let name = opt_str(&b, "name");
    let host = opt_str(&b, "host");
    let username = opt_str(&b, "username");
    let (name, host, username) = match (name, host, username) {
        (Some(n), Some(h), Some(u)) if !n.is_empty() && !h.is_empty() && !u.is_empty() => (n, h, u),
        _ => return err400("名称、IP、用户名都不能为空"),
    };
    let port = b.get("port").map(port_or_default).unwrap_or(22);
    let auth_type = if opt_str(&b, "authType").as_deref() == Some("key") { "key" } else { "password" };
    let group = opt_str(&b, "group").map(|g| g.trim().to_string()).unwrap_or_default();
    let jump = opt_str(&b, "jumpHostId").map(|g| g.trim().to_string()).unwrap_or_default();
    let id = rand_id("h");
    let mut rec = json!({
        "id": id,
        "name": name,
        "host": host,
        "port": port,
        "username": username,
        "authType": auth_type,
        "group": group,
        "jumpHostId": jump
    });
    apply_secrets(&mut rec, &b, false);
    let snapshot = {
        let mut hosts = st.hosts.write().await;
        hosts.push(rec.clone());
        hosts.clone()
    };
    st.save_hosts().await;
    st.probes.sync(&st, &snapshot).await;
    Json(json!({ "ok": true, "id": rec.get("id").cloned().unwrap_or(Value::Null) })).into_response()
}

async fn hosts_update(
    State(st): State<App>,
    Path(id): Path<String>,
    raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let b = parse_body(raw).await;
    let snapshot = {
        let mut hosts = st.hosts.write().await;
        let idx = match hosts
            .iter()
            .position(|h| h.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            Some(i) => i,
            None => return err(StatusCode::NOT_FOUND, "主机不存在"),
        };
        let mut rec = hosts[idx].clone();
        if rec.get("jumpHostId").and_then(|v| v.as_str()) == Some(id.as_str()) {
            if let Some(o) = rec.as_object_mut() {
                o.insert("jumpHostId".into(), json!(""));
            }
        }
        for k in ["name", "host", "port", "username", "authType", "group", "jumpHostId"] {
            if let Some(v) = b.get(k) {
                let newv = match k {
                    "port" => json!(port_or_default(v)),
                    "group" | "jumpHostId" => json!(v.as_str().unwrap_or("").trim()),
                    _ => v.clone(),
                };
                if let Some(o) = rec.as_object_mut() {
                    o.insert(k.into(), newv);
                }
            }
        }
        if let Some(at) = b.get("authType") {
            let v = if at.as_str() == Some("key") { "key" } else { "password" };
            if let Some(o) = rec.as_object_mut() {
                o.insert("authType".into(), json!(v));
            }
        }
        if rec.get("jumpHostId").and_then(|v| v.as_str()) == Some(id.as_str()) {
            if let Some(o) = rec.as_object_mut() {
                o.insert("jumpHostId".into(), json!(""));
            }
        }
        apply_secrets(&mut rec, &b, true);
        hosts[idx] = rec;
        hosts.clone()
    };
    st.save_hosts().await;
    pool::close_exec_conn(&st, &id).await;
    st.probes.sync(&st, &snapshot).await;
    Json(json!({ "ok": true })).into_response()
}

async fn hosts_delete(State(st): State<App>, Path(id): Path<String>) -> Response {
    let snapshot = {
        let mut hosts = st.hosts.write().await;
        hosts.retain(|h| h.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        for h in hosts.iter_mut() {
            if h.get("jumpHostId").and_then(|v| v.as_str()) == Some(id.as_str()) {
                if let Some(o) = h.as_object_mut() {
                    o.insert("jumpHostId".into(), json!(""));
                }
            }
        }
        hosts.clone()
    };
    st.save_hosts().await;
    crate::sessions::destroy_sessions_of_host(&st, &id, "主机已删除").await;
    pool::close_exec_conn(&st, &id).await;
    crate::chats::delete_host_chats(&id);
    st.probes.sync(&st, &snapshot).await;
    Json(json!({ "ok": true })).into_response()
}

// ---------- 设置 ----------

async fn settings_get(State(_st): State<App>) -> Response {
    Json(crate::get_settings()).into_response()
}

async fn settings_put(State(_st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let s = parse_body(raw).await;
    let ok = s.get("providers").map(|v| v.is_array()).unwrap_or(false)
        && s.get("models").map(|v| v.is_array()).unwrap_or(false);
    if !ok {
        return err400("配置格式错误");
    }
    crate::save_settings(&s);
    Json(json!({ "ok": true })).into_response()
}

// ---------- AI 连通性测试 ----------

async fn ai_test(State(_st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let Some(base_url) = opt_str(&b, "baseURL").filter(|s| !s.is_empty()) else {
        return err400("Base URL 不能为空");
    };
    let api_key = opt_str(&b, "apiKey");
    match crate::ai::fetch_model_list(&base_url, api_key.as_deref()).await {
        Ok(list) => Json(json!({ "ok": true, "count": list.len(), "models": list })).into_response(),
        Err(e) => {
            // 404 = 服务商不提供 /models 列表接口（比如智谱 GLM），不算失败
            if e.starts_with("HTTP 404") || e.starts_with("HTTP 405") {
                return Json(json!({
                    "ok": true, "count": 0, "models": [],
                    "note": "该服务商不提供模型列表接口，用「常用模型」或手动添加即可"
                }))
                .into_response();
            }
            err400(e)
        }
    }
}

async fn ai_chat_test(State(_st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let base_url = opt_str(&b, "baseURL").unwrap_or_default();
    let model = opt_str(&b, "model").unwrap_or_default();
    if base_url.is_empty() || model.is_empty() {
        return err400("缺少 Base URL 或模型名");
    }
    let api_key = opt_str(&b, "apiKey");
    match crate::ai::chat_test(&base_url, api_key.as_deref(), &model).await {
        Ok((reply, ms)) => Json(json!({ "ok": true, "reply": reply, "ms": ms })).into_response(),
        Err(e) => err400(e),
    }
}

// ---------- 对话记录 ----------

async fn chats_list(State(_st): State<App>, Path(key): Path<String>) -> Response {
    Json(crate::chats::list_chats(&key)).into_response()
}

async fn chats_get(State(_st): State<App>, Path((key, chat_id)): Path<(String, String)>) -> Response {
    match crate::chats::get_chat(&key, &chat_id) {
        Some(c) => Json(json!({
            "id": c.get("id").cloned().unwrap_or(Value::Null),
            "title": c.get("title").cloned().unwrap_or(Value::Null),
            "messages": c.get("messages").cloned().unwrap_or(json!([]))
        }))
        .into_response(),
        None => err(StatusCode::NOT_FOUND, "对话不存在"),
    }
}

async fn delete_chat_selection(st:&App,key:&str,ids:Vec<String>)->Response {
    let mut agent=st.agent.lock().await;
    let current_selected=key==crate::CHAT_KEY && agent.chat_id.as_ref().map(|id|ids.contains(id)).unwrap_or(false);
    if current_selected && agent.busy || key==crate::CHAT_KEY && agent.queue.iter().any(|job|ids.contains(&job.chat_id)){return err(StatusCode::CONFLICT,"对话仍有执行中或排队任务，请先停止并清理队列再删除");}
    let deleted=crate::chats::delete_chats(key,&ids);
    if current_selected {agent.chat_id=None;agent.messages.clear();}
    drop(agent);
    if current_selected {st.broadcast_all(&json!({"type":"chat-cleared"}));}
    st.broadcast_all(&json!({"type":"chat-list-changed"}));
    Json(json!({"ok":true,"deleted":deleted,"currentCleared":current_selected})).into_response()
}

async fn chats_delete(State(st): State<App>, Path((key, chat_id)): Path<(String, String)>) -> Response {
    delete_chat_selection(&st,&key,vec![chat_id]).await
}

async fn chats_delete_batch(State(st):State<App>,Path(key):Path<String>,Json(body):Json<Value>)->Response {
    let ids=if body["all"].as_bool()==Some(true) {
        crate::chats::list_chats(&key).as_array().into_iter().flatten().filter_map(|chat|chat["id"].as_str().map(String::from)).collect()
    } else {
        let Some(ids)=body["ids"].as_array() else {return err400("请选择要删除的对话");};
        if ids.iter().any(|id|!id.is_string()) {return err400("对话 ID 格式错误");}
        ids.iter().filter_map(Value::as_str).map(String::from).collect()
    };
    delete_chat_selection(&st,&key,ids).await
}

// ---------- 导入 / 导出 ----------

async fn export(State(_st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let password = opt_str(&b, "password").unwrap_or_default();
    if password.is_empty() {
        return err400("密码不能为空");
    }
    let plaintext = serde_json::to_string_pretty(&crate::crypt::export_all()).unwrap_or_default();
    let buf = crate::crypt::encrypt_data(plaintext.as_bytes(), &password);
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"shellpilot-export-{}.spex\"", now_ms()),
            ),
        ],
        buf,
    )
        .into_response()
}

async fn import_preview(State(_st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let password = opt_str(&b, "password").unwrap_or_default();
    let data = opt_str(&b, "data").unwrap_or_default();
    if password.is_empty() || data.is_empty() {
        return err400("密码和数据不能为空");
    }
    let decrypted = match decode_and_decrypt(&data, &password) {
        Ok(v) => v,
        Err(e) => return err400(e),
    };
    let parsed = match crate::import::validate_import_data(&decrypted) {
        Ok(p) => p,
        Err(e) => return err400(e),
    };
    let hosts: Vec<Value> = parsed
        .hosts
        .iter()
        .map(|h| {
            json!({
                "id": h.get("id").cloned().unwrap_or(Value::Null),
                "name": h.get("name").cloned().unwrap_or(Value::Null),
                "username": h.get("username").cloned().unwrap_or(Value::Null),
                "host": h.get("host").cloned().unwrap_or(Value::Null),
                "port": h.get("port").map(port_or_default).unwrap_or(22)
            })
        })
        .collect();
    let model_count = |pid: &str| -> usize {
        parsed
            .settings
            .get("models")
            .and_then(|m| m.as_array())
            .map(|ms| {
                ms.iter()
                    .filter(|m| m.get("providerId").and_then(|v| v.as_str()) == Some(pid))
                    .count()
            })
            .unwrap_or(0)
    };
    let providers: Vec<Value> = parsed
        .settings
        .get("providers")
        .and_then(|p| p.as_array())
        .map(|ps| {
            ps.iter()
                .map(|p| {
                    json!({
                        "id": p.get("id").cloned().unwrap_or(Value::Null),
                        "name": p.get("name").cloned().unwrap_or(Value::Null),
                        "baseURL": p.get("baseURL").cloned().unwrap_or(Value::Null),
                        "modelCount": model_count(p.get("id").and_then(|v| v.as_str()).unwrap_or(""))
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_chats = parsed
        .chats
        .as_object()
        .map(|m| m.values().any(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false)))
        .unwrap_or(false);
    Json(json!({ "hosts": hosts, "providers": providers, "hasChats": has_chats })).into_response()
}

fn decode_and_decrypt(data: &str, password: &str) -> Result<Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "文件格式不正确或不是 ShellPilot 导出文件".to_string())?;
    let plain = crate::crypt::decrypt_data(&bytes, password)?;
    serde_json::from_slice(&plain).map_err(|_| "文件格式不正确或不是 ShellPilot 导出文件".to_string())
}

async fn import(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let password = opt_str(&b, "password").unwrap_or_default();
    let data = opt_str(&b, "data").unwrap_or_default();
    if password.is_empty() || data.is_empty() {
        return err400("密码和数据不能为空");
    }
    if {let agent=st.agent.lock().await;agent.busy || !agent.queue.is_empty()} {
        return err(StatusCode::CONFLICT, "AI 正在执行任务，请等待任务结束后再导入");
    }
    let parsed = match decode_and_decrypt(&data, &password) {
        Ok(v) => v,
        Err(e) => return err400(e),
    };
    let options = crate::import::ImportOptions {
        host_ids: b.get("hostIds").cloned(),
        provider_ids: b.get("providerIds").cloned(),
        mode: opt_str(&b, "mode"),
    };
    let result = match crate::import::prepare_import(&crate::crypt::export_all(), &parsed, options) {
        Ok(r) => r,
        Err(e) => return err400(e),
    };
    if let Some(memories)=parsed.get("memories") {
        if let Err(error)=crate::memories::import_records(memories,b["mode"]=="overwrite"){return err400(error);}
        st.broadcast_all(&json!({"type":"memories-changed"}));
    }
    crate::save_json("hosts.json", result.get("hosts").unwrap_or(&json!([])));
    crate::save_json("settings.json", result.get("settings").unwrap_or(&json!({})));
    crate::save_json("chats.json", result.get("chats").unwrap_or(&json!({})));

    // 变更过的主机：断开旧会话与 exec 连接
    let old_hosts: Vec<Value> = st.hosts.read().await.clone();
    let new_hosts = result.get("hosts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for old in &old_hosts {
        let old_id = old.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let changed = match new_hosts.iter().find(|h| h.get("id").and_then(|v| v.as_str()) == Some(old_id.as_str())) {
            None => true,
            Some(next) => next != old,
        };
        if changed {
            crate::sessions::destroy_sessions_of_host(&st, &old_id, "主机配置已更新").await;
            pool::close_exec_conn(&st, &old_id).await;
        }
    }
    *st.hosts.write().await = new_hosts.clone();
    st.notify_hosts_changed().await;
    crate::chats::reload_chats();
    {
        let mut agent = st.agent.lock().await;
        agent
            .scope
            .retain(|id| new_hosts.iter().any(|h| h.get("id").and_then(|v| v.as_str()) == Some(id.as_str())));
        if let Some(chat_id) = agent.chat_id.clone() {
            match crate::chats::get_chat(crate::CHAT_KEY, &chat_id) {
                Some(chat) => {
                    agent.messages = chat.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                    drop(agent);
                    st.broadcast_all(&json!({ "type": "chat-meta", "chatId": chat_id, "title": chat.get("title").cloned().unwrap_or(json!("对话")) }));
                }
                None => {
                    agent.chat_id = None;
                    drop(agent);
                    st.broadcast_all(&json!({ "type": "chat-cleared" }));
                }
            }
        }
    }
    st.probes.sync(&st, &new_hosts).await;
    st.broadcast_all(&json!({ "type": "chat-list-changed" }));
    let mode = opt_str(&b, "mode").unwrap_or_else(|| "merge".into());
    Json(json!({ "ok": true, "mode": mode })).into_response()
}

// ---------- 文件管理 ----------

fn valid_path_or(p: Option<&str>) -> Option<String> {
    let p = p?;
    if valid_path(&p) {
        Some(p.to_string())
    } else {
        None
    }
}

async fn fs_home(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    match pool::safe_ssh_exec(&st, &host, "echo $HOME", 15000).await {
        Ok(out) => {
            let home = out.trim().to_string();
            let home = if home.is_empty() { "/root".to_string() } else { home };
            Json(json!({ "home": home })).into_response()
        }
        Err(e) => {
            pool::close_exec_conn(&st, &host).await;
            err400(e.message)
        }
    }
}

async fn fs_list(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    let Some(path) = valid_path_or(q.get("path").map(|s| s.as_str())) else {
        return err400("路径不合法");
    };
    let cmd = format!(
        "find {} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'",
        shq(&path)
    );
    match pool::safe_ssh_exec(&st, &host, &cmd, 30000).await {
        Ok(out) => {
            let mut entries = Vec::new();
            for line in out.split('\n') {
                let cols: Vec<&str> = line.split('\t').collect();
                if cols.len() < 4 {
                    continue;
                }
                entries.push(json!({
                    "type": cols[0],
                    "size": cols[1].parse::<i64>().unwrap_or(0),
                    "mtime": (cols[2].parse::<f64>().unwrap_or(0.0) * 1000.0).floor() as i64,
                    "name": cols[3..].join("\t")
                }));
            }
            Json(json!({ "entries": entries })).into_response()
        }
        Err(e) => {
            pool::close_exec_conn(&st, &host).await;
            err400(e.message)
        }
    }
}

async fn fs_mkdir(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(path) = valid_path_or(opt_str(&b, "path").as_deref()) else {
        return err400("路径不合法");
    };
    let cmd = format!("mkdir -p -- {p} && [ -d {p} ]", p = shq(&path));
    match pool::exec_via_conn(&st, &host, &cmd, 30000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

async fn fs_newfile(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(path) = valid_path_or(opt_str(&b, "path").as_deref()) else {
        return err400("路径不合法");
    };
    let cmd = format!("[ -e {p} ] && {{ echo EXISTS; exit 1; }} || {{ : > {p}; }}", p = shq(&path));
    match pool::exec_via_conn(&st, &host, &cmd, 30000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

const TRASH_REMOTE: &str = "\"$HOME/.shellpilot-trash\"";

fn trash_meta_file(host: &str) -> String {
    format!("trash-{host}.json")
}

async fn fs_delete(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let list: Vec<String> = b
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if list.is_empty() || list.iter().any(|p| !valid_path(p)) {
        return err400("路径不合法");
    }
    let conn_cmd = format!("mkdir -p {t} && echo {t}", t = TRASH_REMOTE);
    let trash_dir = match pool::exec_via_conn(&st, &host, &conn_cmd, 15000).await {
        Ok(out) => out.trim().to_string(),
        Err(e) => return err400(e.message),
    };
    let stamp = rand_id("trash");
    let mut i = 0usize;
    for p in &list {
        let t_path = format!("{trash_dir}/{stamp}-{i}");
        let cmd = format!("mv -- {a} {b}", a = shq(p), b = shq(&t_path));
        if let Err(e) = pool::exec_via_conn(&st, &host, &cmd, 60000).await {
            return err400(e.message);
        }
        let mut meta = crate::load_json_or(&trash_meta_file(&host), json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default();
        meta.push(json!({
            "trashPath": t_path,
            "origPath": p,
            "name": base_name(p),
            "time": now_ms()
        }));
        crate::save_json(&trash_meta_file(&host), &json!(meta));
        i += 1;
    }
    Json(json!({ "ok": true, "moved": list.len() })).into_response()
}

async fn fs_trash_list(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    let _trash_dir = match pool::exec_via_conn(&st, &host, &format!("echo {t}", t = TRASH_REMOTE), 15000).await {
        Ok(out) => out.trim().to_string(),
        Err(e) => return err400(e.message),
    };
    let meta = crate::load_json_or(&trash_meta_file(&host), json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for m in meta {
        let tpath = m.get("trashPath").and_then(|v| v.as_str()).unwrap_or("");
        let cmd = format!("[ -e {p} ] && echo Y || echo N", p = shq(tpath));
        let exists = match pool::exec_via_conn(&st, &host, &cmd, 15000).await {
            Ok(o) => o.trim() == "Y",
            Err(_) => false,
        };
        if exists {
            out.push(m);
        }
    }
    crate::save_json(&trash_meta_file(&host), &json!(out));
    out.reverse();
    Json(json!({ "items": out })).into_response()
}

async fn fs_trash_restore(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(trash_path) = valid_path_or(opt_str(&b, "trashPath").as_deref()) else {
        return err400("路径不合法");
    };
    let Some(orig_path) = valid_path_or(opt_str(&b, "origPath").as_deref()) else {
        return err400("路径不合法");
    };
    let parent = posix_dirname(&orig_path);
    if let Err(e) = pool::exec_via_conn(&st, &host, &format!("mkdir -p -- {}", shq(&parent)), 15000).await {
        return err400(e.message);
    }
    // 原位置被占则自动找 (2) (3)… 空位
    let mut dest = orig_path.clone();
    for i in 2..100 {
        let cmd = format!("[ -e {p} ] && echo Y || echo N", p = shq(&dest));
        let occupied = match pool::exec_via_conn(&st, &host, &cmd, 15000).await {
            Ok(o) => o.trim() == "Y",
            Err(e) => return err400(e.message),
        };
        if !occupied {
            break;
        }
        dest = format!("{orig_path} ({i})");
    }
    let cmd = format!("mv -- {a} {b}", a = shq(&trash_path), b = shq(&dest));
    if let Err(e) = pool::exec_via_conn(&st, &host, &cmd, 60000).await {
        return err400(e.message);
    }
    let meta: Vec<Value> = crate::load_json_or(&trash_meta_file(&host), json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.get("trashPath").and_then(|v| v.as_str()) != Some(trash_path.as_str()))
        .collect();
    crate::save_json(&trash_meta_file(&host), &json!(meta));
    Json(json!({ "ok": true, "dest": dest })).into_response()
}

async fn fs_trash_purge(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let trash_path = opt_str(&b, "trashPath").unwrap_or_default();
    let trash_dir = match pool::exec_via_conn(&st, &host, &format!("echo {t}", t = TRASH_REMOTE), 15000).await {
        Ok(out) => out.trim().to_string(),
        Err(e) => return err400(e.message),
    };
    if !trash_path.is_empty() {
        if !valid_path(&trash_path) || !trash_path.starts_with(&format!("{trash_dir}/")) {
            return err400("路径不合法");
        }
        if let Err(e) = pool::exec_via_conn(&st, &host, &format!("rm -rf -- {}", shq(&trash_path)), 120000).await {
            return err400(e.message);
        }
        let meta: Vec<Value> = crate::load_json_or(&trash_meta_file(&host), json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|m| m.get("trashPath").and_then(|v| v.as_str()) != Some(trash_path.as_str()))
            .collect();
        crate::save_json(&trash_meta_file(&host), &json!(meta));
    } else {
        let cmd = format!("rm -rf -- {t} && mkdir -p {t}", t = TRASH_REMOTE);
        if let Err(e) = pool::exec_via_conn(&st, &host, &cmd, 120000).await {
            return err400(e.message);
        }
        crate::save_json(&trash_meta_file(&host), &json!([]));
    }
    Json(json!({ "ok": true })).into_response()
}

async fn fs_rename(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(from) = valid_path_or(opt_str(&b, "from").as_deref()) else {
        return err400("路径不合法");
    };
    let Some(to) = valid_path_or(opt_str(&b, "to").as_deref()) else {
        return err400("路径不合法");
    };
    let cmd = format!("mv -- {a} {b}", a = shq(&from), b = shq(&to));
    match pool::exec_via_conn(&st, &host, &cmd, 30000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

async fn fs_paste(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(dest_dir) = valid_path_or(opt_str(&b, "destDir").as_deref()) else {
        return err400("目标目录不合法");
    };
    let items: Vec<Value> = b.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if items.is_empty() {
        return err400("没有要粘贴的内容");
    }
    for it in &items {
        let path_ok = it.get("path").and_then(|v| v.as_str()).map(valid_path).unwrap_or(false);
        let name_ok = it.get("asName").and_then(|v| v.as_str()).map(valid_file_name).unwrap_or(false);
        let kind_ok = it
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|k| k == "copy" || k == "cut")
            .unwrap_or(false);
        if !path_ok || !name_ok || !kind_ok {
            return err400("粘贴项不合法");
        }
    }
    let mut errors: Vec<String> = Vec::new();
    for it in &items {
        let it_host = it.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let path = it.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kind = it.get("kind").and_then(|v| v.as_str()).unwrap_or("copy").to_string();
        let as_name = it.get("asName").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = base_name(&path);
        let base_dest = format!("{}/{}", dest_dir.trim_end_matches('/'), as_name);
        let result: Result<(), String> = async {
            // 若是同机器同路径剪切，无需操作
            if it_host == host && kind == "cut" && path == base_dest {
                return Ok(());
            }
            // 自动检测目标路径是否被占用，若被占用则自动找 (2) (3)...
            let mut dest = base_dest.clone();
            for i in 2..100 {
                let cmd = format!("[ -e {p} ] && echo Y || echo N", p = shq(&dest));
                let occupied = pool::safe_ssh_exec(&st, &host, &cmd, 15000)
                    .await
                    .map(|o| o.trim() == "Y")
                    .map_err(|e| e.message)?;
                if !occupied {
                    break;
                }
                dest = format!("{base_dest} ({i})");
            }
            if it_host == host {
                let op = if kind == "cut" { "mv" } else { "cp -a" };
                let cmd = format!("{op} -- {a} {b}", a = shq(&path), b = shq(&dest));
                pool::safe_ssh_exec(&st, &host, &cmd, 300000)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.message)?;
            } else {
                // 跨机：源机 tar+base64 → 目标机解码解包
                let trimmed = path.trim_end_matches('/');
                let segs: Vec<&str> = trimmed.split('/').collect();
                let src_dir = if segs.len() > 1 {
                    segs[..segs.len() - 1].join("/")
                } else {
                    "/".to_string()
                };
                let src_dir = if src_dir.is_empty() { "/".to_string() } else { src_dir };
                let cmd = format!("tar -czf - -C {d} -- {n} | base64", d = shq(&src_dir), n = shq(&name));
                let b64 = pool::safe_ssh_exec(&st, &it_host, &cmd, 600000)
                    .await
                    .map_err(|e| e.message)?;
                if b64.len() > 240 * 1024 * 1024 {
                    return Err("文件过大（单次跨机粘贴上限约 150MB）".into());
                }
                let tmp = format!(
                    "{}/.sp-tmp-{}-{}",
                    dest_dir.trim_end_matches('/'),
                    format!("{:x}", now_ms()),
                    rand_id("").replace('_', "")
                );
                pool::safe_ssh_exec(&st, &host, &format!("mkdir -p -- {}", shq(&tmp)), 30000)
                    .await
                    .map_err(|e| e.message)?;
                let final_dest = dest.clone();
                let inner = async {
                    pool::exec_stdin_on_host(
                        &st,
                        &host,
                        &format!("base64 -d | tar -xzf - -C {}", shq(&tmp)),
                        b64.into_bytes(),
                        600000,
                    )
                    .await?;
                    let cmd = format!(
                        "mv -- {a} {b} && rm -rf -- {c}",
                        a = shq(&format!("{tmp}/{name}")),
                        b = shq(&final_dest),
                        c = shq(&tmp)
                    );
                    pool::exec_via_conn(&st, &host, &cmd, 60000).await
                };
                if let Err(e) = inner.await {
                    let _ = pool::safe_ssh_exec(&st, &host, &format!("rm -rf -- {}", shq(&tmp)), 30000).await;
                    return Err(e.message);
                }
                if kind == "cut" {
                    let _ = pool::safe_ssh_exec(&st, &it_host, &format!("rm -rf -- {}", shq(&path)), 120000).await;
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            errors.push(format!("{name}: {e}"));
        }
    }
    if !errors.is_empty() {
        return err400(errors.join("；"));
    }
    Json(json!({ "ok": true })).into_response()
}

async fn fs_stat(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    let Some(path) = valid_path_or(q.get("path").map(|s| s.as_str())) else {
        return err400("路径不合法");
    };
    let cmd = format!("stat -c '%A|%a|%U|%G|%s|%Y' -- {}", shq(&path));
    let out = match pool::exec_via_conn(&st, &host, &cmd, 15000).await {
        Ok(o) => o,
        Err(e) => return err400(e.message),
    };
    let parts: Vec<&str> = out.trim().split('|').collect();
    if parts.len() < 6 {
        return err400("无法读取属性");
    }
    Json(json!({
        "perms": parts[0],
        "permsOctal": parts[1],
        "owner": parts[2],
        "group": parts[3],
        "size": parts[4].parse::<i64>().unwrap_or(0),
        "mtime": parts[5].parse::<i64>().unwrap_or(0) * 1000,
        "path": path,
        "name": base_name(&path)
    }))
    .into_response()
}

async fn fs_read(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    let Some(path) = valid_path_or(q.get("path").map(|s| s.as_str())) else {
        return err400("路径不合法");
    };
    let cmd = format!("base64 < {}", shq(&path));
    let b64 = match pool::exec_via_conn(&st, &host, &cmd, 60000).await {
        Ok(o) => o,
        Err(e) => return err400(e.message),
    };
    if b64.len() > 4 * 1024 * 1024 {
        return err400("文件超过 3MB，请用下载");
    }
    Json(json!({ "data": b64.trim(), "name": base_name(&path) })).into_response()
}

async fn fs_write(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(path) = valid_path_or(opt_str(&b, "path").as_deref()) else {
        return err400("路径不合法");
    };
    let Some(data) = b.get("data").and_then(|v| v.as_str()).map(String::from) else {
        return err400("内容不能为空");
    };
    let cmd = format!("base64 -d > {}", shq(&path));
    match pool::exec_stdin_on_host(&st, &host, &cmd, data.into_bytes(), 120000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

async fn fs_upload_chunk(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    upload_impl(st, parse_body(raw).await, true).await
}

async fn fs_upload(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    upload_impl(st, parse_body(raw).await, false).await
}

async fn upload_impl(st: App, b: Value, chunk: bool) -> Response {
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(dir) = valid_path_or(opt_str(&b, "dir").as_deref()) else {
        return err400("目录不合法");
    };
    let Some(name) = opt_str(&b, "name").filter(|n| valid_file_name(n)) else {
        return err400("文件名不合法");
    };
    let Some(data) = opt_str(&b, "data") else {
        return err400("内容不能为空");
    };
    let dest = format!("{}/{}", dir.trim_end_matches('/'), name);
    let append = chunk && b.get("append").and_then(|v| v.as_bool()).unwrap_or(false);
    let op = if append { "cat >>" } else { "cat >" };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .unwrap_or_default();
    let cmd = format!("{op} {}", shq(&dest));
    let timeout = if chunk { 120000 } else { 600000 };
    match pool::exec_stdin_on_host(&st, &host, &cmd, bytes, timeout).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

async fn fs_download(State(st): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let host = q.get("host").cloned().unwrap_or_default();
    let Some(path) = valid_path_or(q.get("path").map(|s| s.as_str())) else {
        return err400("路径不合法");
    };
    let is_dir = {
        let cmd = format!("[ -d {p} ] && echo D || echo F", p = shq(&path));
        match pool::exec_via_conn(&st, &host, &cmd, 15000).await {
            Ok(o) => o.trim() == "D",
            Err(e) => return err400(e.message),
        }
    };
    if is_dir {
        return err400("目录请用压缩后再下载");
    }
    // 流式下载：头部延迟到首个数据字节（与 Node 一致，远端先失败时返回 400 JSON）
    let conn = match pool::conn_of(&st, &host).await {
        Ok(c) => c,
        Err(e) => return err400(e.message),
    };
    let mut channel = match pool::open_channel(&conn).await {
        Ok(c) => c,
        Err(e) => return err400(e.message),
    };
    if let Err(e) = channel.exec(true, format!("cat -- {}", shq(&path)).into_bytes()).await {
        return err400(format!("{e}"));
    }
    let file_name = base_name(&path);
    let encoded: String =
        percent_encoding::utf8_percent_encode(&file_name, percent_encoding::NON_ALPHANUMERIC).to_string();

    let mut stderr_tail = String::new();
    let mut first_chunk: Option<bytes::Bytes> = None;
    let mut remote_failed: Option<String> = None;
    let mut exit_code: Option<u32> = None;
    let mut exit_signal: Option<String> = None;
    let mut closed = false;
    // 读到首个数据字节或终止为止
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(600), channel.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { ref data })) => {
                first_chunk = Some(bytes::Bytes::copy_from_slice(data));
                break;
            }
            Ok(Some(russh::ChannelMsg::ExtendedData { ref data, .. })) => {
                stderr_tail.push_str(&String::from_utf8_lossy(data));
                if stderr_tail.len() > 1000 {
                    let cut = stderr_tail.len() - 1000;
                    stderr_tail = stderr_tail.split_off(cut);
                }
            }
            Ok(Some(russh::ChannelMsg::ExitStatus { exit_status })) => exit_code = Some(exit_status),
            Ok(Some(russh::ChannelMsg::ExitSignal { signal_name, .. })) => {
                exit_signal = Some(format!("{:?}", signal_name).to_uppercase());
            }
            Ok(Some(russh::ChannelMsg::Close)) | Ok(None) => {
                closed = true;
                break;
            }
            Ok(Some(_)) => {}
            Err(_) => {
                remote_failed = Some("下载超时".into());
                break;
            }
        }
    }
    if let Some(sig) = exit_signal.clone() {
        return err400(if stderr_tail.trim().is_empty() { format!("下载被信号中断: {sig}") } else { stderr_tail.trim().to_string() });
    }
    if let Some(msg) = remote_failed {
        return err400(msg);
    }
    if closed && exit_code.is_none() && first_chunk.is_none() {
        // 通道先于退出状态关闭
        return err400(if stderr_tail.trim().is_empty() { "远端文件读取失败".to_string() } else { stderr_tail.trim().to_string() });
    }
    if exit_code.unwrap_or(0) != 0 {
        return err400(if stderr_tail.trim().is_empty() { "远端文件读取失败".to_string() } else { stderr_tail.trim().to_string() });
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        // 保持连接存活
        let _keep = conn;
        if let Some(chunk) = first_chunk {
            if tx.send(Ok(chunk)).await.is_err() {
                return;
            }
        }
        if closed {
            return;
        }
        let mut failed = false;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(600), channel.wait()).await {
                Ok(Some(russh::ChannelMsg::Data { ref data })) => {
                    if tx.send(Ok(bytes::Bytes::copy_from_slice(data))).await.is_err() {
                        break;
                    }
                }
                Ok(Some(russh::ChannelMsg::ExtendedData { .. })) => {}
                Ok(Some(russh::ChannelMsg::ExitStatus { exit_status })) => exit_code = Some(exit_status),
                Ok(Some(russh::ChannelMsg::ExitSignal { signal_name, .. })) => {
                    exit_signal = Some(format!("{:?}", signal_name).to_uppercase());
                }
                Ok(Some(russh::ChannelMsg::Close)) | Ok(None) => break,
                Ok(Some(_)) => {}
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        if exit_signal.is_some() || exit_code.unwrap_or(1) != 0 {
            failed = true;
        }
        if failed {
            let _ = tx.send(Err(std::io::Error::other("远端文件读取失败"))).await;
        }
    });
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{}", encoded),
            ),
        ],
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
    )
        .into_response()
}

async fn fs_compress(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let paths: Vec<String> = b
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if paths.is_empty() || paths.iter().any(|p| !valid_path(p)) {
        return err400("路径不合法");
    }
    let Some(dest_file) = opt_str(&b, "destFile").filter(|p| valid_path(p)) else {
        return err400("压缩包路径不合法");
    };
    let parent = posix_dirname(&posix_normalize_strip(&paths[0]));
    for item in &paths {
        let d = posix_dirname(&posix_normalize_strip(item));
        if d != parent || !valid_file_name(&base_name(item)) {
            return err400("请选择同一目录下的文件或文件夹");
        }
    }
    let names = paths
        .iter()
        .map(|p| shq(&base_name(p)))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!("tar -czf {f} -C {d} -- {n}", f = shq(&dest_file), d = shq(&parent), n = names);
    match pool::exec_via_conn(&st, &host, &cmd, 300000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

async fn fs_extract(State(st): State<App>, raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>) -> Response {
    let b = parse_body(raw).await;
    let host = opt_str(&b, "host").unwrap_or_default();
    let Some(path) = valid_path_or(opt_str(&b, "path").as_deref()) else {
        return err400("路径不合法");
    };
    let Some(dest_dir) = valid_path_or(opt_str(&b, "destDir").as_deref()) else {
        return err400("路径不合法");
    };
    let lower = path.to_lowercase();
    let cmd = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        format!("tar -xzf {p} -C {d}", p = shq(&path), d = shq(&dest_dir))
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        format!("tar -xjf {p} -C {d}", p = shq(&path), d = shq(&dest_dir))
    } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        format!("tar -xJf {p} -C {d}", p = shq(&path), d = shq(&dest_dir))
    } else if lower.ends_with(".tar") {
        format!("tar -xf {p} -C {d}", p = shq(&path), d = shq(&dest_dir))
    } else if lower.ends_with(".zip") {
        format!("unzip -o -d {d} -- {p}", d = shq(&dest_dir), p = shq(&path))
    } else {
        return err400("只支持 .tar.gz / .tar.bz2 / .tar.xz / .tar / .zip");
    };
    match pool::exec_via_conn(&st, &host, &cmd, 600000).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err400(e.message),
    }
}

// ---------- 探针 / 审计 ----------

async fn probe(State(st): State<App>) -> Response {
    Json(st.probes.snapshot().await).into_response()
}

async fn audit(State(_st): State<App>) -> Response {
    let text = match std::fs::read_to_string(crate::store::data_dir().join("audit.log")) {
        Ok(t) => t,
        Err(_) => return Json(json!([])).into_response(),
    };
    let mut entries: Vec<Value> = text
        .trim()
        .split('\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let start = entries.len().saturating_sub(100);
    entries = entries.split_off(start);
    entries.reverse();
    Json(json!(entries)).into_response()
}

// ---------- 静态资源（rust-embed 内嵌 dist/） ----------

#[derive(rust_embed::RustEmbed)]
#[folder = "../dist"]
struct Dist;

async fn static_fallback(method: axum::http::Method, uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(path).decode_utf8_lossy().to_string();
    // Node: 只对 GET 且非 /api 路径做 SPA 回退
    if method != axum::http::Method::GET || path.starts_with("api/") || path == "api" || path == "ws" {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    if path.contains("..") {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let serve = |data: std::borrow::Cow<'static, [u8]>, mime: &str| -> Response {
        ([(header::CONTENT_TYPE, mime.to_string())], Body::from(data.to_vec())).into_response()
    };
    if path.is_empty() {
        if let Some(f) = Dist::get("index.html") {
            return serve(f.data, "text/html; charset=utf-8");
        }
        return err(StatusCode::NOT_FOUND, "dist not built");
    }
    if let Some(f) = Dist::get(&path) {
        let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
        return serve(f.data, &mime);
    }
    if let Some(f) = Dist::get("index.html") {
        return serve(f.data, "text/html; charset=utf-8");
    }
    err(StatusCode::NOT_FOUND, "not found")
}

pub fn router(st: App) -> Router {
    Router::new()
        .route("/api/workspace",get(crate::workspace::status).put(crate::workspace::configure))
        .route("/api/workspace/pick",post(crate::workspace::pick))
        .route("/api/workspace/files",get(crate::workspace::files))
        .route("/api/workspace/action",post(crate::workspace::action))
        .route("/api/workspace/upload",post(crate::workspace::upload))
        .route("/api/workspace/download",get(crate::workspace::download))
        .route("/api/storage/status",get(crate::storage::status))
        .route("/api/storage/retry",post(crate::storage::retry))
        .route("/api/open-external-url",post(open_external_url))
        .route("/api/mcp/call", post(mcp_call))
        .route("/api/mcp/config", get(mcp_config))
        .route("/api/mcp/test", post(mcp_test))
        .route("/api/ssh/host-keys", get(ssh_keys))
        .route("/api/ssh/trust", post(ssh_trust))
        .route("/api/agent/status", get(agent_status))
        .route("/api/memories",get(memories_list).post(memories_create))
        .route("/api/memories/batch",post(memories_batch))
        .route("/api/memories/{id}",axum::routing::put(memories_update).delete(memories_delete))
        .route("/api/hosts", get(hosts_list).post(hosts_create))
        .route("/api/hosts/{id}", axum::routing::put(hosts_update).delete(hosts_delete))
        .route("/api/settings", get(settings_get).put(settings_put))
        .route("/api/ai/test", post(ai_test))
        .route("/api/ai/chat-test", post(ai_chat_test))
        .route("/api/chats/{key}", get(chats_list))
        .route("/api/chats/{key}/delete", post(chats_delete_batch))
        .route("/api/chats/{key}/{chat_id}", get(chats_get).delete(chats_delete))
        .route("/api/export", post(export))
        .route("/api/import/preview", post(import_preview))
        .route("/api/import", post(import))
        .route("/api/fs/home", get(fs_home))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/mkdir", post(fs_mkdir))
        .route("/api/fs/newfile", post(fs_newfile))
        .route("/api/fs/delete", post(fs_delete))
        .route("/api/fs/trash", get(fs_trash_list))
        .route("/api/fs/trash/restore", post(fs_trash_restore))
        .route("/api/fs/trash/purge", post(fs_trash_purge))
        .route("/api/fs/rename", post(fs_rename))
        .route("/api/fs/paste", post(fs_paste))
        .route("/api/fs/stat", get(fs_stat))
        .route("/api/fs/read", get(fs_read))
        .route("/api/fs/write", post(fs_write))
        .route("/api/fs/upload-chunk", post(fs_upload_chunk))
        .route("/api/fs/upload", post(fs_upload))
        .route("/api/fs/download", get(fs_download))
        .route("/api/fs/compress", post(fs_compress))
        .route("/api/fs/extract", post(fs_extract))
        .route("/api/probe", get(probe))
        .route("/api/audit", get(audit))
        .route("/ws", get(crate::ws::ws_handler))
        .fallback(static_fallback)
        .layer(axum::extract::DefaultBodyLimit::max(220 * 1024 * 1024))
        .layer(axum::middleware::from_fn(crate::storage::guard))
        .with_state(st)
}
