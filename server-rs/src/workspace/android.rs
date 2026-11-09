use serde_json::{Value,json};
#[cfg(target_os="android")]static BRIDGE:std::sync::Mutex<Option<(std::sync::Arc<jni::JavaVM>,jni::objects::GlobalRef)>>=std::sync::Mutex::new(None);
#[cfg(target_os="android")]pub fn initialize(env:&jni::JNIEnv,activity:&jni::objects::JObject)->Result<(),String>{let vm=std::sync::Arc::new(env.get_java_vm().map_err(|e|e.to_string())?);let activity=env.new_global_ref(activity).map_err(|e|e.to_string())?;*BRIDGE.lock().map_err(|e|e.to_string())?=Some((vm,activity));Ok(())}
pub async fn request(body:Value)->Result<Value,String>{
 #[cfg(target_os="android")]{
  tokio::task::spawn_blocking(move||{
   let started=std::time::Instant::now();
   let(vm,activity)=loop{if let Some(context)=BRIDGE.lock().map_err(|e|e.to_string())?.as_ref(){break (context.0.clone(),context.1.clone());}if started.elapsed()>std::time::Duration::from_secs(5){return Err("安卓工作区接口尚未就绪，请重新打开页面".into());}std::thread::sleep(std::time::Duration::from_millis(50));};
   let mut env=vm.attach_current_thread().map_err(|e|e.to_string())?;
   let input=env.new_string(body.to_string()).map_err(|e|e.to_string())?;let object=jni::objects::JObject::from(input);
   let result=env.call_method(activity.as_obj(),"workspaceRuntime","(Ljava/lang/String;)Ljava/lang/String;",&[jni::objects::JValue::Object(&object)]).map_err(|e|format!("安卓工作区接口不可用：{e}"))?.l().map_err(|e|e.to_string())?;
   let text:String=env.get_string(&jni::objects::JString::from(result)).map_err(|e|e.to_string())?.into();let value:Value=serde_json::from_str(&text).map_err(|e|e.to_string())?;
   if let Some(error)=value["error"].as_str(){Err(error.into())}else{Ok(value)}
  }).await.map_err(|e|e.to_string())?
 }
 #[cfg(not(target_os="android"))]{let _=body;Err("此平台没有安卓运行组件".into())}
}
pub async fn ready()->Result<bool,String>{Ok(request(json!({"op":"status"})).await?["installed"].as_bool().unwrap_or(false))}
pub async fn action(name:&str,args:&Value,network:bool)->Result<Value,String>{request(json!({"op":"action","name":name,"arguments":args,"network":network})).await}
pub async fn upload(args:&std::collections::HashMap<String,String>,multipart:&mut axum::extract::Multipart)->Result<Value,String>{
 use tokio::io::AsyncWriteExt;
 let directory=args.get("path").cloned().unwrap_or_default();let mut files=Vec::new();
 while let Some(mut field)=multipart.next_field().await.map_err(|e|e.to_string())?{
  let name=field.file_name().ok_or("请选择文件")?.to_string();if name.contains(['/','\\',':'])||name=="."||name==".."{return Err("文件名无效".into());}
  let path=if directory.is_empty(){name}else{format!("{directory}/{name}")};let local=crate::data_dir().join(format!(".workspace-upload-{}",uuid::Uuid::new_v4().simple()));
  let transfer=async{let mut file=tokio::fs::File::create(&local).await.map_err(|e|e.to_string())?;let mut bytes=0u64;
   while let Some(chunk)=field.chunk().await.map_err(|e|e.to_string())?{bytes+=chunk.len() as u64;if bytes>1024*1024*1024{return Err("上传超过1GB，请分批处理".into());}file.write_all(&chunk).await.map_err(|e|e.to_string())?;}file.sync_all().await.map_err(|e|e.to_string())?;drop(file);
   request(json!({"op":"import","path":path,"localPath":local})).await?;Ok::<(),String>(())
  }.await;let _=tokio::fs::remove_file(&local).await;transfer?;files.push(path);
 }Ok(json!({"files":files}))
}
pub async fn download(args:&std::collections::HashMap<String,String>)->axum::response::Response{
 use axum::response::IntoResponse;
 let path=args.get("path").cloned().unwrap_or_default();let local=crate::data_dir().join(format!(".workspace-download-{}",uuid::Uuid::new_v4().simple()));
 if let Err(error)=request(json!({"op":"export","path":path,"localPath":local})).await{return super::result(Err(error));}
 let file=match tokio::fs::File::open(&local).await{Ok(file)=>file,Err(error)=>return super::result(Err(error.to_string()))};
 struct Temp(std::path::PathBuf);impl Drop for Temp{fn drop(&mut self){let _=std::fs::remove_file(&self.0);}}
 let cleanup=Temp(local);use futures_util::StreamExt;let stream=tokio_util::io::ReaderStream::new(file).map(move|chunk|{let _=&cleanup;chunk});
 let name=std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy();
 ([(axum::http::header::CONTENT_TYPE,"application/octet-stream".into()),(axum::http::header::CONTENT_DISPOSITION,format!("attachment; filename*=UTF-8''{}",percent_encoding::utf8_percent_encode(&name,percent_encoding::NON_ALPHANUMERIC)))],axum::body::Body::from_stream(stream)).into_response()
}
pub async fn terminal(st:std::sync::Arc<crate::AppState>,socket:axum::extract::ws::WebSocket)->Result<(),String>{
 use futures_util::{SinkExt,StreamExt};
 let config=st.workspace.config.lock().await.clone();if !config.enabled{return Err("工作区已关闭".into());}
 request(json!({"op":"terminal-open","network":config.network})).await?;
 st.workspace.linux.terminals.fetch_add(1,std::sync::atomic::Ordering::SeqCst);st.workspace.linux.touch();
 struct Session(std::sync::Arc<crate::AppState>);impl Drop for Session{fn drop(&mut self){self.0.workspace.linux.terminals.fetch_sub(1,std::sync::atomic::Ordering::SeqCst);self.0.workspace.linux.touch();}}
 let _session=Session(st.clone());
 let (mut sender,mut receiver)=socket.split();let mut interval=tokio::time::interval(std::time::Duration::from_millis(150));let mut generation=st.workspace.generation.subscribe();
 loop{tokio::select!{
  _=interval.tick()=>{let output=request(json!({"op":"terminal-output"})).await?;if let Some(text)=output["output"].as_str(){if !text.is_empty()&&sender.send(axum::extract::ws::Message::Text(text.into())).await.is_err(){break;}}if output["closed"]==true{break;}},
  message=receiver.next()=>match message{Some(Ok(axum::extract::ws::Message::Text(text)))=>{if text.len()>65536{break;}let message:Value=serde_json::from_str(&text).unwrap_or(json!({}));if message["type"]=="resize"{request(json!({"op":"terminal-resize","cols":message["cols"],"rows":message["rows"]})).await?;}else if message["type"]=="input"{request(json!({"op":"terminal-input","data":message["data"]})).await?;}},Some(Ok(axum::extract::ws::Message::Close(_)))|None=>break,_=>{}},
  _=generation.changed()=>break
 }}let _=request(json!({"op":"terminal-close"})).await;Ok(())
}
