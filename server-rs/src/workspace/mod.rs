//! Local workspace capabilities. Shell commands are run by the OS sandbox.
pub mod windows;
use std::{path::{Path,PathBuf},sync::Arc};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use tokio::sync::Mutex;
use axum::{Json,extract::{State,Query},response::{Response,IntoResponse},http::StatusCode};
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct WorkspaceConfig{pub directory:String,#[serde(default)]pub enabled:bool,#[serde(default)]pub network:bool}
impl Default for WorkspaceConfig{fn default()->Self{Self{directory:String::new(),enabled:false,network:false}}}
pub struct WorkspaceHub{pub mutation:Mutex<()>,pub config:Mutex<WorkspaceConfig>,pub generation:tokio::sync::watch::Sender<u64>}
impl WorkspaceHub{
 pub fn new()->Self{Self{mutation:Mutex::new(()),config:Mutex::new(WorkspaceConfig::default()),generation:tokio::sync::watch::channel(0).0}}
 pub async fn load(&self){*self.config.lock().await=serde_json::from_value(crate::load_json_or("workspace.json",json!({"directory":"","enabled":false,"network":false}))).unwrap_or_default();}
 pub async fn snapshot(&self)->Value{let config=self.config.lock().await.clone();json!({"directory":config.directory,"enabled":config.enabled,"network":config.network,"supported":cfg!(windows)})}
 pub async fn root(&self)->Result<PathBuf,String>{let c=self.config.lock().await;if !c.enabled{return Err("工作区已关闭".into());}let root=PathBuf::from(&c.directory);reject_links(&root)?;let normalized=canonical(&root)?;if normalized!=root{return Err("工作区路径已变化，请重新配置".into());}Ok(root)}
}
fn result(value:Result<Value,String>)->Response{match value{Ok(v)=>Json(v).into_response(),Err(e)=>(StatusCode::BAD_REQUEST,Json(json!({"error":e}))).into_response()}}
pub async fn status(State(st):State<Arc<crate::AppState>>)->Json<Value>{Json(st.workspace.snapshot().await)}
pub async fn configure(State(st):State<Arc<crate::AppState>>,Json(body):Json<WorkspaceConfig>)->Response{
 result(configure_inner(&st,body).await.map(|_|json!({"ok":true})))
}
pub async fn configure_inner(st:&Arc<crate::AppState>,mut config:WorkspaceConfig)->Result<(),String>{
 if !cfg!(windows){return Err("本机隔离工作区目前支持Windows".into());}
 let _lock=st.workspace.mutation.lock().await;
 if st.agent.lock().await.busy{return Err("先停止当前AI任务，再修改工作区".into());}
 let path=PathBuf::from(config.directory.trim());
 let root=validate_root(&path)?;
 config.directory=root.to_string_lossy().to_string();
 let old=st.workspace.config.lock().await.clone();
 if config.enabled {windows::prepare(&root)?;}
 if old.enabled && (old.directory!=config.directory||!config.enabled){windows::release(Path::new(&old.directory))?;}
 st.workspace.generation.send_modify(|n|*n+=1);
 crate::save_json("workspace.json",&json!(config));
 if let Some(error)=crate::storage_fault(){return Err(error);}
 *st.workspace.config.lock().await=config;
 st.broadcast_all(&json!({"type":"workspace-changed"}));
 Ok(())
}
fn canonical(path:&Path)->Result<PathBuf,String>{
 let value=path.canonicalize().map_err(|e|e.to_string())?;
 #[cfg(windows)]{
  let text=value.to_string_lossy();
  if let Some(path)=text.strip_prefix(r"\\?\"){if path.starts_with("UNC\\"){return Err("工作区必须是本机目录".into());}return Ok(PathBuf::from(path));}
 }
 Ok(value)
}
pub fn validate_root(path:&Path)->Result<PathBuf,String>{
 if !path.is_absolute(){return Err("请选择本机的完整目录路径".into());}
 let root=canonical(path).map_err(|e|format!("无法访问工作区目录：{e}"))?;
 if !root.is_dir(){return Err("工作区必须是文件夹".into());}
 let parent=root.parent().ok_or("不能把整个磁盘作为工作区")?;
 if parent.parent().is_none(){return Err("请选择专门的工作文件夹".into());}
 for base in [std::env::var_os("USERPROFILE"),std::env::var_os("APPDATA"),std::env::var_os("LOCALAPPDATA"),std::env::var_os("SystemRoot"),std::env::var_os("ProgramFiles"),std::env::var_os("ProgramFiles(x86)")].into_iter().flatten(){
  if let Ok(base)=canonical(&PathBuf::from(base)){let protected=std::env::var_os("SystemRoot").is_some_and(|sys|PathBuf::from(sys)==base)||base.file_name().is_some_and(|name|name.to_string_lossy().to_lowercase().contains("program files"));if root==base||(protected&&root.starts_with(&base)){return Err("请选择专门的工作文件夹，不要选择系统或用户数据根目录".into());}}
 }
 reject_links(&root)?;
 Ok(root)
}
fn reject_links(path:&Path)->Result<(),String>{
 let m=std::fs::symlink_metadata(path).map_err(|e|e.to_string())?;
 #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if m.file_attributes()&0x400!=0{return Err("工作区不允许符号链接或目录联接".into());}}
 if m.file_type().is_symlink(){return Err("工作区不允许符号链接".into());}
 Ok(())
}
pub fn resolve(root:&Path,input:&str,create:bool)->Result<PathBuf,String>{
 if input.contains(['\0','\r','\n',':']){return Err("工作区路径无效".into());}
 let relative=Path::new(input);
 if relative.components().any(|c|c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".shellpilot")){return Err("此目录由工作区运行器管理".into());}
 if relative.is_absolute()||relative.components().any(|c|!matches!(c,std::path::Component::Normal(_)|std::path::Component::CurDir)){return Err("只能使用工作区内的相对路径".into());}
 let path=root.join(relative);
 let mut part=root.to_path_buf();
 for component in relative.components(){part.push(component.as_os_str());if part.exists(){reject_links(&part)?;}else if !create{return Err("文件不存在".into());}}
 let existing=if path.exists(){path.clone()}else{path.parent().ok_or("路径无效")?.to_path_buf()};
 let normalized=canonical(&existing)?;
 if !normalized.starts_with(root){return Err("路径超出工作区".into());}
 Ok(path)
}
pub async fn call(st:&Arc<crate::AppState>,name:&str,args:&Value)->Result<Value,String>{
 let _operation=st.workspace.mutation.lock().await;
 let root=st.workspace.root().await?;
 let relative=args["path"].as_str().unwrap_or("");
 match name{
  "workspace_list"=>{
   let dir=resolve(&root,relative,false)?;
   let mut entries=Vec::new();
   for entry in std::fs::read_dir(dir).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;if entry.file_name()==".shellpilot"{continue;}let m=entry.metadata().map_err(|e|e.to_string())?;entries.push(json!({"name":entry.file_name().to_string_lossy(),"directory":m.is_dir(),"size":m.len()}));if entries.len()>=2000{break;}}
   entries.sort_by_key(|e|e["name"].as_str().unwrap_or("").to_lowercase());
   Ok(json!({"path":relative,"entries":entries}))
  },
  "workspace_read"=>{
   let path=resolve(&root,relative,false)?;let metadata=std::fs::metadata(&path).map_err(|e|e.to_string())?;
   if metadata.len()>1024*1024{return Err("文本文件超过1MB，请分块处理或下载".into());}
   let content=std::fs::read_to_string(&path).map_err(|e|e.to_string())?;
   Ok(json!({"path":relative,"content":content,"sha256":crate::operations::hash(&content)}))
  },
  "workspace_write"=>{
   let path=resolve(&root,relative,true)?;
   let content=args["content"].as_str().ok_or("缺少文件内容")?;
   if content.len()>1024*1024{return Err("单次文本写入最多1MB".into());}
   let before=if path.exists(){std::fs::read_to_string(&path).map_err(|e|e.to_string())?}else{String::new()};
   let expected=if path.exists(){crate::operations::hash(&before)}else{"missing".into()};
   if args["preview"].as_bool().unwrap_or(false){return Ok(json!({"path":relative,"before":before,"after":content,"expectedHash":expected}));}
   if let Some(hash)=args["expectedHash"].as_str(){if hash!=expected{return Err("文件已变化，请重新读取后再保存".into());}}
   let temp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4().simple()));
   std::fs::write(&temp,content.as_bytes()).map_err(|e|e.to_string())?;
   std::fs::rename(&temp,&path).map_err(|e|e.to_string())?;
   Ok(json!({"path":relative,"sha256":crate::operations::hash(content),"written":true}))
  },
  "workspace_mkdir"=>{let path=resolve(&root,relative,true)?;std::fs::create_dir(&path).map_err(|e|e.to_string())?;Ok(json!({"ok":true}))},
  "workspace_delete"=>{let path=resolve(&root,relative,false)?;if path==root{return Err("不能删除工作区根目录".into());}if path.is_dir(){std::fs::remove_dir(&path)}else{std::fs::remove_file(&path)}.map_err(|e|e.to_string())?;Ok(json!({"ok":true}))},
  "workspace_exec"=>{
   let c=st.workspace.config.lock().await.clone();
   let command=crate::operations::text_arg(args,"command")?.to_string();
   let timeout=args["timeout"].as_u64().unwrap_or(120000).clamp(100,900000);
   let cancel=st.agent.lock().await.cancel.as_ref().map(|s|s.subscribe());
   drop(_operation);
   windows::execute(&root,&command,c.network,timeout,cancel,st.workspace.generation.subscribe()).await
  },
  _=>Err("未知工作区操作".into())
 }
}
pub fn schemas()->Vec<Value>{
 let schema=|name:&str,description:&str,properties:Value,required:Vec<&str>|json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}});
 let path=json!({"type":"string","description":"工作区内相对路径"});
 vec![
 schema("workspace_list","查看本机工作区文件，path为空列出根目录",json!({"path":path}),vec![]),
 schema("workspace_read","读取工作区文本文件",json!({"path":path}),vec!["path"]),
 schema("workspace_write","创建或更新工作区文件；修改已有文件请传读取时的expectedHash",json!({"path":path,"content":{"type":"string"},"expectedHash":{"type":"string"}}),vec!["path","content"]),
 schema("workspace_mkdir","在工作区创建目录",json!({"path":path}),vec!["path"]),
 schema("workspace_delete","删除工作区文件或空目录",json!({"path":path}),vec!["path"]),
 schema("workspace_exec","在Windows AppContainer隔离工作区执行PowerShell。可以操作工作区，不具备外部用户文件权限。只在此目录完成任务。",json!({"command":{"type":"string"},"timeout":{"type":"integer"}}),vec!["command"])
 ]
}
pub async fn files(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>)->Response{result(call(&st,"workspace_list",&json!({"path":args.get("path").cloned().unwrap_or_default()})).await)}
pub async fn action(State(st):State<Arc<crate::AppState>>,Json(body):Json<Value>)->Response{result(call(&st,body["name"].as_str().unwrap_or(""),&body["arguments"]).await)}
pub async fn pick(State(st):State<Arc<crate::AppState>>)->Response{
 let picker=st.folder_picker.read().unwrap().clone();
 match picker{Some(picker)=>match picker(){Ok(path)=>Json(json!({"directory":path})).into_response(),Err(e)=>result(Err(e))},None=>result(Err("请输入本机目录完整路径".into()))}
}
pub async fn download(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>)->Response{
 let root=match st.workspace.root().await{Ok(root)=>root,Err(e)=>return result(Err(e))};
 let path=match resolve(&root,args.get("path").map(String::as_str).unwrap_or(""),false){Ok(path)=>path,Err(e)=>return result(Err(e))};
 let file=match tokio::fs::File::open(&path).await{Ok(file)=>file,Err(e)=>return result(Err(e.to_string()))};
 let name=path.file_name().unwrap_or_default().to_string_lossy().replace(['"','\r','\n'],"");
 use futures_util::TryStreamExt;
 let stream=tokio_util::io::ReaderStream::new(file).map_err(std::io::Error::other);
 ([(axum::http::header::CONTENT_TYPE,"application/octet-stream".to_string()),(axum::http::header::CONTENT_DISPOSITION,format!("attachment; filename*=UTF-8''{}",percent_encoding::utf8_percent_encode(&name,percent_encoding::NON_ALPHANUMERIC)))],axum::body::Body::from_stream(stream)).into_response()
}
pub async fn upload(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>,mut multipart:axum::extract::Multipart)->Response{
 result(async{
  use tokio::io::AsyncWriteExt;
  let _lock=st.workspace.mutation.lock().await;
  let root=st.workspace.root().await?;
  let directory=args.get("path").cloned().unwrap_or_default();
  let dir=resolve(&root,&directory,false)?;
  if !dir.is_dir(){return Err("上传目标必须是工作区文件夹".into());}
  let mut files=Vec::new();
  while let Some(mut field)=multipart.next_field().await.map_err(|e|e.to_string())?{
   let name=field.file_name().ok_or("请选择文件")?.to_string();
   if name.contains(['/','\\',':'])||name=="."||name==".."{return Err("文件名无效".into());}
   let relative=if directory.is_empty(){name.clone()}else{format!("{directory}/{name}")};
   let path=resolve(&root,&relative,true)?;
   if path.exists(){return Err(format!("文件 {name} 已存在，请先改名或删除旧文件"));}
   let temp=dir.join(format!(".upload-{}",uuid::Uuid::new_v4().simple()));
   let upload=async{
    let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await.map_err(|e|e.to_string())?;
    while let Some(chunk)=field.chunk().await.map_err(|e|e.to_string())?{file.write_all(&chunk).await.map_err(|e|e.to_string())?;}
    file.sync_all().await.map_err(|e|e.to_string())?;drop(file);
    tokio::fs::rename(&temp,&path).await.map_err(|e|e.to_string())?;Ok::<_,String>(())
   }.await;
   if let Err(error)=upload{let _=tokio::fs::remove_file(temp).await;return Err(error);}
   files.push(relative);
  }
  Ok(json!({"files":files}))
 }.await)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn paths_cannot_escape(){let dir=std::env::temp_dir().join(format!("sp-ws-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&dir).unwrap();let root=canonical(&dir).unwrap();assert!(resolve(&root,"../secret",true).is_err());assert!(resolve(&root,"C:/secret",true).is_err());assert!(resolve(&root,"item.txt",true).is_ok());std::fs::remove_dir(dir).unwrap();}
}
