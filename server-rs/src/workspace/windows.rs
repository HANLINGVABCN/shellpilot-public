use std::path::Path;
use serde_json::{Value,json};
pub struct DirectoryLease{
 #[cfg(windows)]_handles:Vec<native::DirectoryHandle>,
}
pub fn hold_directory(root:&Path,directory:&Path)->Result<DirectoryLease,String>{
 #[cfg(windows)]{Ok(DirectoryLease{_handles:native::hold_directory(root,directory)?})}
 #[cfg(not(windows))]{let _=(root,directory);Ok(DirectoryLease{})}
}
pub fn read_file(path:&Path)->Result<std::fs::File,String>{
 #[cfg(windows)]{native::read_file(path)}
 #[cfg(not(windows))]{std::fs::File::open(path).map_err(|e|e.to_string())}
}
pub fn prepare(root:&Path)->Result<(),String>{
 #[cfg(windows)]{native::prepare(root)}
 #[cfg(not(windows))]{let _=root;Err("隔离命令执行目前仅支持Windows".into())}
}
pub fn release(root:&Path)->Result<(),String>{
 #[cfg(windows)]{native::release(root)}
 #[cfg(not(windows))]{let _=root;Ok(())}
}
pub fn pick_folder()->Result<Option<String>,String>{
 #[cfg(windows)]{
  use std::os::windows::process::CommandExt;
  let exe=std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows系统目录不可用")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
  let out=std::process::Command::new(exe).args(["-NoProfile","-STA","-Command","$f=(New-Object -ComObject Shell.Application).BrowseForFolder(0,'选择 AI 工作区文件夹',1,0);if($f){[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$f.Self.Path}"]).creation_flags(0x08000000).output().map_err(|e|e.to_string())?;
  if !out.status.success(){return Err("无法打开目录选择器".into());}
  let s=String::from_utf8_lossy(&out.stdout).trim().to_string();Ok(if s.is_empty(){None}else{Some(s)})
 }
 #[cfg(not(windows))]{Err("目录选择器目前仅支持Windows".into())}
}
pub async fn execute(root:&Path,command:&str,network:bool,timeout:u64,cancel:Option<tokio::sync::watch::Receiver<bool>>,mut generation:tokio::sync::watch::Receiver<u64>)->Result<Value,String>{
 #[cfg(windows)]{
  let mut process=native::spawn(root,command,network)?;
  let started=std::time::Instant::now();
  let stdout=process.stdout.take().unwrap();let stderr=process.stderr.take().unwrap();
  let out_task=tokio::task::spawn_blocking(move||read_output(stdout));
  let err_task=tokio::task::spawn_blocking(move||read_output(stderr));
  let mut reason=None;
  let cancel=cancel;
  loop{
   if let Some(code)=process.exit_code()?{
    process.stop_children();
    let(stdout,trunc_out)=out_task.await.map_err(|e|e.to_string())?;
    let(stderr,trunc_err)=err_task.await.map_err(|e|e.to_string())?;
    return Ok(json!({"exitCode":code,"stdout":stdout,"stderr":stderr,"truncated":trunc_out||trunc_err,"durationMs":started.elapsed().as_millis(),"sandbox":"AppContainer","cancelled":reason}));
   }
   if cancel.as_ref().is_some_and(|s|*s.borrow()){reason=Some("任务已停止");break;}
   if started.elapsed().as_millis()>=timeout as u128{reason=Some("工作区命令超时");break;}
   tokio::select!{
    _=tokio::time::sleep(std::time::Duration::from_millis(50))=>{},
    result=generation.changed()=>{let _=result;reason=Some("工作区已变更");break;}
   }
  }
  process.stop_children();
  let(stdout,trunc_out)=out_task.await.map_err(|e|e.to_string())?;
  let(stderr,trunc_err)=err_task.await.map_err(|e|e.to_string())?;
  Ok(json!({"exitCode":-1,"stdout":stdout,"stderr":stderr,"truncated":trunc_out||trunc_err,"durationMs":started.elapsed().as_millis(),"sandbox":"AppContainer","error":reason}))
 }
 #[cfg(not(windows))]{let _=(root,command,network,timeout,cancel,generation);Err("隔离命令执行目前仅支持Windows".into())}
}
#[cfg(windows)]fn read_output(mut file:std::fs::File)->(String,bool){
 use std::io::Read;
 let mut out=Vec::new();let mut part=[0;8192];let mut truncated=false;
 loop{match file.read(&mut part){Ok(0)|Err(_)=>break,Ok(n)=>{let used=(128*1024-out.len()).min(n);out.extend_from_slice(&part[..used]);truncated|=used<n;}}}
 (String::from_utf8_lossy(&out).to_string(),truncated)
}
#[cfg(windows)]mod native{
 use super::*;
 use std::{ffi::c_void,mem::{size_of,size_of_val,zeroed},ptr::{null,null_mut},os::windows::{ffi::OsStrExt,io::FromRawHandle,process::CommandExt},path::PathBuf};
 type Handle=isize;type Sid=*mut c_void;
 #[repr(C)]struct SecurityAttributes{length:u32,descriptor:*mut c_void,inherit:i32}
 #[repr(C)]struct SidAttributes{sid:Sid,attributes:u32}
 #[repr(C)]struct SecurityCapabilities{sid:Sid,capabilities:*mut SidAttributes,count:u32,reserved:u32}
 #[repr(C)]struct StartupInfo{size:u32,reserved:*mut u16,desktop:*mut u16,title:*mut u16,x:u32,y:u32,xsize:u32,ysize:u32,xchars:u32,ychars:u32,fill:u32,flags:u32,show:u16,reserved_size:u16,reserved_bytes:*mut u8,stdin:Handle,stdout:Handle,stderr:Handle}
 #[repr(C)]struct StartupEx{info:StartupInfo,attributes:*mut c_void}
 #[repr(C)]struct ProcessInfo{process:Handle,thread:Handle,pid:u32,tid:u32}
 #[repr(C)]struct BasicLimits{process_time:i64,job_time:i64,flags:u32,min_working:usize,max_working:usize,active:u32,affinity:usize,priority:u32,scheduling:u32}
 #[repr(C)]struct IoCounters{read_ops:u64,write_ops:u64,other_ops:u64,read_bytes:u64,write_bytes:u64,other_bytes:u64}
 #[repr(C)]struct ExtendedLimits{basic:BasicLimits,io:IoCounters,process_memory:usize,job_memory:usize,peak_process:usize,peak_job:usize}
 #[repr(C)]struct FileInfo{attributes:u32,created:[u32;2],accessed:[u32;2],written:[u32;2],volume:u32,size_high:u32,size_low:u32,links:u32,index_high:u32,index_low:u32}
 #[link(name="kernel32")]extern "system"{
  fn CloseHandle(handle:Handle)->i32;
  fn CreatePipe(read:*mut Handle,write:*mut Handle,attributes:*const SecurityAttributes,size:u32)->i32;
  fn SetHandleInformation(handle:Handle,mask:u32,flags:u32)->i32;
  fn InitializeProcThreadAttributeList(list:*mut c_void,count:u32,flags:u32,bytes:*mut usize)->i32;
  fn UpdateProcThreadAttribute(list:*mut c_void,flags:u32,attribute:usize,value:*mut c_void,size:usize,previous:*mut c_void,return_size:*mut usize)->i32;
  fn DeleteProcThreadAttributeList(list:*mut c_void);
  fn CreateProcessW(application:*const u16,command:*mut u16,process_attributes:*const SecurityAttributes,thread_attributes:*const SecurityAttributes,inherit:i32,flags:u32,environment:*const c_void,directory:*const u16,startup:*const StartupInfo,process:*mut ProcessInfo)->i32;
  fn ResumeThread(thread:Handle)->u32;
  fn GetExitCodeProcess(process:Handle,code:*mut u32)->i32;
  fn TerminateProcess(process:Handle,code:u32)->i32;
  fn CreateJobObjectW(attributes:*const SecurityAttributes,name:*const u16)->Handle;
  fn SetInformationJobObject(job:Handle,class:u32,info:*const c_void,size:u32)->i32;
  fn AssignProcessToJobObject(job:Handle,process:Handle)->i32;
  fn TerminateJobObject(job:Handle,code:u32)->i32;
  fn CreateFileW(path:*const u16,access:u32,sharing:u32,attributes:*const SecurityAttributes,disposition:u32,flags:u32,template:Handle)->Handle;
  fn GetFileInformationByHandle(handle:Handle,info:*mut FileInfo)->i32;
 }
 #[link(name="userenv")]extern "system"{
  fn CreateAppContainerProfile(name:*const u16,display:*const u16,description:*const u16,capabilities:*const SidAttributes,count:u32,sid:*mut Sid)->i32;
  fn DeriveAppContainerSidFromAppContainerName(name:*const u16,sid:*mut Sid)->i32;
 }
 #[link(name="advapi32")]extern "system"{
  fn FreeSid(sid:Sid)->Sid;
  fn ConvertSidToStringSidW(sid:Sid,output:*mut *mut u16)->i32;
  fn ConvertStringSidToSidW(input:*const u16,sid:*mut Sid)->i32;
 }
 #[link(name="kernel32")]extern "system"{fn LocalFree(value:*mut c_void)->*mut c_void;}
 fn wide(s:&std::ffi::OsStr)->Vec<u16>{s.encode_wide().chain(Some(0)).collect()}
 fn w(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
 fn error(action:&str)->String{format!("{action}：{}",std::io::Error::last_os_error())}
 fn checked(value:i32,action:&str)->Result<(),String>{if value==0{Err(error(action))}else{Ok(())}}
 struct OwnedSid(Sid);unsafe impl Send for OwnedSid{}
 impl Drop for OwnedSid{fn drop(&mut self){unsafe{FreeSid(self.0);}}}
 fn profile(root:&Path)->Result<OwnedSid,String>{
  use sha2::{Digest,Sha256};
  let hash=format!("{:x}",Sha256::digest(root.to_string_lossy().to_ascii_lowercase().as_bytes()));
  let name=w(&format!("ShellPilot.Workspace.{}",&hash[..32]));
  let mut sid=null_mut();
  let created=unsafe{CreateAppContainerProfile(name.as_ptr(),w("ShellPilot AI Workspace").as_ptr(),w("Local isolated working folder").as_ptr(),null(),0,&mut sid)};
  if created<0{
   let derived=unsafe{DeriveAppContainerSidFromAppContainerName(name.as_ptr(),&mut sid)};
   if derived<0||sid.is_null(){return Err(format!("创建本机沙箱失败：{created:#x}"));}
  }
  Ok(OwnedSid(sid))
 }
 fn sid_string(sid:Sid)->Result<String,String>{
  let mut string=null_mut();checked(unsafe{ConvertSidToStringSidW(sid,&mut string)},"沙箱标识读取失败")?;
  let mut length=0;unsafe{while *string.add(length)!=0{length+=1;}}
  let s=unsafe{String::from_utf16_lossy(std::slice::from_raw_parts(string,length))};unsafe{LocalFree(string.cast());}Ok(s)
 }
 pub fn prepare(root:&Path)->Result<(),String>{
  let sid=profile(root)?;let id=sid_string(sid.0)?;
  // Add only this AppContainer's inheritable Modify ACL, preserving other ACLs.
  let out=std::process::Command::new("icacls.exe").arg(root).arg("/grant").arg(format!("*{id}:(OI)(CI)M")).arg("/Q").creation_flags(0x08000000).output().map_err(|e|e.to_string())?;
  if !out.status.success(){return Err("无法授予沙箱工作区权限，请选择你能修改权限的文件夹".into());}
  std::fs::create_dir_all(root.join(".shellpilot")).map_err(|e|e.to_string())?;Ok(())
 }
 pub fn release(root:&Path)->Result<(),String>{
  let sid=profile(root)?;let id=sid_string(sid.0)?;
  let out=std::process::Command::new("icacls.exe").arg(root).arg("/remove:g").arg(format!("*{id}")).arg("/Q").creation_flags(0x08000000).output().map_err(|e|e.to_string())?;
  if !out.status.success(){return Err("工作区沙箱权限清理失败".into());}Ok(())
 }
 struct HandleGuard(Handle);
 impl Drop for HandleGuard{fn drop(&mut self){if self.0!=0{unsafe{CloseHandle(self.0);}}}}
 pub struct DirectoryHandle(HandleGuard);unsafe impl Send for DirectoryHandle{}
 pub fn hold_directory(root:&Path,directory:&Path)->Result<Vec<DirectoryHandle>,String>{
  if !directory.starts_with(root){return Err("目录超出工作区".into());}
  let relative=directory.strip_prefix(root).map_err(|e|e.to_string())?;
  let mut paths=vec![root.to_path_buf()];let mut p=root.to_path_buf();
  for part in relative.components(){p.push(part.as_os_str());paths.push(p.clone());}
  let mut guards=Vec::new();
  for path in paths{
   let raw=unsafe{CreateFileW(wide(path.as_os_str()).as_ptr(),0x80,1,null(),3,0x02000000|0x00200000,0)};
   if raw==-1{return Err(error("工作区目录正在被修改或不可访问"));}
   let handle=HandleGuard(raw);let mut info:FileInfo=unsafe{zeroed()};
   checked(unsafe{GetFileInformationByHandle(raw,&mut info)},"工作区目录检查失败")?;
   if info.attributes&0x400!=0||info.attributes&0x10==0{return Err("不允许通过目录联接越过工作区".into());}
   guards.push(DirectoryHandle(handle));
  }
  Ok(guards)
 }
 pub fn read_file(path:&Path)->Result<std::fs::File,String>{
  let raw=unsafe{CreateFileW(wide(path.as_os_str()).as_ptr(),0x80000000,1,null(),3,0x00200000,0)};
  if raw==-1{return Err(error("工作区文件读取失败"));}
  let mut handle=HandleGuard(raw);let mut info:FileInfo=unsafe{zeroed()};
  checked(unsafe{GetFileInformationByHandle(raw,&mut info)},"工作区文件检查失败")?;
  if info.attributes&0x400!=0||info.attributes&0x10!=0||info.links>1{return Err("不能读取工作区中的链接文件".into());}
  let file=unsafe{std::fs::File::from_raw_handle(raw as *mut c_void)};handle.0=0;Ok(file)
 }
 struct Attributes{buffer:Vec<usize>,pointer:*mut c_void}
 impl Drop for Attributes{fn drop(&mut self){unsafe{DeleteProcThreadAttributeList(self.pointer);}}}
 fn attributes()->Result<Attributes,String>{
  let mut bytes=0;unsafe{InitializeProcThreadAttributeList(null_mut(),2,0,&mut bytes);}
  let mut buffer=vec![0usize;(bytes+size_of::<usize>()-1)/size_of::<usize>()];let pointer=buffer.as_mut_ptr().cast();
  checked(unsafe{InitializeProcThreadAttributeList(pointer,2,0,&mut bytes)},"沙箱属性初始化失败")?;
  Ok(Attributes{buffer,pointer})
 }
 fn pipe()->Result<(HandleGuard,HandleGuard),String>{
  let a=SecurityAttributes{length:size_of::<SecurityAttributes>() as u32,descriptor:null_mut(),inherit:1};
  let(mut r,mut wr)=(0,0);checked(unsafe{CreatePipe(&mut r,&mut wr,&a,0)},"命令输出管道创建失败")?;Ok((HandleGuard(r),HandleGuard(wr)))
 }
 pub struct Process{
  process:HandleGuard,job:HandleGuard,pub stdout:Option<std::fs::File>,pub stderr:Option<std::fs::File>,script:PathBuf,
 }
 unsafe impl Send for Process{}
 impl Drop for Process{fn drop(&mut self){self.stop_children();let _=std::fs::remove_file(&self.script);}}
 impl Process{
  pub fn exit_code(&self)->Result<Option<u32>,String>{let mut code=0;checked(unsafe{GetExitCodeProcess(self.process.0,&mut code)},"命令状态读取失败")?;Ok(if code==259{None}else{Some(code)})}
  pub fn stop_children(&mut self){unsafe{TerminateJobObject(self.job.0,1);}}
 }
 pub fn spawn(root:&Path,command:&str,network:bool)->Result<Process,String>{
  let sid=profile(root)?;
  let internal=root.join(".shellpilot");std::fs::create_dir_all(&internal).map_err(|e|e.to_string())?;
  let script=internal.join(format!("task-{}.ps1",uuid::Uuid::new_v4().simple()));
  let content=format!("$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$OutputEncoding=[Text.UTF8Encoding]::new($false)\n$PSModuleAutoLoadingPreference='None'\nImport-Module ($PSHOME+'\\Microsoft.PowerShell.Commands.Management.dll') -ErrorAction Stop\nImport-Module ($PSHOME+'\\Microsoft.PowerShell.Commands.Utility.dll') -ErrorAction Stop\n{command}\n");
  std::fs::write(&script,[&[0xef,0xbb,0xbf][..],content.as_bytes()].concat()).map_err(|e|e.to_string())?;
  let(out_read,out_write)=pipe()?;let(err_read,err_write)=pipe()?;let(in_read,in_write)=pipe()?;
  checked(unsafe{SetHandleInformation(out_read.0,1,0)},"输出继承设置失败")?;
  checked(unsafe{SetHandleInformation(err_read.0,1,0)},"错误输出继承设置失败")?;drop(in_write);
  let attributes=attributes()?;
  let mut network_sid=null_mut();
  if network{checked(unsafe{ConvertStringSidToSidW(w("S-1-15-3-1").as_ptr(),&mut network_sid)},"网络权限设置失败")?;}
  let mut cap=SidAttributes{sid:network_sid,attributes:4};
  let mut capabilities=SecurityCapabilities{sid:sid.0,capabilities:if network{&mut cap}else{null_mut()},count:if network{1}else{0},reserved:0};
  let cap_result=checked(unsafe{UpdateProcThreadAttribute(attributes.pointer,0,0x00020009,(&mut capabilities as *mut SecurityCapabilities).cast(),size_of::<SecurityCapabilities>(),null_mut(),null_mut())},"沙箱能力设置失败");
  cap_result?;
  let mut inherited=[in_read.0,out_write.0,err_write.0];
  checked(unsafe{UpdateProcThreadAttribute(attributes.pointer,0,0x00020002,inherited.as_mut_ptr().cast(),size_of_val(&inherited),null_mut(),null_mut())},"管道隔离设置失败")?;
  let job=HandleGuard(unsafe{CreateJobObjectW(null(),null())});
  if job.0==0{return Err(error("命令进程组创建失败"));}
  let mut limits:ExtendedLimits=unsafe{zeroed()};limits.basic.flags=0x00002000|0x00000008|0x00000100;limits.basic.active=32;limits.process_memory=2*1024*1024*1024;
  checked(unsafe{SetInformationJobObject(job.0,9,(&limits as *const ExtendedLimits).cast(),size_of::<ExtendedLimits>() as u32)},"命令进程限制设置失败")?;
  let mut info:StartupEx=unsafe{zeroed()};info.info.size=size_of::<StartupEx>() as u32;info.info.flags=0x100;info.info.stdin=in_read.0;info.info.stdout=out_write.0;info.info.stderr=err_write.0;info.attributes=attributes.pointer;
  let exe=PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows目录不可用")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
  let exe_w=wide(exe.as_os_str());let root_w=wide(root.as_os_str());
  let mut line=w(&format!("\"{}\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",exe.display(),script.display()));
  // Whitelist the sandbox's environment: no API keys or inherited app tokens.
  let system=std::env::var("SystemRoot").unwrap_or("C:\\Windows".into());
  let env_strings=[format!("SystemRoot={system}"),format!("WINDIR={system}"),format!("PATH={system}\\System32;{system}\\System32\\WindowsPowerShell\\v1.0"),format!("PSModulePath={system}\\System32\\WindowsPowerShell\\v1.0\\Modules"),format!("PSModuleAnalysisCachePath={}",internal.join("ModuleAnalysisCache").display()),format!("TEMP={}",internal.display()),format!("TMP={}",internal.display()),format!("USERPROFILE={}",root.display()),format!("APPDATA={}",internal.display()),format!("LOCALAPPDATA={}",internal.display())];
  let mut env_strings=env_strings.to_vec();env_strings.sort_by_key(|s|s.to_ascii_uppercase());
  let environment:Vec<u16>=env_strings.join("\0").encode_utf16().chain([0,0]).collect();
  let mut pi:ProcessInfo=unsafe{zeroed()};
  let started=unsafe{CreateProcessW(exe_w.as_ptr(),line.as_mut_ptr(),null(),null(),1,0x00080000|0x00000400|0x00000004|0x08000000,environment.as_ptr().cast(),root_w.as_ptr(),&info.info,&mut pi)};
  if !network_sid.is_null(){unsafe{LocalFree(network_sid);}}
  if started==0{let _=std::fs::remove_file(&script);return Err(error("隔离命令启动失败"));}
  let process=HandleGuard(pi.process);let thread=HandleGuard(pi.thread);
  if let Err(e)=checked(unsafe{AssignProcessToJobObject(job.0,process.0)},"隔离进程组绑定失败"){unsafe{TerminateProcess(process.0,1);}return Err(e);}
  if unsafe{ResumeThread(thread.0)}==u32::MAX{return Err(error("命令运行失败"));}
  drop(out_write);drop(err_write);drop(in_read);
  let mut out_read=out_read;let mut err_read=err_read;
  let stdout=unsafe{std::fs::File::from_raw_handle(out_read.0 as *mut c_void)};out_read.0=0;
  let stderr=unsafe{std::fs::File::from_raw_handle(err_read.0 as *mut c_void)};err_read.0=0;
  Ok(Process{process,job,stdout:Some(stdout),stderr:Some(stderr),script})
 }
}
