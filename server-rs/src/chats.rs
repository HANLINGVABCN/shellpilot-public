// 对话记录持久化：按机器归类，存在 data/chats.json（对应 server/chats.js）
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::RwLock;

static CACHE: RwLock<Option<HashMap<String, Vec<Value>>>> = RwLock::new(None);

/// 确保缓存已从磁盘加载，并在写锁内执行变更
fn with_cache<T>(f: impl FnOnce(&mut HashMap<String, Vec<Value>>) -> T) -> T {
    // 快路径：已加载则直接拿写锁
    if let Ok(rd) = CACHE.read() {
        if rd.is_some() {
            drop(rd);
            let mut guard = CACHE.write().unwrap();
            if let Some(map) = guard.as_mut() {
                return f(map);
            }
        }
    }
    // 慢路径：从磁盘加载
    let loaded: HashMap<String, Vec<Value>> = crate::load_json_or("chats.json", json!({}))
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_array().cloned().unwrap_or_default()))
                .collect()
        })
        .unwrap_or_default();
    let mut guard = CACHE.write().unwrap();
    let map = guard.get_or_insert(loaded);
    f(map)
}

fn persist(cache: &HashMap<String, Vec<Value>>) {
    let v = serde_json::to_value(cache).unwrap_or_else(|_| json!({}));
    crate::save_json("chats.json", &v);
}

/// Node: listChats —— 按 updatedAt 倒序，只保留四个字段
pub fn list_chats(key: &str) -> Value {
    let list: Vec<Value> = with_cache(|cache| {
        (cache.get(key).cloned().unwrap_or_default())
            .into_iter()
            .map(|c| {
                json!({
                    "id": c.get("id").cloned().unwrap_or(json!(null)),
                    "title": c.get("title").cloned().unwrap_or(json!(null)),
                    "createdAt": c.get("createdAt").cloned().unwrap_or(json!(null)),
                    "updatedAt": c.get("updatedAt").cloned().unwrap_or(json!(null)),
                })
            })
            .collect()
    });
    let mut list = list;
    list.sort_by(|a, b| {
        let ua = a["updatedAt"].as_i64().unwrap_or(0);
        let ub = b["updatedAt"].as_i64().unwrap_or(0);
        ub.cmp(&ua)
    });
    json!(list)
}

pub fn get_chat(key: &str, chat_id: &str) -> Option<Value> {
    with_cache(|cache| {
        cache
            .get(key)?
            .iter()
            .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(chat_id))
            .cloned()
    })
}

pub fn create_chat(key: &str, title: &str) -> Value {
    let now = crate::now_ms();
    let chat = json!({
        "id": crate::rand_id("c"),
        "title": if title.is_empty() { "新对话" } else { title },
        "createdAt": now,
        "updatedAt": now,
        "messages": [],
    });
    with_cache(|cache| {
        let entry = cache.entry(key.to_string()).or_default();
        entry.insert(0, chat.clone());
        persist(cache);
    });
    chat
}

pub fn set_chat_messages(key: &str, chat_id: &str, messages: Vec<Value>) -> Option<Value> {
    let out = with_cache(|cache| {
        let entry = cache.get_mut(key)?;
        let idx = entry.iter().position(|c| c.get("id").and_then(|v| v.as_str()) == Some(chat_id))?;
        let chat = &mut entry[idx];
        chat["messages"] = json!(messages);
        chat["updatedAt"] = json!(crate::now_ms());
        // 兜底命名：标题还是占位时，用第一条用户消息
        let title = chat.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if title.is_empty() || title == "新对话" {
            let first = messages.iter().find(|m| {
                m.get("role").and_then(|v| v.as_str()) == Some("user")
                    && m.get("content").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false)
            });
            if let Some(first) = first {
                let text = first["content"].as_str().unwrap_or("").trim();
                let cut: String = text.chars().take(24).collect();
                chat["title"] = json!(cut);
            }
        }
        Some(chat.clone())
    });
    if out.is_some() {
        with_cache(|cache| persist(cache));
    }
    out
}

pub fn rename_chat(key: &str, chat_id: &str, title: &str) -> Option<Value> {
    let out = with_cache(|cache| {
        let entry = cache.get_mut(key)?;
        let idx = entry.iter().position(|c| c.get("id").and_then(|v| v.as_str()) == Some(chat_id))?;
        let cut: String = title.chars().take(40).collect();
        entry[idx]["title"] = json!(cut);
        Some(entry[idx].clone())
    });
    if out.is_some() {
        with_cache(|cache| persist(cache));
    }
    out
}

pub fn delete_chat(key: &str, chat_id: &str) {
    with_cache(|cache| {
        if let Some(entry) = cache.get_mut(key) {
            entry.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(chat_id));
            persist(cache);
        }
    });
}

/// Delete a snapshot of selected conversations with a single persistence operation.
pub fn delete_chats(key:&str,ids:&[String])->usize {
    let ids:std::collections::HashSet<&str>=ids.iter().map(String::as_str).collect();
    with_cache(|cache| {
        let Some(chats)=cache.get_mut(key) else {return 0;};
        let before=chats.len();
        chats.retain(|chat|!chat["id"].as_str().map(|id|ids.contains(id)).unwrap_or(false));
        let deleted=before-chats.len();
        if deleted>0 {persist(cache);}
        deleted
    })
}

pub fn delete_host_chats(key: &str) {
    with_cache(|cache| {
        if cache.remove(key).is_some() {
            persist(cache);
        }
    });
}

/// 导入配置后强制从磁盘重读（导入会直接改写 chats.json）
pub fn reload_chats() {
    *CACHE.write().unwrap() = None;
}
