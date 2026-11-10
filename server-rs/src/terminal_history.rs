//! Shell-reported command history, never raw terminal input or password prompts.
use std::sync::{Mutex,LazyLock};
use serde_json::{json,Value};
use base64::{Engine,engine::general_purpose::STANDARD};
use regex::Regex;
static LOCK:Mutex<()>=Mutex::new(());
static RECORD:LazyLock<Regex>=LazyLock::new(||Regex::new(r"^\s*\d+\s+\*?(.*)$").unwrap());
static SECRET:LazyLock<Regex>=LazyLock::new(||Regex::new(r"(?i)(password|passwd|passphrase|api[_-]?key|token|secret|private[_ -]?key|BEGIN.*KEY|sk-[A-Za-z0-9_-]{12,})").unwrap());
pub fn commands(host:&str)->Vec<String>{let _lock=LOCK.lock().unwrap();crate::load_json_or("terminal-history.json",json!({}))[host].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()}
pub fn merge(host:&str,text:&str)->Result<Vec<String>,String>{
 let _lock=LOCK.lock().unwrap();let mut history=crate::load_json_or("terminal-history.json",json!({}));
 if !history.is_object(){return Err("命令历史格式错误，原记录保留".into());}
 let mut entries=history[host].as_array().cloned().unwrap_or_default();let before=entries.clone();
 // Continuation lines are not separate commands; skip multiline records.
 let mut records=Vec::new();let mut current:Option<String>=None;let mut multiline=false;
 for line in text.lines(){if let Some(found)=RECORD.captures(line){if let Some(command)=current.take(){if !multiline{records.push(command);}}current=Some(found[1].to_string());multiline=false;}else if !line.trim().is_empty(){multiline=true;}}
 if let Some(command)=current{if !multiline{records.push(command);}}
 for command in records{let command=command.trim_end();if command.is_empty()||command.len()>4096||command.starts_with(' ')||command.chars().any(char::is_control)||command.contains("__shellpilot_")||SECRET.is_match(command){continue;}
  entries.retain(|old|old.as_str()!=Some(command));entries.push(json!(command));
 }
 if entries.len()>500{entries.drain(..entries.len()-500);}
 if entries!=before{history[host]=json!(entries);crate::save_json("terminal-history.json",&history);if let Some(error)=crate::storage_fault(){return Err(error);}}
 Ok(entries.into_iter().filter_map(|entry|entry.as_str().map(String::from)).collect())
}
pub async fn list(axum::extract::State(st):axum::extract::State<std::sync::Arc<crate::AppState>>,axum::extract::Query(args):axum::extract::Query<std::collections::HashMap<String,String>>)->axum::response::Response{
 use axum::response::IntoResponse;
 let host=args.get("host").cloned().unwrap_or_default();
 if !st.hosts.read().await.iter().any(|value|value["id"].as_str()==Some(&host)){return(axum::http::StatusCode::BAD_REQUEST,axum::Json(json!({"error":"服务器不存在"}))).into_response();}
 axum::Json(json!({"commands":commands(&host)})).into_response()
}

pub fn bootstrap(shell:&str,token:&str)->Option<String>{
 let script=match shell.rsplit('/').next().unwrap_or(""){
  "bash"=>include_str!("../../runtime/terminal-bash.sh"),
  "zsh"=>include_str!("../../runtime/terminal-zsh.sh"),
  _=>return None,
 };
 Some(format!(" builtin eval {}\r",crate::shq(&script.replace("__TOKEN__",token))))
}

// Preserve split UTF-8 and OSC frames before parsing the hidden history message.
pub struct Stream{bytes:Vec<u8>,text:String,prefix:String,pub waiting:bool}
impl Stream{
 pub fn new(token:Option<&str>)->Self{Self{bytes:Vec::new(),text:String::new(),prefix:format!("\x1b]777;ShellPilot;{};",token.unwrap_or("")),waiting:token.is_some()}}
 pub fn feed(&mut self,bytes:&[u8])->(String,Vec<String>){
  self.bytes.extend_from_slice(bytes);let(valid,incomplete)=match std::str::from_utf8(&self.bytes){Ok(_)=>(self.bytes.len(),false),Err(error)=>(error.valid_up_to(),error.error_len().is_none())};
  if !incomplete&&valid<self.bytes.len(){self.text.push_str(&String::from_utf8_lossy(&self.bytes));self.bytes.clear();}else{self.text.push_str(std::str::from_utf8(&self.bytes[..valid]).unwrap_or(""));self.bytes.drain(..valid);}
  let mut output=String::new();let mut histories=Vec::new();
  loop{
   if let Some(start)=self.text.find(&self.prefix){
    let tail=&self.text[start+self.prefix.len()..];let Some(end)=tail.find('\x07')else{if start>0{if !self.waiting{output.push_str(&self.text[..start]);}self.text.drain(..start);}if self.text.len()>512*1024{self.text.clear();self.waiting=false;}break;};
    let value=tail[..end].to_string();let finish=start+self.prefix.len()+end+1;
    if !self.waiting{output.push_str(&self.text[..start]);}
    if value=="Ready"{self.waiting=false;}
    else if let Some(encoded)=value.strip_prefix("H;"){if let Ok(bytes)=STANDARD.decode(encoded){if let Ok(text)=String::from_utf8(bytes){histories.push(text);}}}
    else if !self.waiting{output.push_str(&self.text[start..finish]);}
    self.text.drain(..finish);
   }else{
    let keep=(1..self.prefix.len().min(self.text.len()+1)).rev().find(|length|self.text.ends_with(&self.prefix[..*length])).unwrap_or(0);
    let flush=self.text.len()-keep;if !self.waiting{output.push_str(&self.text[..flush]);}self.text.drain(..flush);break;
   }
  }(output,histories)
 }
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn split_utf8_and_history_frames_remain_intact(){let mut stream=Stream::new(Some("fixture"));let input=format!("initial\x1b]777;ShellPilot;fixture;Ready\x07你好\x1b]777;ShellPilot;fixture;H;{}\x07\x1b]777;ShellPilot;fixture;I\x07",STANDARD.encode("  1 echo hello"));let mut text=String::new();let mut histories=Vec::new();for byte in input.bytes(){let(part,records)=stream.feed(&[byte]);text.push_str(&part);histories.extend(records);}assert_eq!(text,"你好\x1b]777;ShellPilot;fixture;I\x07");assert_eq!(histories,vec!["  1 echo hello"]);}
 #[test]fn unsupported_shells_keep_original_terminal(){assert!(bootstrap("/bin/fish","x").is_none());let mut stream=Stream::new(None);assert_eq!(stream.feed(b"hello").0,"hello");}
}
