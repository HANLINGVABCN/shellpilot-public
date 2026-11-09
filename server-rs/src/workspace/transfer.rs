use std::{path::PathBuf,sync::Arc,time::Duration};
use serde_json::{Value,json};
use tokio::io::{AsyncReadExt,AsyncWriteExt};
use russh::ChannelMsg;
use sha2::{Sha256,Digest};
pub async fn transfer(st:&Arc<crate::AppState>,name:&str,host:&str,args:&Value)->Result<Value,String>{
 let _lock=st.workspace.mutation.lock().await;
 let config=st.workspace.config.lock().await.clone();if !config.enabled{return Err("工作区已关闭".into());}
 let relative=crate::operations::text_arg(args,"path")?;let remote=crate::operations::text_arg(args,"remotePath")?;
 crate::operations::safe_path(remote)?;
 let upload=name=="workspace_upload_to_server";
 let mut staging=crate::data_dir().join(format!(".workspace-transfer-{}",uuid::Uuid::new_v4().simple()));
 let local:PathBuf;
 #[cfg(target_os="android")]{
  local=staging.clone();if upload{super::android::request(json!({"op":"export","path":relative,"localPath":local})).await?;}
 }
 #[cfg(not(target_os="android"))]{let root=st.workspace.root().await?;local=super::resolve(&root,relative,!upload)?;if !upload{staging=local.parent().ok_or("文件路径无效")?.join(format!(".workspace-transfer-{}",uuid::Uuid::new_v4().simple()));}}
 let connection=crate::pool::conn_of(st,host).await.map_err(|e|e.to_string())?;
 let mut channel=crate::pool::open_channel(&connection).await.map_err(|e|e.to_string())?;
 let quoted=crate::util::shq(remote);let temp=format!("{remote}.shellpilot-{}",uuid::Uuid::new_v4().simple());let tempq=crate::util::shq(&temp);
 let command=if upload{format!("umask 077; test ! -e {quoted} && test ! -L {quoted} || exit 73; trap 'rm -f -- {tempq}' EXIT; cat > {tempq} && ln -- {tempq} {quoted} && sha256sum -- {quoted}")}else{format!("test -f {quoted} && test ! -L {quoted} && cat -- {quoted}")};
 let operation=async{
  channel.exec(true,command).await.map_err(|e|e.to_string())?;let mut bytes=0u64;let mut hash=Sha256::new();
  if upload{
   let file=super::windows::read_file(&local)?;let mut file=tokio::fs::File::from_std(file);let mut buffer=[0u8;65536];
   loop{let n=file.read(&mut buffer).await.map_err(|e|e.to_string())?;if n==0{break;}bytes+=n as u64;if bytes>1024*1024*1024{return Err("单次传输超过1GB，请分批处理".into());}hash.update(&buffer[..n]);channel.data(&buffer[..n]).await.map_err(|e|e.to_string())?;}
   channel.eof().await.map_err(|e|e.to_string())?;
  }
  let mut file=if upload{None}else{Some(tokio::fs::OpenOptions::new().write(true).create_new(true).open(&staging).await.map_err(|e|e.to_string())?)};
  let mut output=Vec::new();let mut error=Vec::new();let mut exit=None;
  while let Some(message)=channel.wait().await{match message{
   ChannelMsg::Data{data}=>{if let Some(file)=file.as_mut(){bytes+=data.len() as u64;if bytes>1024*1024*1024{return Err("下载文件超过1GB，请分批处理".into());}hash.update(&data);file.write_all(&data).await.map_err(|e|e.to_string())?;}else{let n=data.len().min(4096-output.len());output.extend_from_slice(&data[..n]);}},
   ChannelMsg::ExtendedData{data,..}=>{let n=data.len().min(4096-error.len());error.extend_from_slice(&data[..n]);},ChannelMsg::ExitStatus{exit_status}=>exit=Some(exit_status),ChannelMsg::Close=>break,_=>{}
  }}
  if exit!=Some(0){return Err(format!("文件传输失败（退出码 {:?}）：{}；不会自动重复上传",exit,String::from_utf8_lossy(&error)));}
  let checksum=format!("{:x}",hash.finalize());
  if upload{if !String::from_utf8_lossy(&output).starts_with(&checksum){return Err("上传后的文件校验不一致，请检查远端文件".into());}}
  else{if let Some(mut file)=file{file.sync_all().await.map_err(|e|e.to_string())?;}
   #[cfg(target_os="android")]super::android::request(json!({"op":"import","path":relative,"localPath":staging})).await?;
   #[cfg(not(target_os="android"))]{if local.exists(){return Err("工作区文件已存在，未覆盖".into());}let root=st.workspace.root().await?;let _lease=super::windows::hold_directory(&root,local.parent().ok_or("文件路径无效")?)?;tokio::fs::hard_link(&staging,&local).await.map_err(|e|format!("下载文件已保留到临时文件，但无法写入工作区：{e}"))?;}
  }
  Ok(json!({"hostId":host,"path":relative,"remotePath":remote,"bytes":bytes,"sha256":checksum,"direction":if upload{"upload"}else{"download"}}))
 };
 let result=tokio::time::timeout(Duration::from_secs(600),operation).await.map_err(|_|"文件传输超时，请检查实际结果，不自动重复上传".to_string()).and_then(|r|r);
 let _=channel.close().await;let _=tokio::fs::remove_file(&staging).await;result
}
