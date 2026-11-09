use std::{path::{Path,PathBuf},sync::Arc,time::Duration};
use serde_json::{Value,json};
use base64::{Engine,engine::general_purpose::STANDARD};
use tokio::io::{AsyncReadExt,AsyncWriteExt};
use russh::{client,ChannelMsg};
use russh::keys::PublicKeyBase64;

pub struct Vm{pub child:tokio::process::Child,key:Arc<russh::keys::key::KeyPair>,port:u16,root:PathBuf,network:bool,proxy:Option<super::linux_proxy::InternetProxy>,terminal_baseline:Option<std::collections::HashMap<PathBuf,String>>,#[cfg(windows)]_job:super::windows::VmJob}
impl Vm{pub async fn stop(&mut self){
 if let Some(baseline)=self.terminal_baseline.take(){let path=self.root.join(".shellpilot/terminal-output.tar");if command(self,"tar -cf - -C /workspace .; result=$?; sync; exit $result",None,Some(&path),30000).await.is_ok(){let root=self.root.clone();let _=tokio::task::spawn_blocking(move||unpack_outputs(&root,&path,&baseline)).await;}}
 let shutdown=async{let handle=connect(self).await?;let mut channel=handle.channel_open_session().await.map_err(|e|e.to_string())?;channel.exec(true,"sync; /sbin/poweroff -f").await.map_err(|e|e.to_string())?;while let Some(message)=channel.wait().await{if matches!(message,ChannelMsg::Close){break;}}Ok::<(),String>(())};
 let _=tokio::time::timeout(Duration::from_secs(5),shutdown).await;
 if tokio::time::timeout(Duration::from_secs(5),self.child.wait()).await.is_err(){let _=self.child.kill().await;}
}}
struct Guest{expected:String}
#[async_trait::async_trait]impl client::Handler for Guest{
 type Error=russh::Error;
 async fn check_server_key(&mut self,key:&russh::keys::key::PublicKey)->Result<bool,Self::Error>{Ok(key.public_key_base64()==self.expected)}
}
async fn connect(vm:&Vm)->Result<client::Handle<Guest>,String>{
 let config=Arc::new(client::Config{inactivity_timeout:Some(Duration::from_secs(900)),..Default::default()});
 let hostkey=tokio::fs::read_to_string(vm.root.join(".shellpilot/linux-hostkey.pub")).await.map_err(|e|e.to_string())?;
 let expected=hostkey.split_whitespace().nth(1).ok_or("Linux环境身份记录无效")?.to_string();
 let mut handle=tokio::time::timeout(Duration::from_secs(5),client::connect(config,("127.0.0.1",vm.port),Guest{expected})).await.map_err(|_|"Linux环境连接超时")?.map_err(|e|e.to_string())?;
 if !handle.authenticate_publickey("root",vm.key.clone()).await.map_err(|e|e.to_string())?{return Err("Linux环境认证失败".into());}Ok(handle)
}
async fn launch(root:&Path,network:bool)->Result<Vm,String>{
 if !cfg!(windows){return Err("此平台不使用Windows Linux运行器".into());}
 let runtime=super::linux_runtime::base();let qemu=runtime.join("windows-qemu");let guest=runtime.join("windows-guest");
 let key=Arc::new(russh::keys::key::KeyPair::generate_ed25519());
 let public=key.clone_public_key().map_err(|e|e.to_string())?;let key_b64=STANDARD.encode(format!("ssh-ed25519 {}",public.public_key_base64()));
 let internal=root.join(".shellpilot");tokio::fs::create_dir_all(&internal).await.map_err(|e|e.to_string())?;
 let disk=internal.join("linux-disk.qcow2");if !tokio::fs::try_exists(&disk).await.unwrap_or(false){tokio::fs::copy(guest.join("base.qcow2"),&disk).await.map_err(|e|e.to_string())?;tokio::fs::copy(guest.join("hostkey.pub"),internal.join("linux-hostkey.pub")).await.map_err(|e|e.to_string())?;}
 let probe=std::net::TcpListener::bind(("127.0.0.1",0)).map_err(|e|e.to_string())?;let port=probe.local_addr().map_err(|e|e.to_string())?.port();drop(probe);
 let proxy=if network{Some(super::linux_proxy::start().await?)}else{None};
 let diagnostics=std::fs::File::create(internal.join("linux-runtime.log")).map_err(|e|e.to_string())?;
 let console=std::fs::File::create(internal.join("linux-boot.log")).map_err(|e|e.to_string())?;
 let mut command=tokio::process::Command::new(qemu.join("qemu-system-x86_64.exe"));
 command.args(["-machine","q35","-accel","tcg,tb-size=64","-cpu","qemu64","-m","384","-smp","2","-display","none","-monitor","none","-serial","stdio","-no-reboot","-L"]).arg(&qemu)
  .arg("-kernel").arg(guest.join("vmlinuz")).arg("-initrd").arg(guest.join("initramfs"))
  .arg("-append").arg(format!("console=ttyS0 modules=virtio_pci,virtio_blk,ext4 rootfstype=ext4 root=/dev/vda rw init=/sbin/shellpilot-init spkey={key_b64}"))
  .arg("-drive").arg("file=linux-disk.qcow2,format=qcow2,if=virtio")
  .args(["-device","virtio-net-pci,romfile=,netdev=n","-netdev"]).arg(format!("user,id=n,restrict=on,hostfwd=tcp:127.0.0.1:{port}-:22{}",if proxy.is_some(){",guestfwd=tcp:10.0.2.100:3128-chardev:internet"}else{""}))
  .current_dir(&internal).env_clear().stdin(std::process::Stdio::null()).stdout(std::process::Stdio::from(console)).stderr(std::process::Stdio::from(diagnostics)).kill_on_drop(true);
 if let Some(proxy)=&proxy{command.arg("-chardev").arg(format!("socket,id=internet,host=127.0.0.1,port={},reconnect-ms=1000",proxy.port));}
 for name in ["SystemRoot","WINDIR","TEMP","TMP"]{if let Some(value)=std::env::var_os(name){command.env(name,value);}}
 #[cfg(windows)]command.creation_flags(0x08000000);
 let mut child=command.spawn().map_err(|e|format!("无法启动Linux运行器：{e}"))?;
 #[cfg(windows)]let job=match super::windows::vm_job(&child){Ok(job)=>job,Err(error)=>{let _=child.kill().await;return Err(error);}};
 let mut vm=Vm{child,key,port,root:root.to_owned(),network,proxy,terminal_baseline:None,#[cfg(windows)]_job:job};
 let deadline=tokio::time::Instant::now()+Duration::from_secs(90);
 loop{if vm.child.try_wait().map_err(|e|e.to_string())?.is_some(){let log=std::fs::read_to_string(internal.join("linux-runtime.log")).unwrap_or_default();return Err(format!("Linux运行器提前退出：{}",log.chars().take(1500).collect::<String>()));}
  let connection=connect(&vm).await;if connection.is_ok(){return Ok(vm);}if tokio::time::Instant::now()>deadline{let error=connection.err().unwrap_or_default();vm.stop().await;return Err(format!("Linux环境启动超时：{error}"));}tokio::time::sleep(Duration::from_millis(500)).await;
 }
}
async fn command(vm:&Vm,script:&str,input:Option<&Path>,output:Option<&Path>,timeout:u64)->Result<Value,String>{
 let mut handle=connect(vm).await?;let mut channel=handle.channel_open_session().await.map_err(|e|e.to_string())?;
 channel.exec(true,script).await.map_err(|e|e.to_string())?;
 // Upload and receive concurrently so neither pipe blocks the other direction.
 let mut data_file=if let Some(path)=input{Some(tokio::fs::File::open(path).await.map_err(|e|e.to_string())?)}else{None};
 let mut target=if let Some(path)=output{Some(tokio::fs::File::create(path).await.map_err(|e|e.to_string())?)}else{None};
 let mut out=Vec::new();let mut err=Vec::new();let mut code=None;let mut truncated=false;let mut sent=data_file.is_none();let mut downloaded=0u64;
 if sent{channel.eof().await.map_err(|e|e.to_string())?;}
 let started=std::time::Instant::now();let mut buffer=vec![0u8;32768];
 let result=tokio::time::timeout(Duration::from_millis(timeout),async{
  loop{tokio::select!{
   bytes=async{data_file.as_mut().unwrap().read(&mut buffer).await},if !sent=>{
    let n=bytes.map_err(|e|e.to_string())?;if n==0{sent=true;channel.eof().await.map_err(|e|e.to_string())?;}else{channel.data(&buffer[..n]).await.map_err(|e|e.to_string())?;}
   },
   message=channel.wait()=>match message{
    Some(ChannelMsg::Data{data})=>{if let Some(file)=target.as_mut(){downloaded+=data.len() as u64;if downloaded>1024*1024*1024{return Err("Linux输出超过1GB，请分批导出".into());}file.write_all(&data).await.map_err(|e|e.to_string())?;}else{let n=data.len().min(128*1024-out.len());out.extend_from_slice(&data[..n]);truncated|=n<data.len();}},
    Some(ChannelMsg::ExtendedData{data,..})=>{let n=data.len().min(128*1024-err.len());err.extend_from_slice(&data[..n]);truncated|=n<data.len();},
    Some(ChannelMsg::ExitStatus{exit_status})=>code=Some(exit_status),
    Some(ChannelMsg::Close)|None=>break,_=>{}
   }
  }}Ok::<(),String>(())
 }).await;
 let _=channel.close().await;if result.is_err(){return Err("Linux命令超时，执行环境已停止，操作不会自动重放".into());}result.unwrap()?;
 Ok(json!({"exitCode":code.ok_or("Linux连接中断，未收到退出状态")?,"stdout":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"truncated":truncated,"durationMs":started.elapsed().as_millis(),"sandbox":"Linux VM"}))
}
fn successful(value:Value)->Result<Value,String>{if value["exitCode"]==0{Ok(value)}else{Err(format!("Linux操作失败：{}",value["stderr"].as_str().unwrap_or("未知错误")))}}
fn pack(root:&Path,path:&Path)->Result<std::collections::HashMap<PathBuf,String>,String>{
 use std::io::Read;
 let _lease=super::windows::hold_directory(root,root)?;let mut builder=tar::Builder::new(std::fs::File::create(path).map_err(|e|e.to_string())?);let mut baseline=std::collections::HashMap::new();let mut dirs=vec![root.to_owned()];let mut size=0;
 while let Some(dir)=dirs.pop(){let _lease=super::windows::hold_directory(root,&dir)?;for entry in std::fs::read_dir(&dir).map_err(|e|e.to_string())?{
  let entry=entry.map_err(|e|e.to_string())?;let p=entry.path();if entry.file_name()==".shellpilot"{continue;}super::reject_links(&p)?;
  if p.is_dir(){builder.append_dir(p.strip_prefix(root).unwrap(),&p).map_err(|e|e.to_string())?;dirs.push(p);}else{
   let mut file=super::windows::read_file(&p)?;let mut hash=sha2::Sha256::new();use sha2::Digest;let mut bytes=[0u8;65536];loop{let n=file.read(&mut bytes).map_err(|e|e.to_string())?;if n==0{break;}size+=n;if size>1024*1024*1024{return Err("单次工作区同步超过1GB，请缩小工作目录".into());}hash.update(&bytes[..n]);}
   baseline.insert(p.strip_prefix(root).unwrap().to_owned(),format!("{:x}",hash.finalize()));use std::io::Seek;file.rewind().map_err(|e|e.to_string())?;builder.append_file(p.strip_prefix(root).unwrap(),&mut file).map_err(|e|e.to_string())?;
  }
 }}builder.finish().map_err(|e|e.to_string())?;Ok(baseline)
}
fn unpack_outputs(root:&Path,path:&Path,baseline:&std::collections::HashMap<PathBuf,String>)->Result<(),String>{
 let _root_lease=super::windows::hold_directory(root,root)?;
 let mut archive=tar::Archive::new(std::fs::File::open(path).map_err(|e|e.to_string())?);let mut total=0u64;let mut seen=std::collections::HashSet::new();
 for entry in archive.entries().map_err(|e|e.to_string())?{let mut entry=entry.map_err(|e|e.to_string())?;let raw=entry.path().map_err(|e|e.to_string())?.into_owned();let relative=raw.components().filter(|part|!matches!(part,std::path::Component::CurDir)).collect::<PathBuf>();let text=relative.to_string_lossy();let target=super::resolve(root,&text,true)?;
  let kind=entry.header().entry_type();if !kind.is_file()&&!kind.is_dir(){return Err("Linux输出含链接或设备文件，已拒绝同步到电脑".into());}if kind.is_file(){seen.insert(relative.clone());}
  total+=entry.size();if total>1024*1024*1024{return Err("Linux输出超过1GB，请分批导出".into());}
  if kind.is_dir(){if target!=root&&!target.exists(){let _lease=super::windows::hold_directory(root,target.parent().ok_or("目录无效")?)?;std::fs::create_dir(&target).map_err(|e|e.to_string())?;}continue;}
  let parent=target.parent().ok_or("文件路径无效")?;std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;let _lease=super::windows::hold_directory(root,parent)?;
  if target.exists(){use std::io::Read;let mut file=super::windows::read_file(&target)?;let mut hash=sha2::Sha256::new();use sha2::Digest;let mut bytes=[0u8;65536];loop{let n=file.read(&mut bytes).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&bytes[..n]);}let current=format!("{:x}",hash.finalize());if baseline.get(&relative).is_none_or(|old|*old!=current){return Err(format!("本机文件 {} 在命令执行期间已变化，原文件保留，Linux产出仍在工作区环境中",text));}}
  let temp=parent.join(format!(".linux-output-{}",uuid::Uuid::new_v4().simple()));let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|e|e.to_string())?;
  if let Err(error)=std::io::copy(&mut entry,&mut file){drop(file);let _=std::fs::remove_file(&temp);return Err(error.to_string());}file.sync_all().map_err(|e|e.to_string())?;drop(file);std::fs::rename(&temp,&target).map_err(|e|e.to_string())?;
 }
 for(relative,expected)in baseline{if !seen.contains(relative){let target=super::resolve(root,&relative.to_string_lossy(),false)?;let _lease=super::windows::hold_directory(root,target.parent().ok_or("文件路径无效")?)?;let mut file=super::windows::read_file(&target)?;use std::io::Read;use sha2::Digest;let mut hash=sha2::Sha256::new();let mut buffer=[0u8;65536];loop{let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&buffer[..n]);}if format!("{:x}",hash.finalize())!=*expected{return Err(format!("文件 {} 已被你修改，未同步Linux删除操作",relative.display()));}drop(file);std::fs::remove_file(target).map_err(|e|e.to_string())?;}}
 Ok(())
}
pub async fn execute(st:&Arc<crate::AppState>,root:&Path,script:&str,network:bool,timeout:u64)->Result<Value,String>{
 if st.workspace.linux.terminals.load(std::sync::atomic::Ordering::SeqCst)>0{return Err("工作区终端正在使用，请先关闭终端再让AI同步执行".into());}
 let mut vm=st.workspace.linux.vm.lock().await;
 if vm.as_ref().is_some_and(|v|v.root!=root||v.network!=network){if let Some(mut old)=vm.take(){old.stop().await;}}
 if vm.is_none(){*vm=Some(launch(root,network).await?);}
 let v=vm.as_ref().unwrap();let input=root.join(".shellpilot/linux-input.tar");let output=root.join(".shellpilot/linux-output.tar");
 let source=root.to_owned();let input_copy=input.clone();let baseline=tokio::task::spawn_blocking(move||pack(&source,&input_copy)).await.map_err(|e|e.to_string())??;
 successful(command(v,"mkdir -p /workspace; find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +; tar -xf - -C /workspace",Some(&input),None,120000).await?)?;
 let script=format!("cd /workspace && {} /bin/sh -c {}; result=$?; sync; exit $result",if network{"http_proxy=http://10.0.2.100:3128 https_proxy=http://10.0.2.100:3128 HTTP_PROXY=http://10.0.2.100:3128 HTTPS_PROXY=http://10.0.2.100:3128"}else{""},crate::util::shq(script));
 let cancel=st.agent.lock().await.cancel.as_ref().map(|s|s.subscribe());let mut generation=st.workspace.generation.subscribe();
 let result=tokio::select!{
  result=command(v,&script,None,None,timeout)=>result,
  _=async{if let Some(mut receiver)=cancel{loop{if *receiver.borrow(){break;}if receiver.changed().await.is_err(){std::future::pending::<()>().await;}}}else{std::future::pending::<()>().await;}}=>Err("任务已停止".into()),
  _=generation.changed()=>Err("工作区已变更".into())
 };
 if result.is_err(){if let Some(mut process)=vm.take(){process.stop().await;}return result;}
 successful(command(v,"tar -cf - -C /workspace .",None,Some(&output),120000).await?)?;
 let source=root.to_owned();tokio::task::spawn_blocking(move||unpack_outputs(&source,&output,&baseline)).await.map_err(|e|e.to_string())??;
 st.workspace.linux.touch();result
}
pub async fn start(st:&Arc<crate::AppState>)->Result<(),String>{
 let config=st.workspace.config.lock().await.clone();if !config.enabled{return Err("请先启用工作区".into());}if config.engine!="linux"{return Err("请选择内置Alpine Linux运行环境".into());}
 if st.workspace.linux.status().await["installed"]!=true{return Err("请先安装Linux运行环境".into());}
 #[cfg(target_os="android")]{super::android::request(json!({"op":"start","network":config.network})).await?;st.workspace.linux.touch();return Ok(());}
 let root=st.workspace.root().await?;let mut vm=st.workspace.linux.vm.lock().await;
 if vm.is_none(){*vm=Some(launch(&root,config.network).await?);}st.workspace.linux.touch();Ok(())
}
pub async fn terminal(st:Arc<crate::AppState>,socket:axum::extract::ws::WebSocket)->Result<(),String>{
 #[cfg(target_os="android")]return super::android::terminal(st,socket).await;
 use futures_util::{StreamExt,SinkExt};
 start(&st).await?;
 let mut vm=st.workspace.linux.vm.lock().await;let v=vm.as_ref().ok_or("Linux运行环境尚未启动")?;
 let root=v.root.clone();let internal=root.join(".shellpilot");let input=internal.join("terminal-input.tar");let root_copy=root.clone();
 let baseline=tokio::task::spawn_blocking(move||pack(&root_copy,&input)).await.map_err(|e|e.to_string())??;
 successful(command(v,"mkdir -p /workspace; tar -xf - -C /workspace",Some(&internal.join("terminal-input.tar")),None,120000).await?)?;
 let mut handle=connect(v).await?;let mut channel=handle.channel_open_session().await.map_err(|e|e.to_string())?;
 channel.request_pty(true,"xterm-256color",100,28,0,0,&[]).await.map_err(|e|e.to_string())?;channel.request_shell(true).await.map_err(|e|e.to_string())?;
 channel.data(&b"cd /workspace\r"[..]).await.map_err(|e|e.to_string())?;
 if v.network{channel.data(&b"export http_proxy=http://10.0.2.100:3128 https_proxy=http://10.0.2.100:3128\r"[..]).await.map_err(|e|e.to_string())?;}
 vm.as_mut().unwrap().terminal_baseline=Some(baseline.clone());st.workspace.linux.terminals.fetch_add(1,std::sync::atomic::Ordering::SeqCst);drop(vm);
 let (mut output,mut input)=socket.split();let mut generation=st.workspace.generation.subscribe();
 loop{tokio::select!{
  message=input.next()=>match message{Some(Ok(axum::extract::ws::Message::Text(text)))=>{if text.len()>65536{break;}let _=channel.data(text.as_bytes()).await;st.workspace.linux.touch();},Some(Ok(axum::extract::ws::Message::Close(_)))|None=>break,_=>{}},
  message=channel.wait()=>match message{Some(ChannelMsg::Data{data})|Some(ChannelMsg::ExtendedData{data,..})=>{if output.send(axum::extract::ws::Message::Binary(data.to_vec().into())).await.is_err(){break;}},Some(ChannelMsg::Close)|None=>break,_=>{}},
  _=generation.changed()=>break
 }}
 let _=channel.close().await;st.workspace.linux.terminals.fetch_sub(1,std::sync::atomic::Ordering::SeqCst);
 let mut vm=st.workspace.linux.vm.lock().await;if let Some(v)=vm.as_ref(){let path=internal.join("terminal-output.tar");if command(v,"tar -cf - -C /workspace .; result=$?; sync; exit $result",None,Some(&path),120000).await.is_ok(){match tokio::task::spawn_blocking(move||unpack_outputs(&root,&path,&baseline)).await{Ok(Ok(()))=>vm.as_mut().unwrap().terminal_baseline=None,Ok(Err(error))=>st.broadcast_all(&json!({"type":"workspace-error","error":error})),Err(error)=>st.broadcast_all(&json!({"type":"workspace-error","error":error.to_string()}))}}}
 st.workspace.linux.touch();Ok(())
}
