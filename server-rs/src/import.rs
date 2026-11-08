// 导入数据的校验与合并（对应 server/import.js，错误消息与语义逐条对齐测试契约）
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const GLOBAL_KEY: &str = "__global__";
pub const MODEL_KEYS: &[&str] = &["defaultModelId", "approverModelId", "titleModelId"];

fn is_object(v: &Value) -> bool {
    v.is_object()
}

fn valid_id(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    let ok_chars = !s.is_empty()
        && s.len() <= 200
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok_chars && !["__proto__", "prototype", "constructor"].contains(&s)
}

fn require_text(v: &Value, label: &str) -> Result<(), String> {
    match v.as_str() {
        Some(s) if !s.trim().is_empty() => Ok(()),
        _ => Err(format!("{label}格式错误")),
    }
}

/// 校验并整理记录数组：undefined→空；非数组或含坏 ID→错误
fn records(value: Option<&Value>, label: &str) -> Result<Vec<Value>, String> {
    let Some(v) = value else { return Ok(Vec::new()) };
    let Some(arr) = v.as_array() else {
        return Err(format!("{label}必须是数组"));
    };
    let mut ids = HashSet::new();
    for record in arr {
        if !is_object(record)
            || !valid_id(record.get("id").unwrap_or(&Value::Null))
            || record.get("id").and_then(|x| x.as_str()) == Some(GLOBAL_KEY)
            || !ids.insert(record.get("id").cloned().unwrap_or(Value::Null))
        {
            return Err(format!("{label}包含无效或重复的 ID"));
        }
    }
    Ok(arr.clone())
}

/// JS 真值判断（null/undefined/空串/0/NaN/false → 假）
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && f.is_finite()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub struct Validated {
    pub hosts: Vec<Value>,
    pub settings: Value,
    pub chats: Value,
}

/// Node: validateImportData —— 完整检查通过才返回净化后的克隆
pub fn validate_import_data(value: &Value) -> Result<Validated, String> {
    if !is_object(value) {
        return Err("备份内容必须是对象".into());
    }
    if let Some(memories)=value.get("memories") {
        let Some(memories)=memories.as_array()else{return Err("记忆备份必须是数组".into());};
        for memory in memories {
            if !memory.is_object() || memory["topic"].as_str().map(|text|text.trim().is_empty()||text.chars().count()>2000).unwrap_or(true)
                || memory["content"].as_str().map(|text|text.trim().is_empty()||text.chars().count()>2000).unwrap_or(true) {return Err("记忆备份格式错误".into());}
        }
    }
    if let Some(v) = value.get("version") {
        if v != &json!(1) {
            return Err("不支持的备份版本".into());
        }
    }
    let mut data = value.clone();

    let hosts_arr = data.get_mut("hosts").map(|v| v.take());
    let mut hosts = records(hosts_arr.as_ref(), "机器列表")?;
    for host in hosts.iter_mut() {
        let obj = host.as_object_mut().unwrap();
        for key in ["name", "host", "username"] {
            require_text(obj.get(key).unwrap_or(&Value::Null), &format!("机器 {key}"))?;
        }
        let port_raw = obj.get("port").cloned().unwrap_or(json!(22));
        let port = crate::js_number(&port_raw).unwrap_or(f64::NAN);
        if !(port.fract() == 0.0 && port.is_finite()) || port < 1.0 || port > 65535.0 {
            return Err("机器端口不合法".into());
        }
        obj.insert("port".into(), json!(port as i64));
        let jump = obj.get("jumpHostId").cloned().unwrap_or(Value::Null);
        let jump_truthy = js_truthy(&jump);
        if jump_truthy && !valid_id(&jump) {
            return Err("跳板机 ID 不合法".into());
        }
        for key in ["password", "passphrase", "keyContent", "keyPath", "group", "jumpHostId"] {
            if let Some(v) = obj.get(key) {
                if v.as_str().is_none() {
                    return Err(format!("机器 {key}格式错误"));
                }
            }
        }
        if let Some(at) = obj.get("authType") {
            if !["password", "key"].contains(&at.as_str().unwrap_or("")) {
                return Err("认证类型不合法".into());
            }
        }
    }

    let mut settings = data.get_mut("settings").map(|v| v.take()).unwrap_or_else(|| json!({}));
    if !is_object(&settings) {
        return Err("AI 配置格式错误".into());
    }
    let sobj = settings.as_object_mut().unwrap();
    let providers_val = sobj.get_mut("providers").map(|v| v.take());
    let providers = records(providers_val.as_ref(), "服务商列表")?;
    let models_val = sobj.get_mut("models").map(|v| v.take());
    let models = records(models_val.as_ref(), "模型列表")?;
    sobj.insert("providers".into(), json!(providers));
    sobj.insert("models".into(), json!(models));

    let provider_ids: HashSet<&str> = providers
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()))
        .collect();
    for provider in providers.iter() {
        require_text(provider.get("name").unwrap_or(&Value::Null), "服务商名称")?;
        require_text(provider.get("baseURL").unwrap_or(&Value::Null), "服务商地址")?;
        if let Some(k) = provider.get("apiKey") {
            if k.as_str().is_none() {
                return Err("API Key 格式错误".into());
            }
        }
    }
    for model in models.iter() {
        require_text(model.get("name").unwrap_or(&Value::Null), "模型名称")?;
        let pid = model.get("providerId").and_then(|v| v.as_str()).unwrap_or("");
        if !provider_ids.contains(pid) {
            return Err("模型关联的服务商不存在".into());
        }
    }
    for key in MODEL_KEYS {
        if let Some(v) = sobj.get(*key) {
            if !v.is_null() && !valid_id(v) {
                return Err("模型选择格式错误".into());
            }
        }
    }
    if let Some(p) = sobj.get("params") {
        if !is_object(p) {
            return Err("模型参数格式错误".into());
        }
    }
    if let Some(p) = sobj.get("systemPrompt") {
        if p.as_str().is_none() {
            return Err("系统提示词格式错误".into());
        }
    }

    let mut chats = data.get_mut("chats").map(|v| v.take()).unwrap_or_else(|| json!({}));
    if !is_object(&chats) {
        return Err("对话记录格式错误".into());
    }
    for (key, list) in chats.as_object().unwrap() {
        if !valid_id(&json!(key)) || !list.is_array() {
            return Err("对话分组格式错误".into());
        }
        for chat in list.as_array().unwrap() {
            let bad = !is_object(chat)
                || !valid_id(chat.get("id").unwrap_or(&Value::Null))
                || chat.get("messages").map(|m| !m.is_array()).unwrap_or(true)
                || chat
                    .get("title")
                    .map(|t| t.as_str().is_none())
                    .unwrap_or(false)
                // title 只在键存在时才校验（undefined 合法，null 报错）
                || chat
                    .get("messages")
                    .and_then(|m| m.as_array())
                    .map(|msgs| {
                        msgs.iter().any(|m| {
                            !is_object(m)
                                || !["system", "user", "assistant", "tool"]
                                    .contains(&m.get("role").and_then(|v| v.as_str()).unwrap_or(""))
                        })
                    })
                    .unwrap_or(true);
            if bad {
                return Err("对话内容格式错误".into());
            }
        }
    }

    Ok(Validated { hosts, settings, chats })
}

fn selection(
    ids: Option<&Value>,
    available: &HashSet<String>,
    label: &str,
) -> Result<Option<HashSet<String>>, String> {
    let Some(v) = ids else { return Ok(None) };
    let Some(arr) = v.as_array() else {
        return Err(format!("所选{label}不在备份中"));
    };
    let mut set = HashSet::new();
    for id in arr {
        let Some(s) = id.as_str() else {
            return Err(format!("所选{label}不在备份中"));
        };
        if !available.contains(s) {
            return Err(format!("所选{label}不在备份中"));
        }
        set.insert(s.to_string());
    }
    Ok(Some(set))
}

/// Node: hostKey —— JSON.stringify([host小写, port, username])
fn host_key(host: &Value) -> String {
    let addr = host.get("host").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    let port = host.get("port").cloned().unwrap_or(json!(22));
    let user = host.get("username").cloned().unwrap_or(Value::Null);
    json!([addr, port, user]).to_string()
}

/// Node: providerKey —— baseURL trim 后去尾部斜杠
fn provider_key(provider: &Value) -> String {
    provider
        .get("baseURL")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn fresh_id(prefix: &str, used: &HashSet<String>) -> String {
    loop {
        let id = format!("{}_{}", prefix, uuid::Uuid::new_v4());
        if !used.contains(&id) {
            return id;
        }
    }
}

fn check_jump_hosts(hosts: &[Value]) -> Result<(), String> {
    let by_id: HashMap<&str, &Value> = hosts
        .iter()
        .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(|id| (id, h)))
        .collect();
    let mut done = HashSet::new();
    for host in hosts {
        let mut seen = HashSet::new();
        let mut id = host.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        while !id.is_empty() && !done.contains(&id) {
            if seen.contains(&id) {
                return Err("跳板机配置存在循环引用".into());
            }
            seen.insert(id.clone());
            let Some(current) = by_id.get(id.as_str()) else {
                return Err("跳板机不存在，请一并勾选对应的跳板机".into());
            };
            id = current
                .get("jumpHostId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
        done.extend(seen);
    }
    Ok(())
}

fn merge_records(base: Option<&Value>, source: &Value, id: &str) -> Value {
    let mut out = Map::new();
    if let Some(b) = base.and_then(|v| v.as_object()) {
        for (k, v) in b {
            out.insert(k.clone(), v.clone());
        }
    }
    if let Some(s) = source.as_object() {
        for (k, v) in s {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("id".into(), json!(id));
    Value::Object(out)
}

pub struct ImportOptions {
    pub host_ids: Option<Value>,
    pub provider_ids: Option<Value>,
    pub mode: Option<String>,
}

/// Node: prepareImport —— 纯数据变换，不改磁盘
pub fn prepare_import(
    current_value: &Value,
    incoming_value: &Value,
    options: ImportOptions,
) -> Result<Value, String> {
    let incoming = validate_import_data(incoming_value)?;
    let current = validate_import_data(current_value)?;
    if let Some(m) = &options.mode {
        if m != "merge" && m != "overwrite" {
            return Err("导入模式不合法".into());
        }
    }
    let overwrite = options.mode.as_deref() == Some("overwrite");
    let incoming_host_ids: HashSet<String> = incoming
        .hosts
        .iter()
        .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let want_hosts = selection(
        options.host_ids.as_ref(),
        &incoming_host_ids,
        "机器",
    )?;
    let incoming_provider_ids: HashSet<String> = incoming
        .settings
        .get("providers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let want_providers = selection(
        options.provider_ids.as_ref(),
        &incoming_provider_ids,
        "服务商",
    )?;

    let selected_hosts: Vec<Value> = incoming
        .hosts
        .iter()
        .filter(|h| {
            want_hosts
                .as_ref()
                .map(|w| h.get("id").and_then(|v| v.as_str()).map(|s| w.contains(s)).unwrap_or(false))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    let selected_providers: Vec<Value> = incoming
        .settings
        .get("providers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|p| {
                    want_providers
                        .as_ref()
                        .map(|w| p.get("id").and_then(|v| v.as_str()).map(|s| w.contains(s)).unwrap_or(false))
                        .unwrap_or(true)
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut hosts: Vec<Value> = if overwrite { Vec::new() } else { current.hosts.clone() };
    let mut settings: Map<String, Value> = if overwrite {
        incoming.settings.as_object().cloned().unwrap_or_default()
    } else {
        let mut merged = incoming.settings.as_object().cloned().unwrap_or_default();
        for (k, v) in current.settings.as_object().iter().flat_map(|c| c.iter()) {
            merged.insert(k.clone(), v.clone());
        }
        merged
    };
    let mut providers: Vec<Value> = if overwrite {
        Vec::new()
    } else {
        current
            .settings
            .get("providers")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let mut models: Vec<Value> = if overwrite {
        Vec::new()
    } else {
        current
            .settings
            .get("models")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let mut chats: Map<String, Value> = if overwrite {
        Map::new()
    } else {
        current.chats.as_object().cloned().unwrap_or_default()
    };

    let mut host_map: HashMap<String, String> = HashMap::new();
    let mut model_map: HashMap<String, String> = HashMap::new();
    let mut used_hosts: HashSet<String> = hosts
        .iter()
        .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let mut used_providers: HashSet<String> = providers
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let mut used_models: HashSet<String> = models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    for source in selected_hosts.iter() {
        let src_key = host_key(source);
        let index = hosts.iter().position(|h| host_key(h) == src_key);
        let id = match index {
            Some(i) => hosts[i].get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            None => {
                let sid = source.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if used_hosts.contains(sid) {
                    fresh_id("h", &used_hosts)
                } else {
                    sid.to_string()
                }
            }
        };
        host_map.insert(
            source.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            id.clone(),
        );
        used_hosts.insert(id.clone());
        let record = merge_records(index.map(|i| &hosts[i]), source, &id);
        match index {
            Some(i) => hosts[i] = record,
            None => hosts.push(record),
        }
    }

    // 跳板机引用跟随重映射后的 ID
    let imported_hosts: HashMap<String, &Value> = incoming
        .hosts
        .iter()
        .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(|id| (id.to_string(), h)))
        .collect();
    for source in selected_hosts.iter() {
        let jump_ref = source.get("jumpHostId").and_then(|v| v.as_str()).unwrap_or("");
        if jump_ref.is_empty() {
            continue;
        }
        let source_id = source.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let jump_id: Option<String> = if let Some(mapped) = host_map.get(jump_ref) {
            Some(mapped.clone())
        } else if let Some(source_jump) = imported_hosts.get(jump_ref) {
            let sjk = host_key(source_jump);
            hosts.iter().find(|h| host_key(h) == sjk).and_then(|h| {
                h.get("id").and_then(|v| v.as_str()).map(String::from)
            })
        } else {
            hosts.iter().find(|h| h.get("id").and_then(|v| v.as_str()) == Some(jump_ref)).and_then(|h| {
                h.get("id").and_then(|v| v.as_str()).map(String::from)
            })
        };
        let Some(jump_id) = jump_id else {
            let name = source.get("name").and_then(|v| v.as_str()).unwrap_or("");
            return Err(format!("机器「{name}」的跳板机未导入，请一并勾选跳板机"));
        };
        let target_id = host_map.get(source_id).cloned().unwrap_or_default();
        if let Some(target) = hosts
            .iter_mut()
            .find(|h| h.get("id").and_then(|v| v.as_str()) == Some(target_id.as_str()))
        {
            if let Some(obj) = target.as_object_mut() {
                obj.insert("jumpHostId".into(), json!(jump_id));
            }
        }
    }
    check_jump_hosts(&hosts)?;

    for source in selected_providers.iter() {
        let src_key = provider_key(source);
        let index = providers.iter().position(|p| provider_key(p) == src_key);
        let id = match index {
            Some(i) => providers[i].get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            None => {
                let sid = source.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if used_providers.contains(sid) {
                    fresh_id("p", &used_providers)
                } else {
                    sid.to_string()
                }
            }
        };
        used_providers.insert(id.clone());
        let record = merge_records(index.map(|i| &providers[i]), source, &id);
        match index {
            Some(i) => providers[i] = record,
            None => providers.push(record),
        }
        let previous: Vec<Value> = models
            .iter()
            .filter(|m| m.get("providerId").and_then(|v| v.as_str()) == Some(id.as_str()))
            .cloned()
            .collect();
        models.retain(|m| m.get("providerId").and_then(|v| v.as_str()) != Some(id.as_str()));
        let source_id = source.get("id").and_then(|v| v.as_str()).unwrap_or("");
        for model in incoming
            .settings
            .get("models")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter(|m| m.get("providerId").and_then(|v| v.as_str()) == Some(source_id))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
        {
            let model_name = model.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let matched = previous
                .iter()
                .find(|m| m.get("name").and_then(|v| v.as_str()) == Some(model_name));
            let model_id = match matched {
                Some(m) => m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                None => {
                    let mid = model.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if used_models.contains(mid) {
                        fresh_id("m", &used_models)
                    } else {
                        mid.to_string()
                    }
                }
            };
            used_models.insert(model_id.clone());
            model_map.insert(
                model.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                model_id.clone(),
            );
            let merged = {
                let mut obj = Map::new();
                if let Some(m) = matched.and_then(|v| v.as_object()) {
                    for (k, v) in m {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                if let Some(m) = model.as_object() {
                    for (k, v) in m {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                obj.insert("id".into(), json!(model_id));
                obj.insert("providerId".into(), json!(id));
                Value::Object(obj)
            };
            models.push(merged);
        }
    }
    settings.insert("providers".into(), json!(providers));
    settings.insert("models".into(), json!(models));

    let model_ids: HashSet<&str> = models
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
        .collect();
    for key in MODEL_KEYS {
        let existing = if !overwrite {
            current.settings.get(*key).cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let imported = incoming
            .settings
            .get(*key)
            .and_then(|v| v.as_str())
            .and_then(|s| model_map.get(s))
            .cloned()
            .unwrap_or_default();
        let existing_ok = existing.as_str().map(|s| model_ids.contains(s)).unwrap_or(false);
        let imported_ok = !imported.is_empty() && model_ids.contains(imported.as_str());
        let chosen = if existing_ok {
            existing
        } else if imported_ok {
            json!(imported)
        } else if *key == "defaultModelId" {
            models
                .first()
                .and_then(|m| m.get("id"))
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        settings.insert(key.to_string(), chosen);
    }

    for (source_id, list) in incoming.chats.as_object().unwrap().iter() {
        let target_id = if source_id == GLOBAL_KEY {
            GLOBAL_KEY.to_string()
        } else {
            match host_map.get(source_id) {
                Some(t) => t.clone(),
                None => continue, // 未勾选机器的对话不导入
            }
        };
        let merged = chats.get(&target_id).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut ids: HashSet<String> = merged
            .iter()
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        let mut merged = merged;
        for chat in list.as_array().unwrap() {
            let cid = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if ids.contains(cid) {
                continue;
            }
            ids.insert(cid.to_string());
            merged.push(chat.clone());
        }
        chats.insert(target_id, json!(merged));
    }

    Ok(json!({
        "hosts": hosts,
        "settings": Value::Object(settings),
        "chats": Value::Object(chats),
    }))
}
