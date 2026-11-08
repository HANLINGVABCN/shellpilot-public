use crate::AppState;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64,Ordering};
static STATE_REVISION:AtomicU64=AtomicU64::new(1);

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Job {pub id:String,pub text:String,pub chat_id:String,pub scope:Vec<String>,pub mode:String,pub effort:String,pub model_id:Option<String>,pub created_at:i64}
pub fn persist(agent:&crate::AgentState) {
    crate::save_json("agent-jobs.json",&json!({"queue":agent.queue,"active":agent.active_job,"paused":agent.paused}));
}
pub fn status(agent:&crate::AgentState)->Value {json!({"type":"chat-job-state","processId":std::process::id(),"revision":STATE_REVISION.fetch_add(1,Ordering::SeqCst),"busy":agent.busy||agent.active_job.is_some(),"paused":agent.paused,"pauseReady":agent.pause_ready,"queue":agent.queue,"activeId":agent.active_job.as_ref().map(|job|&job.id),"chatId":agent.chat_id})}
pub fn repair_history(messages:Vec<Value>)->Vec<Value>{
    let mut output=Vec::new();let mut index=0;
    while index<messages.len(){
        let message=&messages[index];output.push(message.clone());index+=1;
        if message["role"]!="assistant"{continue;}
        let Some(calls)=message["tool_calls"].as_array()else{continue;};
        let mut completed=std::collections::HashSet::new();
        while index<messages.len() && messages[index]["role"]=="tool" {
            if let Some(id)=messages[index]["tool_call_id"].as_str(){completed.insert(id.to_string());}
            output.push(messages[index].clone());index+=1;
        }
        for call in calls{
            if !completed.contains(call["id"].as_str().unwrap_or("")){
                output.push(json!({"role":"tool","tool_call_id":call["id"],"content":"上次任务中断，此工具结果未保存；不要假定操作未执行，请先检查实际状态。"}));
            }
        }
    }
    output
}
pub async fn broadcast(st:&Arc<AppState>){let agent=st.agent.lock().await;let event=status(&agent);drop(agent);st.broadcast_all(&event);}
pub async fn checkpoint(st:&Arc<AppState>)->Result<(),String>{
    checkpoint_with(st,0).await
}
pub async fn checkpoint_with(st:&Arc<AppState>,waiting_tools:usize)->Result<(),String>{
    let mut signal={let agent=st.agent.lock().await;agent.pause_signal.subscribe()};
    loop {
        let mut agent=st.agent.lock().await;
        if !agent.paused {agent.pause_ready=false;return Ok(());}
        let ready=st.tool_operations.load(std::sync::atomic::Ordering::SeqCst)<=waiting_tools;
        let changed=agent.pause_ready!=ready;agent.pause_ready=ready;let event=status(&agent);drop(agent);
        if changed {st.broadcast_all(&event);}
        let _=tokio::time::timeout(std::time::Duration::from_millis(100),signal.changed()).await;
    }
}
pub struct ToolFlight(pub Arc<AppState>);
impl ToolFlight {pub fn new(st:&Arc<AppState>)->Self{st.tool_operations.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Self(st.clone())}}
impl Drop for ToolFlight{fn drop(&mut self){self.0.tool_operations.fetch_sub(1,std::sync::atomic::Ordering::SeqCst);}}
pub async fn submit(st:&Arc<AppState>,body:&Value)->Result<String,String>{
    let text=body["text"].as_str().unwrap_or("").trim().to_string();if text.is_empty(){return Err("消息不能为空".into());}
    let mut agent=st.agent.lock().await;
    if agent.chat_id.is_none(){let title=text.chars().take(24).collect::<String>();let chat=crate::chats::create_chat(crate::CHAT_KEY,&title);agent.chat_id=chat["id"].as_str().map(String::from);}
    let mode=body["mode"].as_str().filter(|mode|["ask","ai","auto","full"].contains(mode)).unwrap_or(&agent.approval_mode).to_string();
    let effort=body["effort"].as_str().filter(|effort|["off","minimal","low","medium","high"].contains(effort)).unwrap_or(&agent.reasoning_effort).to_string();
    let job=Job{id:crate::rand_id("job"),text,chat_id:agent.chat_id.clone().unwrap(),scope:agent.scope.clone(),mode,effort,
        model_id:crate::get_settings()["defaultModelId"].as_str().map(String::from),created_at:crate::now_ms()};
    let id=job.id.clone();agent.queue.push_back(job);persist(&agent);drop(agent);broadcast(st).await;kick(st).await;Ok(id)
}
pub async fn kick(st:&Arc<AppState>){
    let mut agent=st.agent.lock().await;
    if agent.worker_running || agent.paused || agent.queue.is_empty(){return;}
    agent.worker_running=true;agent.busy=true;drop(agent);
    let st=st.clone();tokio::spawn(async move{worker(st).await;});
}
async fn worker(st:Arc<AppState>){
    loop {
        let job={
            let mut agent=st.agent.lock().await;
            if agent.paused || agent.queue.is_empty(){agent.worker_running=false;agent.busy=false;agent.pause_ready=agent.paused;persist(&agent);let event=status(&agent);drop(agent);st.broadcast_all(&event);return;}
            let job=agent.queue.pop_front().unwrap();
            agent.chat_id=Some(job.chat_id.clone());
            agent.messages=repair_history(crate::chats::get_chat(crate::CHAT_KEY,&job.chat_id).and_then(|chat|chat["messages"].as_array().cloned()).unwrap_or_default());
            agent.approval_mode=job.mode.clone();agent.reasoning_effort=job.effort.clone();agent.cancel=Some(tokio::sync::watch::channel(false).0);
            agent.active_job=Some(job.clone());agent.busy=true;agent.pause_ready=false;persist(&agent);job
        };
        broadcast(&st).await;
        let title=crate::chats::get_chat(crate::CHAT_KEY,&job.chat_id).map(|chat|chat["title"].clone()).unwrap_or(json!("对话"));
        st.broadcast_all(&json!({"type":"chat-meta","chatId":job.chat_id,"title":title}));
        crate::agent::run_agent(st.clone(),job.text).await;
        let mut agent=st.agent.lock().await;agent.active_job=None;agent.pause_ready=false;persist(&agent);drop(agent);
    }
}
pub async fn pause(st:&Arc<AppState>,paused:bool){
    let mut agent=st.agent.lock().await;agent.paused=paused;agent.pause_ready=paused && agent.active_job.is_none();agent.pause_signal.send_replace(paused);persist(&agent);drop(agent);
    broadcast(st).await;if !paused{kick(st).await;}
}
pub async fn edit(st:&Arc<AppState>,id:&str,text:Option<&str>)->Result<(),String>{
    let mut agent=st.agent.lock().await;
    let index=agent.queue.iter().position(|job|job.id==id).ok_or("排队消息不存在或已开始执行")?;
    if let Some(text)=text{if text.trim().is_empty(){return Err("消息不能为空".into());}agent.queue[index].text=text.trim().into();}
    else {agent.queue.remove(index);}
    persist(&agent);drop(agent);broadcast(st).await;Ok(())
}
pub async fn take(st:&Arc<AppState>,id:&str)->Result<Job,String>{
    let mut agent=st.agent.lock().await;
    let index=agent.queue.iter().position(|job|job.id==id).ok_or("这条消息已经开始执行，不能取回")?;
    let job=agent.queue.remove(index).unwrap();
    persist(&agent);drop(agent);broadcast(st).await;Ok(job)
}
pub async fn restore(st:&Arc<AppState>){
    let saved=crate::load_json_or("agent-jobs.json",json!({}));let mut agent=st.agent.lock().await;
    agent.queue=serde_json::from_value(saved["queue"].clone()).unwrap_or_default();
    if let Ok(job)=serde_json::from_value::<Job>(saved["active"].clone()){
        // Preserve interrupted work as an explicit queued continuation, never replay it silently.
        agent.queue.push_front(Job{text:format!("上次任务因应用退出中断。先检查已完成操作及实际状态，不要重复修改，再继续任务：{}",job.text),..job});
    }
    agent.queue.retain(|job|crate::chats::get_chat(crate::CHAT_KEY,&job.chat_id).is_some());
    if !agent.queue.is_empty(){agent.paused=true;agent.pause_ready=true;agent.pause_signal.send_replace(true);agent.chat_id=agent.queue.front().map(|job|job.chat_id.clone());
        agent.messages=repair_history(agent.chat_id.as_ref().and_then(|id|crate::chats::get_chat(crate::CHAT_KEY,id)).and_then(|chat|chat["messages"].as_array().cloned()).unwrap_or_default());
    }
    persist(&agent);
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn interrupted_tool_history_is_repaired_without_duplicating_complete_results(){
        let messages=vec![json!({"role":"user","content":"task"}),json!({"role":"assistant","tool_calls":[{"id":"one"},{"id":"two"}]}),json!({"role":"tool","tool_call_id":"one","content":"done"})];
        let repaired=repair_history(messages);assert_eq!(repaired.len(),4);assert_eq!(repaired[3]["tool_call_id"],"two");
        assert_eq!(repair_history(repaired.clone()),repaired);
    }
}
