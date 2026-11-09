use std::{path::{Path,PathBuf},sync::Arc,time::{Duration,Instant}};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use tokio::{sync::{Mutex,watch},io::AsyncWriteExt};
use sha2::{Sha256,Digest};
use futures_util::StreamExt;

#[derive(Clone,Deserialize)]
pub struct Package{pub file:String,pub bytes:u64,pub sha256:String,pub urls:Vec<String>,#[serde(rename="expandedBytes")]pub expanded_bytes:u64,#[serde(default)]pub version:Option<String>}
#[derive(Deserialize)]pub struct Manifest{pub version:String,pub packages:std::collections::HashMap<String,Package>}
pub fn manifest()->Manifest{serde_json::from_str(include_str!("../../../runtime/manifest.json")).expect("bundled Linux manifest")}
pub fn base()->PathBuf{crate::data_dir().join("linux-runtime")}
pub fn platform()->&'static str{if cfg!(windows){"windows"}else if cfg!(target_os="android"){if cfg!(target_arch="aarch64"){"android-arm64"}else{"android-x86_64"}}else{"unsupported"}}
#[derive(Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct InstallStatus{pub phase:String,pub received:u64,pub total:u64,pub package:String,pub error:Option<String>,pub version:String}
impl Default for InstallStatus{fn default()->Self{Self{phase:"not-installed".into(),received:0,total:0,package:String::new(),error:None,version:manifest().version}}}
pub struct LinuxHub{pub install:Mutex<InstallStatus>,pub installing:std::sync::atomic::AtomicBool,pub cancel:watch::Sender<bool>,pub vm:Mutex<Option<super::linux_vm::Vm>>,pub terminals:std::sync::atomic::AtomicUsize,pub last_used:std::sync::atomic::AtomicI64}
impl LinuxHub{
 pub fn new()->Self{Self{install:Mutex::new(InstallStatus::default()),installing:std::sync::atomic::AtomicBool::new(false),cancel:watch::channel(false).0,vm:Mutex::new(None),terminals:std::sync::atomic::AtomicUsize::new(0),last_used:std::sync::atomic::AtomicI64::new(0)}}
 pub fn touch(&self){self.last_used.store(crate::now_ms(),std::sync::atomic::Ordering::SeqCst);}
 pub async fn status(&self)->Value{
  let status=self.install.lock().await.clone();let m=manifest();let keys=package_keys();let total=keys.iter().filter_map(|key|m.packages.get(*key)).map(|p|p.bytes).sum::<u64>();
  let mut ready=!keys.is_empty()&&keys.iter().all(|key|installed(key,&m.version));
  #[cfg(target_os="android")]let companion=if ready{super::android::request(json!({"op":"status"})).await.unwrap_or(json!({}))}else{json!({})};
  #[cfg(target_os="android")]if ready{ready=companion["installed"]==true;}
  let running=self.vm.try_lock().map(|vm|vm.is_some()).unwrap_or(true);
  #[cfg(target_os="android")]let running=companion["running"]==true;
  json!({"phase":if ready&&!self.installing.load(std::sync::atomic::Ordering::SeqCst){"installed"}else{&status.phase},"received":status.received,"total":if status.total>0{status.total}else{total},"package":status.package,"error":status.error,"version":m.version,"supported":platform()!="unsupported","available":!keys.is_empty()&&keys.iter().all(|key|m.packages.contains_key(*key)),"installed":ready,"platform":platform(),"running":running})
 }
 pub async fn stop(&self){#[cfg(target_os="android")]{let _=super::android::request(json!({"op":"stop"})).await;}let mut vm=self.vm.lock().await;if let Some(mut process)=vm.take(){process.stop().await;}}
}
pub fn package_keys()->Vec<&'static str>{match platform(){"windows"=>vec!["windows-qemu","windows-guest"],"android-arm64"=>vec!["android-arm64"],"android-x86_64"=>vec!["android-x86_64"],_=>vec![]}}
fn installed(key:&str,version:&str)->bool{let m=manifest();let version=m.packages.get(key).and_then(|package|package.version.as_deref()).unwrap_or(version);let file=base().join(key).join("installed.json");std::fs::read(file).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|v|v["version"]==version)}
async fn update(st:&Arc<crate::AppState>,phase:&str,package:&str,received:u64,total:u64,error:Option<String>){
 let status=InstallStatus{phase:phase.into(),package:package.into(),received,total,error,version:manifest().version};
 *st.workspace.linux.install.lock().await=status.clone();st.broadcast_all(&json!({"type":"linux-install-state","state":status}));
}
pub async fn start(st:&Arc<crate::AppState>)->Result<Value,String>{
 use std::sync::atomic::Ordering;
 let m=manifest();let keys=package_keys();if keys.is_empty(){return Err("此平台暂不支持Linux工作区".into());}
 if keys.iter().any(|key|!m.packages.contains_key(*key)){return Err("此版本的Linux运行组件尚未发布，请更新应用后再安装".into());}
 if st.workspace.linux.installing.swap(true,Ordering::SeqCst){return Err("Linux工作区正在安装".into());}
 st.workspace.linux.cancel.send_replace(false);
 let task=st.clone();tokio::spawn(async move{
  let result=install(&task,m,keys).await;
  if let Err(error)=result{let previous=task.workspace.linux.install.lock().await.clone();update(&task,if *task.workspace.linux.cancel.borrow(){"paused"}else{"failed"},&previous.package,previous.received,previous.total,Some(error)).await;}
  task.workspace.linux.installing.store(false,Ordering::SeqCst);
 });
 Ok(json!({"started":true}))
}
fn cancel(st:&crate::AppState)->Result<(),String>{if *st.workspace.linux.cancel.borrow(){Err("安装已暂停，下次继续会复用已下载内容".into())}else{Ok(())}}
async fn install(st:&Arc<crate::AppState>,m:Manifest,keys:Vec<&'static str>)->Result<(),String>{
 tokio::fs::create_dir_all(base().join("downloads")).await.map_err(|e|e.to_string())?;
 for key in keys{
  cancel(st)?;if installed(key,&m.version){continue;}
  let package=&m.packages[key];let archive=download(st,key,package).await?;cancel(st)?;
  update(st,"extracting",key,package.bytes,package.bytes,None).await;
  let target=base().join(key);let package=package.clone();let version=package.version.clone().unwrap_or_else(||m.version.clone());
  tokio::task::spawn_blocking(move||install_archive(&archive,&target,&package,&version)).await.map_err(|e|e.to_string())??;
 }
 #[cfg(target_os="android")]{
  update(st,"confirm-installation","android",0,0,None).await;
  let path=base().join(platform()).join("runner.apk");let result=super::android::request(json!({"op":"install","path":path})).await?;
  if result["confirmationRequired"]!=true{update(st,"installed","",0,0,None).await;}
 }
 #[cfg(not(target_os="android"))]update(st,"installed","",0,0,None).await;
 Ok(())
}
async fn download(st:&Arc<crate::AppState>,key:&str,package:&Package)->Result<PathBuf,String>{
 if package.bytes==0||package.bytes>512*1024*1024||package.sha256.len()!=64{return Err("运行组件清单无效".into());}
 let target=base().join("downloads").join(&package.file);let part=target.with_extension("part");
 if tokio::fs::try_exists(&target).await.unwrap_or(false)&&verify(&target,&package.sha256).await?{return Ok(target);}
 let client=reqwest::Client::builder().user_agent("ShellPilot/LinuxWorkspace").connect_timeout(Duration::from_secs(12)).timeout(Duration::from_secs(900)).build().map_err(|e|e.to_string())?;
 let mut last="下载源不可用".to_string();
 let mut paused=st.workspace.linux.cancel.subscribe();
 for round in 0..3{
  for url in &package.urls{
   cancel(st)?;if !url.starts_with("https://"){return Err("运行组件必须通过HTTPS下载".into());}
   let mut offset=tokio::fs::metadata(&part).await.map(|m|m.len()).unwrap_or(0);
   if offset>package.bytes{tokio::fs::remove_file(&part).await.map_err(|e|e.to_string())?;offset=0;}
   if offset==package.bytes{
    if verify(&part,&package.sha256).await?{tokio::fs::rename(&part,&target).await.map_err(|e|e.to_string())?;return Ok(target);}
    tokio::fs::remove_file(&part).await.map_err(|e|e.to_string())?;offset=0;
   }
   let request=if offset>0{client.get(url).header(reqwest::header::RANGE,format!("bytes={offset}-"))}else{client.get(url)};let request=request.header(reqwest::header::ACCEPT,"application/octet-stream");
   let response=match tokio::select!{result=request.send()=>result,_=paused.changed()=>return Err("安装已暂停，下次继续会复用已下载内容".into())}{Ok(r)=>r,Err(e)=>{last=format!("下载失败：{e}");continue;}};
   if !response.status().is_success(){last=format!("下载源返回HTTP {}",response.status());continue;}
   if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value|value.to_str().ok()).is_some_and(|value|value.starts_with("application/json")||value.starts_with("text/html")){last="下载源返回了说明页面，已保留原有下载进度".into();continue;}
   if response.status()==reqwest::StatusCode::PARTIAL_CONTENT{
    let expected=format!("bytes {offset}-");if !response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|h|h.to_str().ok()).is_some_and(|h|h.starts_with(&expected)&&h.ends_with(&format!("/{}",package.bytes))){last="续传响应不匹配".into();continue;}
   }else{offset=0;}
   let mut file=tokio::fs::OpenOptions::new().create(true).write(true).append(offset>0).truncate(offset==0).open(&part).await.map_err(|e|e.to_string())?;
   let mut stream=response.bytes_stream();let mut received=offset;let mut tick=Instant::now()-Duration::from_secs(1);let mut failed=false;
   while let Some(chunk)=tokio::select!{chunk=stream.next()=>chunk,_=paused.changed()=>{file.sync_all().await.map_err(|e|e.to_string())?;return Err("安装已暂停，下次继续会复用已下载内容".into());}}{
    cancel(st)?;let chunk=match chunk{Ok(c)=>c,Err(e)=>{last=format!("下载中断：{e}");failed=true;break;}};
    received+=chunk.len() as u64;if received>package.bytes{return Err("下载内容超过清单大小，已拒绝安装".into());}
    file.write_all(&chunk).await.map_err(|e|e.to_string())?;
    if tick.elapsed()>Duration::from_millis(250){update(st,"downloading",key,received,package.bytes,None).await;tick=Instant::now();}
   }
   file.sync_all().await.map_err(|e|e.to_string())?;drop(file);
   if failed||received!=package.bytes{continue;}
   update(st,"verifying",key,received,package.bytes,None).await;
   if !verify(&part,&package.sha256).await?{tokio::fs::remove_file(&part).await.map_err(|e|e.to_string())?;last="运行组件校验失败，已拒绝安装".into();continue;}
   tokio::fs::rename(&part,&target).await.map_err(|e|e.to_string())?;return Ok(target);
  }
  if round<2{tokio::time::sleep(Duration::from_secs(1)).await;}
 }
 Err(last)
}
async fn verify(path:&Path,expected:&str)->Result<bool,String>{let path=path.to_owned();let expected=expected.to_owned();tokio::task::spawn_blocking(move||{
 use std::io::Read;let mut file=std::fs::File::open(path).map_err(|e|e.to_string())?;let mut hash=Sha256::new();let mut buffer=[0u8;65536];loop{let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&buffer[..n]);}Ok(format!("{:x}",hash.finalize())==expected)
}).await.map_err(|e|e.to_string())?}
fn install_archive(archive:&Path,target:&Path,package:&Package,version:&str)->Result<(),String>{
 let staging=target.with_extension("staging");if staging.exists(){std::fs::remove_dir_all(&staging).map_err(|e|e.to_string())?;}std::fs::create_dir_all(&staging).map_err(|e|e.to_string())?;
 if package.file.ends_with(".apk"){std::fs::copy(archive,staging.join("runner.apk")).map_err(|e|e.to_string())?;}else{
  let reader=flate2::read::GzDecoder::new(std::fs::File::open(archive).map_err(|e|e.to_string())?);let mut tar=tar::Archive::new(reader);let mut total=0u64;
  for entry in tar.entries().map_err(|e|e.to_string())?{let mut entry=entry.map_err(|e|e.to_string())?;let kind=entry.header().entry_type();if !kind.is_file()&&!kind.is_dir(){return Err("运行组件包含不允许的链接或设备文件".into());}
   let path=entry.path().map_err(|e|e.to_string())?;if path.is_absolute()||path.components().any(|c|!matches!(c,std::path::Component::Normal(_)|std::path::Component::CurDir)){return Err("运行组件文件路径无效".into());}
   total=total.checked_add(entry.size()).ok_or("运行组件过大")?;if total>package.expanded_bytes{return Err("解压大小超过运行组件清单".into());}
   if !entry.unpack_in(&staging).map_err(|e|e.to_string())?{return Err("运行组件文件越界".into());}
  }
 }
 std::fs::write(staging.join("installed.json"),serde_json::to_vec(&json!({"version":version,"sha256":package.sha256})).unwrap()).map_err(|e|e.to_string())?;
 if target.exists(){std::fs::remove_dir_all(target).map_err(|e|e.to_string())?;}std::fs::rename(staging,target).map_err(|e|e.to_string())
}
pub async fn status(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::Json<Value>{axum::Json(st.workspace.linux.status().await)}
pub async fn install_route(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::response::Response{super::result(start(&st).await)}
pub async fn pause(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::Json<Value>{st.workspace.linux.cancel.send_replace(true);axum::Json(json!({"paused":true}))}
pub async fn stop(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::Json<Value>{st.workspace.generation.send_modify(|n|*n+=1);st.workspace.linux.stop().await;axum::Json(json!({"stopped":true}))}
pub async fn run(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::response::Response{super::result(super::linux_vm::start(&st).await.map(|_|json!({"running":true})))}
pub async fn terminal_route(ws:axum::extract::ws::WebSocketUpgrade,axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>,axum::extract::Query(args):axum::extract::Query<std::collections::HashMap<String,String>>)->axum::response::Response{
 ws.on_upgrade(move|mut socket|async move{let path=args.get("path").cloned().unwrap_or_default();if !path.is_empty(){if let Err(error)=super::upload::valid_path(&path){let _=socket.send(axum::extract::ws::Message::Text(format!("\r\n{error}\r\n").into())).await;return;}}
  if let Err(error)=super::linux_vm::start(&st).await{let _=socket.send(axum::extract::ws::Message::Text(format!("\r\n{error}\r\n").into())).await;return;}
  let _=super::linux_vm::terminal(st,socket,path).await;
 })
}
pub fn lifecycle(st:&Arc<crate::AppState>){let weak=Arc::downgrade(st);tokio::spawn(async move{
 if let Some(st)=weak.upgrade(){let config=st.workspace.config.lock().await.clone();if config.enabled&&config.engine=="linux"&&config.auto_start{let _=super::linux_vm::start(&st).await;}}
 loop{tokio::time::sleep(Duration::from_secs(30)).await;let Some(st)=weak.upgrade()else{break;};let config=st.workspace.config.lock().await.clone();
  if !config.auto_start&&!st.agent.lock().await.busy&&st.workspace.linux.terminals.load(std::sync::atomic::Ordering::SeqCst)==0&&crate::now_ms()-st.workspace.linux.last_used.load(std::sync::atomic::Ordering::SeqCst)>300000{
   #[cfg(target_os="android")]{st.workspace.linux.stop().await;}
   #[cfg(not(target_os="android"))]if let Ok(mut guard)=st.workspace.linux.vm.try_lock(){if let Some(mut vm)=guard.take(){vm.stop().await;}}
  }
 }
});}
pub async fn uninstall(axum::extract::State(st):axum::extract::State<Arc<crate::AppState>>)->axum::response::Response{super::result(uninstall_inner(&st).await)}
pub async fn uninstall_inner(st:&Arc<crate::AppState>)->Result<Value,String>{
 if st.workspace.linux.installing.load(std::sync::atomic::Ordering::SeqCst){return Err("请先暂停安装，再卸载运行环境".into());}
 if st.agent.lock().await.busy{return Err("请先停止AI任务，再卸载运行环境".into());}
 let _permit=st.workspace.mutation.clone().try_lock_owned().map_err(|_|"工作区正在处理文件，请稍后卸载")?;
 st.workspace.generation.send_modify(|n|*n+=1);st.workspace.linux.stop().await;
 let mut config=st.workspace.config.lock().await;
 if config.engine=="linux"{config.enabled=false;crate::save_json("workspace.json",&json!(*config));}
 drop(config);
 #[cfg(target_os="android")]{super::android::request(json!({"op":"uninstall"})).await?;}
 let directory=base();tokio::task::spawn_blocking(move||{
  if directory.exists(){let metadata=std::fs::symlink_metadata(&directory).map_err(|e|e.to_string())?;if metadata.file_type().is_symlink(){return Err("运行组件目录不能是链接".into());}std::fs::remove_dir_all(directory).map_err(|e|e.to_string())?;}Ok::<(),String>(())
 }).await.map_err(|e|e.to_string())??;
 update(st,"not-installed","",0,0,None).await;st.broadcast_all(&json!({"type":"workspace-changed"}));Ok(json!({"uninstalled":true,"filesPreserved":true}))
}
