// 数据目录与 JSON 持久化（对应 Node server/store.js）
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::RwLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static STORAGE_FAULT: RwLock<Option<String>> = RwLock::new(None);

pub fn storage_fault()->Option<String>{STORAGE_FAULT.read().unwrap().clone()}
pub fn clear_storage_fault(){*STORAGE_FAULT.write().unwrap()=None;}
fn storage_failed(message:String) {
    eprintln!("ShellPilot data: {message}");
    let mut fault=STORAGE_FAULT.write().unwrap();
    if fault.is_none(){*fault=Some(message);}
}
pub fn report_storage_error(message:String){storage_failed(message);}
fn read_json_file(path:&std::path::Path)->Result<Option<Value>,String> {
    let text=match std::fs::read_to_string(path){
        Ok(text)=>text,
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),
        Err(error)=>return Err(format!("读取 {} 失败：{error}",path.file_name().unwrap_or_default().to_string_lossy())),
    };
    let value:Value=serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error|format!("{} 的数据格式损坏：{error}",path.file_name().unwrap_or_default().to_string_lossy()))?;
    let name=path.file_name().unwrap_or_default().to_string_lossy();
    let shape=match name.as_ref(){
        "hosts.json"|"memories.json"|"forward-rules.json"=>value.is_array(),
        "settings.json"|"agent-jobs.json"|"trusted-host-keys.json"|"observed-host-keys.json"=>value.is_object(),
        "chats.json"=>value.as_object().is_some_and(|chats|chats.values().all(Value::is_array)),
        _=>true,
    };
    if !shape{return Err(format!("{name} 的数据结构不正确，原文件已保留"));}
    Ok(Some(value))
}
pub fn validate_storage()->Result<(),String> {
    let dir=data_dir();
    std::fs::create_dir_all(&dir).map_err(|error|format!("无法打开数据目录：{error}"))?;
    for entry in std::fs::read_dir(&dir).map_err(|error|format!("无法读取数据目录：{error}"))? {
        let entry=entry.map_err(|error|error.to_string())?;
        let path=entry.path();
        if path.extension().is_some_and(|e|e=="json")&&path.file_name().is_some_and(|n|n!="runtime.json"){
            read_json_file(&path)?;
        }
    }
    let probe=dir.join(format!(".shellpilot-access-{}",uuid::Uuid::new_v4().simple()));
    let check=(||{
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&probe)
            .map_err(|error|format!("数据目录不可写：{error}"))?;
        file.write_all(b"ShellPilot").and_then(|_|file.sync_all()).map_err(|error|error.to_string())?;
        drop(file);
        std::fs::remove_file(&probe).map_err(|error|error.to_string())
    })();
    let _=std::fs::remove_file(probe);
    check
}

/// Local diagnostics return counts and OS errors, never credentials or contents.
pub fn storage_observation()->Value{
    let dir=data_dir();
    let files=["hosts.json","settings.json","chats.json","memories.json","runtime.json"].into_iter().map(|name|{
        let path=dir.join(name);
        let metadata=std::fs::metadata(&path);
        let raw=std::fs::read(&path);
        let mut value=json!({"name":name,"path":path.to_string_lossy(),
            "metadataBytes":metadata.as_ref().ok().map(|m|m.len()),
            "metadataError":metadata.as_ref().err().map(|e|json!({"code":e.raw_os_error(),"message":e.to_string()}))});
        match raw{
            Ok(bytes)=>{
                use sha2::{Digest,Sha256};
                value["readBytes"]=json!(bytes.len());value["sha256"]=json!(format!("{:x}",Sha256::digest(&bytes)));
                let parsed=std::str::from_utf8(&bytes).map_err(|e|e.to_string()).and_then(|text|serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).map_err(|e|e.to_string()));
                match parsed{
                    Ok(data)=>{
                        value["recordCount"]=json!(data.as_array().map(Vec::len).or_else(||data.as_object().map(|o|o.len())));
                        if name=="settings.json"{value["providers"]=json!(data["providers"].as_array().map(Vec::len));value["models"]=json!(data["models"].as_array().map(Vec::len));}
                    },
                    Err(error)=>value["parseError"]=json!(error),
                }
            },
            Err(error)=>value["readError"]=json!({"code":error.raw_os_error(),"message":error.to_string()}),
        }
        value
    }).collect::<Vec<_>>();
    let listed=std::fs::read_dir(&dir).map(|entries|entries.filter_map(Result::ok).map(|e|e.file_name().to_string_lossy().to_string()).collect::<Vec<_>>());
    json!({"files":files,"listedFiles":listed.as_ref().ok(),"listError":listed.as_ref().err().map(|e|e.to_string()),"workingDirectory":std::env::current_dir().ok().map(|p|p.to_string_lossy().to_string()),"processId":std::process::id(),"executable":std::env::current_exe().ok().map(|p|p.to_string_lossy().to_string())})
}

pub fn init_data_dir(dir: PathBuf) {
    if let Err(error)=std::fs::create_dir_all(&dir){storage_failed(format!("无法创建数据目录：{error}"));}
    let _ = DATA_DIR.set(dir);
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("data"))
}

pub fn load_json(name: &str) -> Option<Value> {
    match read_json_file(&data_dir().join(name)){
        Ok(value)=>value,
        Err(error)=>{storage_failed(error);None}
    }
}

/// Node: loadJSON(name, fallback)
pub fn load_json_or(name: &str, fallback: Value) -> Value {
    load_json(name).unwrap_or(fallback)
}

/// Node: saveJSON —— JSON.stringify(value, null, 2)
pub fn save_json(name: &str, value: &Value) {
    if storage_fault().is_some()&&name!="runtime.json"{return;}
    let path=data_dir().join(name);
    let temp=path.with_extension(format!("json.{}.tmp",uuid::Uuid::new_v4().simple()));
    let result=(||->Result<(),String>{
        let pretty=serde_json::to_vec_pretty(value).map_err(|error|error.to_string())?;
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|error|error.to_string())?;
        file.write_all(&pretty).and_then(|_|file.sync_all()).map_err(|error|error.to_string())?;
        drop(file);
        std::fs::rename(&temp,&path).map_err(|error|error.to_string())
    })();
    let _=std::fs::remove_file(&temp);
    if let Err(error)=result{storage_failed(format!("保存 {name} 失败，原文件已保留：{error}"));}
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

#[cfg(test)]
mod data_tests{
    use super::*;
    #[test]fn invalid_and_bom_files_are_distinguished_from_first_use(){
        let dir=std::env::temp_dir().join(format!("shellpilot-json-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file=dir.join("hosts.json");
        assert!(read_json_file(&file).unwrap().is_none());
        std::fs::write(&file,"\u{feff}[{\"id\":\"demo\"}]").unwrap();
        assert_eq!(read_json_file(&file).unwrap().unwrap()[0]["id"],"demo");
        std::fs::write(&file,"{broken").unwrap();assert!(read_json_file(&file).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(),"{broken");
        std::fs::write(&file,"{}").unwrap();assert!(read_json_file(&file).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
