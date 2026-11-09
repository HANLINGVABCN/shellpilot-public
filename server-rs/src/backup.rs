//! Category selection is independent from host/provider record selection.
use serde::{Deserialize,Serialize};
use serde_json::{json,Map,Value};
use crate::import::{validate_import_data,prepare_import,ImportOptions,GLOBAL_KEY};

const AI_KEYS:&[&str]=&["providers","models","defaultModelId","approverModelId","titleModelId","params","systemPrompt"];
#[derive(Clone,Copy,Default,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sections{#[serde(default)]pub hosts:bool,#[serde(default)]pub providers:bool,#[serde(default)]pub chats:bool,#[serde(default)]pub memories:bool}
impl Sections{
 pub fn all()->Self{Self{hosts:true,providers:true,chats:true,memories:true}}
 pub fn parse(value:&Value)->Result<Self,String>{let sections:Self=serde_json::from_value(value.clone()).map_err(|_|"备份选择格式错误")?;if !sections.any(){return Err("请至少选择一项内容".into());}Ok(sections)}
 pub fn any(&self)->bool{self.hosts||self.providers||self.chats||self.memories}
 pub fn check(&self,counts:&Value)->Result<(),String>{for(key,label,enabled)in [("hosts","服务器",self.hosts),("providers","AI提供商",self.providers),("chats","对话记录",self.chats),("memories","记忆",self.memories)]{if enabled&&counts[key].as_u64().unwrap_or(0)==0{return Err(format!("备份中没有{label}，请选择已有内容"));}}Ok(())}
}
pub fn counts(data:&Value)->Result<Value,String>{
 let validated=validate_import_data(data)?;
 Ok(json!({"hosts":validated.hosts.len(),"providers":validated.settings["providers"].as_array().map(Vec::len).unwrap_or(0),"chats":validated.chats.as_object().map(|groups|groups.values().filter_map(Value::as_array).map(Vec::len).sum::<usize>()).unwrap_or(0),"memories":data["memories"].as_array().map(Vec::len).unwrap_or(0)}))
}
fn host_metadata(host:&Value)->Value{let mut result=Map::new();for key in ["id","name","host","port","username"]{if let Some(value)=host.get(key){result.insert(key.into(),value.clone());}}Value::Object(result)}
pub fn export_selected(data:&Value,sections:Sections)->Result<Value,String>{
 if !sections.any(){return Err("请至少选择一项内容".into());}
 sections.check(&counts(data)?)?;
 let mut result=json!({"version":1,"exportedAt":data["exportedAt"],"sections":sections});
 if sections.hosts{result["hosts"]=data["hosts"].clone();}
 if sections.providers{let mut settings=Map::new();for key in AI_KEYS{if let Some(value)=data["settings"].get(*key){settings.insert((*key).into(),value.clone());}}result["settings"]=Value::Object(settings);}
 if sections.chats{
  result["chats"]=data["chats"].clone();
  let hosts=data["hosts"].as_array().map(|hosts|hosts.iter().filter(|host|data["chats"].get(host["id"].as_str().unwrap_or("")).is_some()).map(host_metadata).collect::<Vec<_>>()).unwrap_or_default();
  result["chatHosts"]=json!(hosts);
 }
 if sections.memories{result["memories"]=data["memories"].clone();}
 Ok(result)
}
fn host_key(host:&Value)->String{json!([host["host"].as_str().unwrap_or("").trim().to_lowercase(),host["port"].as_u64().unwrap_or(22),host["username"]]).to_string()}
fn merge_chats(current:&Value,incoming:&Value,hosts:&Value,overwrite:bool)->Result<Value,String>{
 let validated=validate_import_data(incoming)?;
 let metadata=if let Some(metadata)=incoming.get("chatHosts"){validate_import_data(&json!({"hosts":metadata}))?.hosts}else{validated.hosts};
 let mut result=if overwrite{Map::new()}else{current["chats"].as_object().cloned().unwrap_or_default()};
 for(source,list)in validated.chats.as_object().unwrap(){
  let source_host=metadata.iter().find(|host|host["id"].as_str()==Some(source));
  let target=if source==GLOBAL_KEY{Some(GLOBAL_KEY)}else if let Some(host)=source_host{hosts.as_array().and_then(|hosts|hosts.iter().find(|target|host_key(target)==host_key(host))).and_then(|host|host["id"].as_str())}else{hosts.as_array().and_then(|hosts|hosts.iter().find(|host|host["id"].as_str()==Some(source))).map(|_|source.as_str())};
  let orphan=target.is_none();let target=target.unwrap_or(GLOBAL_KEY);
  let records=result.entry(target.to_string()).or_insert_with(||json!([])).as_array_mut().ok_or("对话分组格式错误")?;
  for chat in list.as_array().unwrap(){
   let origin=json!([source_host.map(host_key).unwrap_or_else(||source.clone()),chat["id"]]).to_string();
   if records.iter().any(|record|record==chat||record["importSource"].as_str()==Some(&origin)){continue;}
   let mut chat=chat.clone();
   if records.iter().any(|record|record["id"]==chat["id"]){chat["id"]=json!(crate::rand_id("c"));}
   if orphan{let name=source_host.and_then(|host|host["name"].as_str()).unwrap_or(source);chat["title"]=json!(format!("{name} · {}",chat["title"].as_str().unwrap_or("对话")));}
   chat["importSource"]=json!(origin);records.push(chat);
  }
 }
 Ok(Value::Object(result))
}
pub fn prepare_selected(current:&Value,incoming:&Value,sections:Sections,options:ImportOptions)->Result<Value,String>{
 if !sections.any(){return Err("请至少选择一项内容".into());}
 sections.check(&counts(incoming)?)?;validate_import_data(current)?;
 if let Some(mode)=&options.mode{if mode!="merge"&&mode!="overwrite"{return Err("导入模式不合法".into());}}
 let overwrite=options.mode.as_deref()==Some("overwrite");let mut result=current.clone();
 if sections.hosts||sections.providers{
  if sections.hosts&&options.host_ids.as_ref().is_some_and(|ids|ids.as_array().is_some_and(Vec::is_empty)){return Err("请至少勾选一台服务器".into());}
  if sections.providers&&options.provider_ids.as_ref().is_some_and(|ids|ids.as_array().is_some_and(Vec::is_empty)){return Err("请至少勾选一个AI提供商".into());}
  let mut config=incoming.clone();config["chats"]=json!({});
  let prepared=prepare_import(current,&config,ImportOptions{host_ids:if sections.hosts{options.host_ids}else{Some(json!([]))},provider_ids:if sections.providers{options.provider_ids}else{Some(json!([]))},mode:options.mode})?;
  if sections.hosts{result["hosts"]=prepared["hosts"].clone();}
  if sections.providers{
   let mut settings=current["settings"].as_object().cloned().unwrap_or_default();
   for key in AI_KEYS{if let Some(value)=prepared["settings"].get(*key){settings.insert((*key).into(),value.clone());}}
   result["settings"]=Value::Object(settings);
  }
 }
 if sections.chats{result["chats"]=merge_chats(current,incoming,&result["hosts"],overwrite)?;}
 if sections.memories{result["memories"]=incoming["memories"].clone();}
 Ok(result)
}

#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->Value{json!({"version":1,"hosts":[{"id":"h","name":"Demo","host":"192.0.2.1","port":22,"username":"demo","password":"host-secret"}],"settings":{"providers":[{"id":"p","name":"Provider","baseURL":"https://api.example/v1","apiKey":"provider-secret"}],"models":[{"id":"m","providerId":"p","name":"demo-model"}],"defaultModelId":"m","mcpEnabled":true,"autoMemory":false},"chats":{"h":[{"id":"chat","title":"fixture","messages":[{"role":"user","content":"hello"}]}]},"memories":[{"id":"mem","content":"Keep replies short","enabled":false}]})}
 fn options(mode:&str)->ImportOptions{ImportOptions{host_ids:None,provider_ids:None,mode:Some(mode.into())}}
 #[test]fn each_export_omits_unselected_credentials_and_records(){
  for sections in [Sections{hosts:true,..Default::default()},Sections{providers:true,..Default::default()},Sections{chats:true,..Default::default()},Sections{memories:true,..Default::default()}]{let result=export_selected(&fixture(),sections).unwrap();assert_eq!(result.get("hosts").is_some(),sections.hosts);assert_eq!(result.get("settings").is_some(),sections.providers);assert_eq!(result.get("chats").is_some(),sections.chats);assert_eq!(result.get("memories").is_some(),sections.memories);if !sections.hosts{assert!(!result.to_string().contains("host-secret"));}if !sections.providers{assert!(!result.to_string().contains("provider-secret"));}if sections.providers{assert!(result["settings"].get("mcpEnabled").is_none());}}
 }
 #[test]fn selecting_single_category_preserves_others_in_both_modes(){
  let current=fixture();let mut incoming=fixture();incoming["hosts"][0]["password"]=json!("updated");incoming["settings"]["providers"][0]["apiKey"]=json!("updated");incoming["memories"][0]["content"]=json!("changed");incoming["chats"]["h"][0]["id"]=json!("newchat");
  for mode in ["merge","overwrite"]{for sections in [Sections{hosts:true,..Default::default()},Sections{providers:true,..Default::default()},Sections{chats:true,..Default::default()},Sections{memories:true,..Default::default()}]{let result=prepare_selected(&current,&incoming,sections,options(mode)).unwrap();if !sections.hosts{assert_eq!(result["hosts"],current["hosts"]);}if !sections.providers{assert_eq!(result["settings"],current["settings"]);}if !sections.chats{assert_eq!(result["chats"],current["chats"]);}if !sections.memories{assert_eq!(result["memories"],current["memories"]);}assert_eq!(result["settings"]["mcpEnabled"],true);assert_eq!(result["settings"]["autoMemory"],false);}}
 }
 #[test]fn chat_only_import_works_without_creating_hosts_and_is_repeatable(){let exported=export_selected(&fixture(),Sections{chats:true,..Default::default()}).unwrap();let current=json!({"hosts":[],"settings":{},"chats":{}});let sections=Sections{chats:true,..Default::default()};let first=prepare_selected(&current,&exported,sections,options("merge")).unwrap();assert_eq!(first["hosts"],json!([]));assert_eq!(first["chats"][GLOBAL_KEY].as_array().unwrap().len(),1);let repeated=prepare_selected(&first,&exported,sections,options("merge")).unwrap();assert_eq!(first["chats"],repeated["chats"]);}
 #[test]fn absent_categories_and_invalid_flags_cannot_be_selected(){assert!(Sections::parse(&json!({})).is_err());assert!(Sections::parse(&json!({"hosts":"yes"})).is_err());assert!(Sections::parse(&json!({"other":true})).is_err());assert!(export_selected(&json!({}),Sections::all()).is_err());assert_eq!(counts(&json!({"memories":[{"content":"one"}]})).unwrap(),json!({"hosts":0,"providers":0,"chats":0,"memories":1}));}
 #[test]fn chat_source_identity_prevents_attaching_to_a_different_server_with_the_same_id(){
  let incoming=fixture();let mut current=fixture();current["hosts"][0]["host"]=json!("192.0.2.99");let original=current["chats"]["h"].clone();
  let exported=export_selected(&incoming,Sections{chats:true,..Default::default()}).unwrap();let result=prepare_selected(&current,&exported,Sections{chats:true,..Default::default()},options("merge")).unwrap();
  assert_eq!(result["chats"]["h"],original);assert_eq!(result["chats"][GLOBAL_KEY].as_array().unwrap().len(),1);assert_eq!(result["hosts"],current["hosts"]);
 }
}
