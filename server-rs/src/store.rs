// 数据目录与 JSON 持久化（对应 Node server/store.js）
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_data_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DATA_DIR.set(dir);
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("data"))
}

pub fn load_json(name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(data_dir().join(name)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Node: loadJSON(name, fallback)
pub fn load_json_or(name: &str, fallback: Value) -> Value {
    load_json(name).unwrap_or(fallback)
}

/// Node: saveJSON —— JSON.stringify(value, null, 2)
pub fn save_json(name: &str, value: &Value) {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into());
    if let Ok(mut f) = std::fs::File::create(data_dir().join(name)) {
        let _ = f.write_all(pretty.as_bytes());
    }
}

/// Node: appendAudit —— 一行一条 JSON，失败静默
pub fn append_audit(entry: Value) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir().join("audit.log"))
    {
        let _ = writeln!(f, "{entry}");
    }
}

pub fn default_settings() -> Value {
    serde_json::json!({
        "providers": [],
        "models": [],
        "defaultModelId": null,
        "approverModelId": null,
        "titleModelId": null,
        "autoMemory": true,
        "mcpEnabled": false,
        "mcpReadOnly": true,
        "mcpHostIds": null,
        "mcpApprovalMode": "ask",
        "params": {
            "temperature": 0.3,
            "maxTokens": 0,
            "historyLimit": 0,
            "maxSteps": 0,
            "contextChars": 0
        },
        "systemPrompt": "你是 ShellPilot，一个严谨的 Linux VPS 运维助手。用简体中文回答，回答简洁、直接给出可执行的方案。执行任何命令前，先用一句话说明目的。优先使用只读命令诊断问题；修改配置、重启服务、删除文件等有风险的操作，必须先向用户确认再执行。"
    })
}

/// Node: getSettings —— defaults 与磁盘配置浅合并，params 一层深合并
pub fn get_settings() -> Value {
    let mut out = match load_json("settings.json") {
        Some(s) => {
            let mut merged = default_settings();
            if let (Some(dst), Some(src)) = (merged.as_object_mut(), s.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            let params = default_settings()["params"].clone();
            let saved_params = s.get("params").cloned().unwrap_or_else(|| json!({}));
            let mut merged_params = params;
            if let (Some(dst), Some(src)) = (merged_params.as_object_mut(), saved_params.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            if let Some(dst) = merged.as_object_mut() {
                dst.insert("params".into(), merged_params);
            }
            merged
        }
        None => default_settings(),
    };
    if !out.is_object() {
        out = default_settings();
    }
    upgrade_ai_budgets(&mut out);
    out
}

fn upgrade_ai_budgets(settings:&mut Value) {
    if settings["aiBudgetVersion"].as_u64().unwrap_or(0)>=3 {return;}
    for (key,old,recent) in [("maxTokens",2048,8192),("historyLimit",12,30),("maxSteps",20,60),("contextChars",60000,200000)] {
        if [Some(old),Some(recent)].contains(&settings["params"][key].as_i64()) {settings["params"][key]=json!(0);}
    }
    settings["aiBudgetVersion"]=json!(3);
}

pub fn save_settings(s: &Value) {
    save_json("settings.json", s);
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn upgrade_legacy_defaults_but_preserve_custom_and_new_preferences() {
        let mut settings=json!({"params":{"maxTokens":2048,"historyLimit":12,"maxSteps":20,"contextChars":60000,"temperature":0.3}});
        upgrade_ai_budgets(&mut settings);
        assert_eq!(settings["params"]["maxTokens"],0);assert_eq!(settings["params"]["maxSteps"],0);
        settings["params"]["maxTokens"]=json!(2048);upgrade_ai_budgets(&mut settings);
        assert_eq!(settings["params"]["maxTokens"],2048);
        let mut customized=json!({"params":{"maxTokens":16000,"historyLimit":50,"maxSteps":80,"contextChars":300000}});
        upgrade_ai_budgets(&mut customized);assert_eq!(customized["params"]["maxTokens"],16000);
    }
}

/// 读取设置里的某个键（对象形式）
pub fn settings_obj() -> Map<String, Value> {
    get_settings().as_object().cloned().unwrap_or_default()
}
