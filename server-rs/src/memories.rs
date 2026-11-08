//! Persistent user-controlled memory. Automatic capture and participation are independent.
use serde_json::{json, Value};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
fn read() -> Vec<Value> { crate::load_json_or("memories.json",json!([])).as_array().cloned().unwrap_or_default() }
fn write(memories:&[Value])->Result<(),String> {
    if let Some(error)=crate::storage_fault(){return Err(error);}
    let path=crate::data_dir().join("memories.json");
    let temp=path.with_extension("json.tmp");
    std::fs::write(&temp,serde_json::to_vec_pretty(memories).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    std::fs::rename(temp,path).map_err(|e|format!("保存记忆失败：{e}"))
}
fn normalized(text:&str)->String { text.split_whitespace().collect::<String>().to_lowercase() }
fn text(body:&Value,key:&str)->Result<String,String> {
    let text=body[key].as_str().unwrap_or("").trim();
    if text.is_empty() || text.chars().count()>2000 {return Err(format!("{key} 不能为空且最多2000字"));}
    Ok(text.into())
}
pub fn list()->Vec<Value> { let _lock=LOCK.lock().unwrap();read() }
pub fn enabled()->Vec<Value> {list().into_iter().filter(|memory|memory["enabled"].as_bool().unwrap_or(true)).collect()}
pub fn save(body:&Value,id:Option<&str>,automatic:bool)->Result<Value,String> {
    if automatic && !crate::get_settings()["autoMemory"].as_bool().unwrap_or(true) {return Err("自动记忆已关闭，已有启用记忆仍参与回答".into());}
    let topic=text(body,"topic")?;let content=text(body,"content")?;
    if automatic && (content.contains("PRIVATE KEY") || regex::Regex::new(r"(?i)(?:sk-[A-Za-z0-9_-]{12,}|(?:password|api[_ -]?key|token|密码|令牌)\s*[:=：]\s*\S+)").unwrap().is_match(&content)) {
        return Err("自动记忆不能保存密码、密钥或令牌".into());
    }
    let _lock=LOCK.lock().unwrap();let mut memories=read();
    if memories.iter().any(|memory|id!=memory["id"].as_str() && normalized(memory["topic"].as_str().unwrap_or(""))==normalized(&topic)) && id.is_some(){return Err("已有相同主题的另一条记忆，请编辑原记录".into());}
    if let Some(existing)=memories.iter().find(|memory|normalized(memory["content"].as_str().unwrap_or(""))==normalized(&content) && id!=memory["id"].as_str()) {
        return Ok(json!({"memory":existing,"status":"duplicate","message":"已有相同记忆，未重复添加或重新启用"}));
    }
    let index=if let Some(id)=id {
        Some(memories.iter().position(|memory|memory["id"].as_str()==Some(id)).ok_or("记忆不存在")?)
    }else{memories.iter().position(|memory|normalized(memory["topic"].as_str().unwrap_or(""))==normalized(&topic))};
    let now=crate::now_ms();
    let memory=if let Some(index)=index {
        let old=&memories[index];
        if automatic && (old["source"]=="manual" || old["enabled"]==false) {
            return Ok(json!({"memory":old,"status":"protected","message":"手动维护或已停用的记忆不可被 AI 自动覆盖"}));
        }
        if id.is_none() && !automatic {return Err("已有同主题记忆，请编辑原记忆，避免矛盾".into());}
        if let Some(expected)=body["expectedUpdatedAt"].as_i64() {
            if old["updatedAt"].as_i64()!=Some(expected) {return Err("记忆已被其他页面修改，请刷新后再编辑".into());}
        }
        let mut memory=old.clone();memory["topic"]=json!(topic);memory["content"]=json!(content);
        memory["updatedAt"]=json!(now.max(old["updatedAt"].as_i64().unwrap_or(0)+1));
        if !automatic {memory["source"]=json!("manual");}
        if let Some(enabled)=body["enabled"].as_bool(){memory["enabled"]=json!(enabled);}
        memories[index]=memory.clone();memory
    }else{
        let memory=json!({"id":crate::rand_id("mem"),"topic":topic,"content":content,
            "enabled":body["enabled"].as_bool().unwrap_or(true),"source":if automatic{"ai"}else{"manual"},"createdAt":now,"updatedAt":now});
        memories.insert(0,memory.clone());memory
    };
    write(&memories)?;Ok(json!({"memory":memory,"status":"saved"}))
}
pub fn change(ids:&[String],enabled:Option<bool>)->Result<usize,String> {
    let _lock=LOCK.lock().unwrap();let mut memories=read();let mut changed=0;
    if let Some(enabled)=enabled {
        for memory in &mut memories {if ids.iter().any(|id|memory["id"].as_str()==Some(id)) {memory["enabled"]=json!(enabled);memory["updatedAt"]=json!(crate::now_ms().max(memory["updatedAt"].as_i64().unwrap_or(0)+1));changed+=1;}}
    }else{let count=memories.len();memories.retain(|memory|!ids.iter().any(|id|memory["id"].as_str()==Some(id)));changed=count-memories.len();}
    write(&memories)?;Ok(changed)
}

pub fn import_records(incoming:&Value,overwrite:bool)->Result<(),String>{
    let Some(records)=incoming.as_array()else{return Err("记忆备份必须是数组".into());};
    for record in records {text(record,"topic")?;text(record,"content")?;}
    let _lock=LOCK.lock().unwrap();let mut memories=if overwrite{Vec::new()}else{read()};
    for record in records{
        if memories.iter().any(|memory|normalized(memory["topic"].as_str().unwrap_or(""))==normalized(record["topic"].as_str().unwrap_or("")) || normalized(memory["content"].as_str().unwrap_or(""))==normalized(record["content"].as_str().unwrap_or(""))){continue;}
        let mut record=record.clone();record["id"]=json!(crate::rand_id("mem"));memories.push(record);
    }
    write(&memories)
}
pub fn schema()->Value {json!({"type":"function","function":{"name":"remember_memory","description":"记住用户明确表达的长期偏好或稳定信息。topic 使用简短稳定主题。同主题 AI 记忆会更新，不能覆盖手动或停用记忆；不记密码、令牌、临时任务、工具输出。","parameters":{"type":"object","properties":{"topic":{"type":"string"},"content":{"type":"string"}},"required":["topic","content"],"additionalProperties":false}}})}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_memory_content_detects_exact_duplicates(){assert_eq!(normalized("回复 简短"),normalized("回复简短"));}
}
