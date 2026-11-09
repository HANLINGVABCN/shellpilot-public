//! Local workspace capabilities. Shell commands are run by the OS sandbox.
pub mod windows;
pub mod linux_runtime;
pub mod linux_vm;
pub mod android;
pub mod linux_proxy;
pub mod transfer;
pub mod upload;
pub mod files;
use std::{path::{Path,PathBuf},sync::Arc};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use tokio::sync::Mutex;
use axum::{Json,extract::{State,Query},response::{Response,IntoResponse},http::StatusCode};
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct WorkspaceConfig{pub directory:String,#[serde(default)]pub enabled:bool,#[serde(default)]pub network:bool,#[serde(default="native_engine")]pub engine:String,#[serde(default)]pub auto_start:bool}
fn native_engine()->String{"linux".into()}
impl Default for WorkspaceConfig{fn default()->Self{Self{directory:String::new(),enabled:false,network:false,engine:"linux".into(),auto_start:false}}}
pub struct WorkspaceHub{pub mutation:Arc<Mutex<()>>,pub config:Mutex<WorkspaceConfig>,pub generation:tokio::sync::watch::Sender<u64>,pub linux:linux_runtime::LinuxHub}
impl WorkspaceHub{
 pub fn new()->Self{Self{mutation:Arc::new(Mutex::new(())),config:Mutex::new(WorkspaceConfig::default()),generation:tokio::sync::watch::channel(0).0,linux:linux_runtime::LinuxHub::new()}}
 pub async fn load(&self){
  let mut config:WorkspaceConfig=crate::load_json("workspace.json").and_then(|value|serde_json::from_value(value).ok()).unwrap_or_default();
  // Retire only the old workspace permission grant; keep its directory and files.
  if config.engine!="linux"{
   if config.enabled&&!config.directory.is_empty(){let root=PathBuf::from(&config.directory);let _=blocking(move||{let root=validate_root(&root)?;windows::release(&root)}).await;}
   config.engine="linux".into();crate::save_json("workspace.json",&json!(config));
  }
  *self.config.lock().await=config;
 }
 pub async fn snapshot(&self)->Value{let config=self.config.lock().await.clone();json!({"directory":config.directory,"enabled":config.enabled,"network":config.network,"engine":config.engine,"autoStart":config.auto_start,"supported":cfg!(windows)||cfg!(target_os="android")})}
 pub async fn root(&self)->Result<PathBuf,String>{let c=self.config.lock().await;if !c.enabled{return Err("工作区已关闭".into());}let root=PathBuf::from(&c.directory);reject_links(&root)?;let normalized=canonical(&root)?;if normalized!=root{return Err("工作区路径已变化，请重新配置".into());}Ok(root)}
}
fn result(value:Result<Value,String>)->Response{match value{Ok(v)=>Json(v).into_response(),Err(e)=>(StatusCode::BAD_REQUEST,Json(json!({"error":e}))).into_response()}}
pub async fn status(State(st):State<Arc<crate::AppState>>)->Json<Value>{Json(st.workspace.snapshot().await)}
pub async fn configure(State(st):State<Arc<crate::AppState>>,Json(body):Json<WorkspaceConfig>)->Response{
 result(configure_inner(&st,body).await.map(|_|json!({"ok":true})))
}
async fn blocking<T:Send+'static>(work:impl FnOnce()->Result<T,String>+Send+'static)->Result<T,String>{
 tokio::task::spawn_blocking(work).await.map_err(|e|format!("工作区设置未完成：{e}"))?
}
pub async fn configure_inner(st:&Arc<crate::AppState>,mut config:WorkspaceConfig)->Result<(),String>{
 if !cfg!(windows)&&!cfg!(target_os="android"){return Err("本机工作区目前支持Windows和Android".into());}
 config.engine="linux".into();
 let permit=st.workspace.mutation.clone().try_lock_owned().map_err(|_|"工作区正在处理其他操作，请稍后再保存".to_string())?;
 let st=st.clone();
 // Finish the serialized change even if its HTTP connection closes midway.
 tokio::spawn(async move{let _permit=permit;configure_locked(&st,config).await}).await.map_err(|e|format!("工作区设置未完成：{e}"))?
}
async fn configure_locked(st:&Arc<crate::AppState>,mut config:WorkspaceConfig)->Result<(),String>{
 if st.agent.lock().await.busy{return Err("先停止当前AI任务，再修改工作区".into());}
 let old=st.workspace.config.lock().await.clone();
 st.workspace.generation.send_modify(|n|*n+=1);
 st.workspace.linux.stop().await;
 #[cfg(target_os="android")]{
  config.directory="/workspace".into();
  if config.enabled&&!android::ready().await?{return Err("请先安装Linux工作区运行组件".into());}
  crate::save_json("workspace.json",&json!(config));
  *st.workspace.config.lock().await=config;st.broadcast_all(&json!({"type":"workspace-changed"}));return Ok(());
 }
 config=blocking(move||{
  let root=validate_root(&PathBuf::from(config.directory.trim()))?;
  config.directory=root.to_string_lossy().to_string();
  if old.enabled&&old.engine=="native"{windows::release(Path::new(&old.directory))?;}
  crate::save_json("workspace.json",&json!(config));
  if let Some(error)=crate::storage_fault(){return Err(error);}
  Ok(config)
 }).await?;
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
 if let Ok(data)=canonical(&crate::data_dir()){if root.starts_with(&data)||data.starts_with(&root){return Err("不能把ShellPilot配置目录作为AI工作区".into());}}
 root.parent().ok_or("不能把整个磁盘作为工作区")?;
 for base in [std::env::var_os("USERPROFILE"),std::env::var_os("APPDATA"),std::env::var_os("LOCALAPPDATA"),std::env::var_os("SystemRoot"),std::env::var_os("ProgramFiles"),std::env::var_os("ProgramFiles(x86)")].into_iter().flatten(){
  if let Ok(base)=canonical(&PathBuf::from(base)){let protected=std::env::var_os("SystemRoot").is_some_and(|sys|PathBuf::from(sys)==base)||base.file_name().is_some_and(|name|name.to_string_lossy().to_lowercase().contains("program files"));if root==base||(protected&&root.starts_with(&base)){return Err("请选择专门的工作文件夹，不要选择系统或用户数据根目录".into());}}
 }
 reject_links(&root)?;
 if let Ok(internal)=std::fs::symlink_metadata(root.join(".shellpilot")){if internal.file_type().is_symlink(){return Err("工作区运行目录不能是链接".into());}}
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
 #[cfg(target_os="android")]{
  let config=st.workspace.config.lock().await.clone();if !config.enabled{return Err("工作区已关闭".into());}
  let result=android::action(name,args,config.network).await;st.workspace.linux.touch();
  if name=="workspace_read"{if let Ok(value)=&result{let text=value["content"].as_str().unwrap_or("");if text.contains('\0')||value["sha256"].as_str()!=Some(crate::operations::hash(text).as_str()){return Err("这个文件不能按UTF-8文本编辑，请下载或通过工作区程序处理，原文件已保留".into());}}}
  return result;
 }
 let root=st.workspace.root().await?;
 let relative=args["path"].as_str().unwrap_or("");
 match name{
  "workspace_list"=>{
   let dir=resolve(&root,relative,false)?;
   let _lease=windows::hold_directory(&root,&dir)?;
   let mut entries=Vec::new();
   for entry in std::fs::read_dir(dir).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;if entry.file_name()==".shellpilot"{continue;}let m=entry.metadata().map_err(|e|e.to_string())?;let mtime=m.modified().ok().and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration|duration.as_millis() as u64);entries.push(json!({"name":entry.file_name().to_string_lossy(),"directory":m.is_dir(),"size":m.len(),"mtime":mtime}));if entries.len()>=2000{break;}}
   entries.sort_by_key(|e|e["name"].as_str().unwrap_or("").to_lowercase());
   Ok(json!({"path":relative,"entries":entries}))
  },
  "workspace_read"=>{
   use std::io::Read;
   let path=resolve(&root,relative,false)?;let _lease=windows::hold_directory(&root,path.parent().ok_or("路径无效")?)?;
   let mut file=windows::read_file(&path)?;let metadata=file.metadata().map_err(|e|e.to_string())?;
   if metadata.len()>1024*1024{return Err("文本文件超过1MB，请分块处理或下载".into());}
   let mut content=String::new();file.read_to_string(&mut content).map_err(|e|e.to_string())?;
   Ok(json!({"path":relative,"content":content,"sha256":crate::operations::hash(&content)}))
  },
  "workspace_write"=>{
   use std::io::Read;
   let path=resolve(&root,relative,true)?;
   let _lease=windows::hold_directory(&root,path.parent().ok_or("路径无效")?)?;
   let content=args["content"].as_str().ok_or("缺少文件内容")?;
   if content.len()>1024*1024{return Err("单次文本写入最多1MB".into());}
   let before=if path.exists(){let mut content=String::new();windows::read_file(&path)?.read_to_string(&mut content).map_err(|e|e.to_string())?;content}else{String::new()};
   let expected=if path.exists(){crate::operations::hash(&before)}else{"missing".into()};
   if args["preview"].as_bool().unwrap_or(false){return Ok(json!({"path":relative,"before":before,"after":content,"expectedHash":expected}));}
   if let Some(hash)=args["expectedHash"].as_str(){if hash!=expected{return Err("文件已变化，请重新读取后再保存".into());}}
   let temp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4().simple()));
   std::fs::write(&temp,content.as_bytes()).map_err(|e|e.to_string())?;
   std::fs::rename(&temp,&path).map_err(|e|e.to_string())?;
   Ok(json!({"path":relative,"sha256":crate::operations::hash(content),"written":true}))
  },
  "workspace_mkdir"=>{let path=resolve(&root,relative,true)?;let _lease=windows::hold_directory(&root,path.parent().ok_or("路径无效")?)?;std::fs::create_dir(&path).map_err(|e|e.to_string())?;Ok(json!({"ok":true}))},
  "workspace_delete"|"workspace_rename"|"workspace_copy"=>{let args=args.clone();let name=name.to_string();blocking(move||files::action(&root,&name,&args)).await},
  "workspace_exec"=>{
   let c=st.workspace.config.lock().await.clone();
   let command=crate::operations::text_arg(args,"command")?.to_string();
   let timeout=args["timeout"].as_u64().unwrap_or(120000).clamp(100,900000);
   let cancel=st.agent.lock().await.cancel.as_ref().map(|s|s.subscribe());
   let status=st.workspace.linux.status().await;if status["installed"]!=true{return Err("请先安装Linux工作区".into());}
   drop(cancel);drop(_operation);linux_vm::execute(st,&root,&command,c.network,timeout).await
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
 schema("workspace_rename","重命名或移动工作区文件，目标已存在时拒绝覆盖",json!({"path":path,"to":path}),vec!["path","to"]),
 schema("workspace_copy","在工作区复制文件或目录；目标目录path为空表示根目录，move可选择移动，同名副本自动改名",json!({"path":path,"paths":{"type":"array","items":{"type":"string"}},"move":{"type":"boolean"}}),vec!["path","paths"]),
 schema("workspace_delete","删除工作区文件或空目录",json!({"path":path}),vec!["path"]),
 schema("workspace_exec","在本机Linux工作区使用/bin/sh执行命令，只允许在工作区完成用户任务。",json!({"command":{"type":"string"},"timeout":{"type":"integer"}}),vec!["command"]),
 schema("workspace_upload_to_server","将工作区文件流式上传到授权服务器的新文件路径；不覆盖已有文件。适合先处理用户文件再上传。",json!({"host":{"type":"string"},"path":path,"remotePath":{"type":"string"}}),vec!["host","path","remotePath"]),
 schema("workspace_download_from_server","将授权服务器文件流式下载到工作区的新文件路径；不覆盖用户已有文件。",json!({"host":{"type":"string"},"path":path,"remotePath":{"type":"string"}}),vec!["host","path","remotePath"])
 ]
}
pub async fn files(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>)->Response{result(call(&st,"workspace_list",&json!({"path":args.get("path").cloned().unwrap_or_default()})).await)}
pub async fn action(State(st):State<Arc<crate::AppState>>,Json(body):Json<Value>)->Response{result(call(&st,body["name"].as_str().unwrap_or(""),&body["arguments"]).await)}
pub async fn pick(State(st):State<Arc<crate::AppState>>)->Response{
 let picker=st.folder_picker.read().unwrap().clone();
 match picker{Some(picker)=>match blocking(move||picker()).await{Ok(path)=>Json(json!({"directory":path})).into_response(),Err(e)=>result(Err(e))},None=>result(Err("请输入本机目录完整路径".into()))}
}
pub async fn user_download(State(st):State<Arc<crate::AppState>>,Json(body):Json<Value>)->Response{
 if !st.workspace.config.lock().await.enabled{return result(Err("工作区已关闭".into()));}
 result(android::request(json!({"op":"user-export","path":body["path"]})).await)
}
pub async fn user_upload_folder(State(st):State<Arc<crate::AppState>>,Json(body):Json<Value>)->Response{
 if !st.workspace.config.lock().await.enabled{return result(Err("工作区已关闭".into()));}
 let path=body["path"].as_str().unwrap_or("");if !path.is_empty(){if let Err(error)=upload::valid_path(path){return result(Err(error));}}
 result(android::request(json!({"op":"user-import-directory","path":path})).await)
}
pub async fn user_upload_status()->Response{result(android::request(json!({"op":"user-import-status"})).await)}
pub async fn download(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>)->Response{
 #[cfg(target_os="android")]{if !st.workspace.config.lock().await.enabled{return result(Err("工作区已关闭".into()));}return android::download(&args).await;}
 let root=match st.workspace.root().await{Ok(root)=>root,Err(e)=>return result(Err(e))};
 let path=match resolve(&root,args.get("path").map(String::as_str).unwrap_or(""),false){Ok(path)=>path,Err(e)=>return result(Err(e))};
 let _lease=match windows::hold_directory(&root,path.parent().unwrap_or(&root)){Ok(lease)=>lease,Err(e)=>return result(Err(e))};
 let file=match windows::read_file(&path){Ok(file)=>tokio::fs::File::from_std(file),Err(e)=>return result(Err(e))};
 let name=path.file_name().unwrap_or_default().to_string_lossy().replace(['"','\r','\n'],"");
 use futures_util::TryStreamExt;
 let stream=tokio_util::io::ReaderStream::new(file).map_err(std::io::Error::other);
 ([(axum::http::header::CONTENT_TYPE,"application/octet-stream".to_string()),(axum::http::header::CONTENT_DISPOSITION,format!("attachment; filename*=UTF-8''{}",percent_encoding::utf8_percent_encode(&name,percent_encoding::NON_ALPHANUMERIC)))],axum::body::Body::from_stream(stream)).into_response()
}
pub async fn upload(State(st):State<Arc<crate::AppState>>,Query(args):Query<std::collections::HashMap<String,String>>,mut multipart:axum::extract::Multipart)->Response{
 result(upload::receive(&st,&args,&mut multipart).await)
}
#[cfg(test)]mod tests{
 use super::*;
 #[tokio::test(flavor="current_thread")]
 async fn permission_work_keeps_configuration_reads_responsive(){
  let hub=Arc::new(WorkspaceHub::new());let worker_hub=hub.clone();let entered=Arc::new(std::sync::atomic::AtomicBool::new(false));let worker_entered=entered.clone();
  let task=tokio::spawn(async move{
   let permit=worker_hub.mutation.clone().lock_owned().await;
   blocking(move||{let _permit=permit;worker_entered.store(true,std::sync::atomic::Ordering::SeqCst);std::thread::sleep(std::time::Duration::from_millis(200));Ok(())}).await
  });
  while !entered.load(std::sync::atomic::Ordering::SeqCst){tokio::task::yield_now().await;}
  assert!(hub.mutation.clone().try_lock_owned().is_err());
  let snapshot=tokio::time::timeout(std::time::Duration::from_millis(50),hub.snapshot()).await.unwrap();assert_eq!(snapshot["enabled"],false);
  task.await.unwrap().unwrap();assert!(hub.mutation.clone().try_lock_owned().is_ok());
 }
 #[test]fn paths_cannot_escape(){let dir=std::env::temp_dir().join(format!("sp-ws-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&dir).unwrap();let root=canonical(&dir).unwrap();assert!(resolve(&root,"../secret",true).is_err());assert!(resolve(&root,"C:/secret",true).is_err());assert!(resolve(&root,"item.txt",true).is_ok());std::fs::remove_dir(dir).unwrap();}
}
