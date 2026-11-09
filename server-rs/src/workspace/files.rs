use std::path::Path;
use serde_json::{json,Value};

fn relative(root:&Path,path:&Path)->Result<String,String>{Ok(path.strip_prefix(root).map_err(|_|"路径超出工作区")?.to_string_lossy().replace('\\',"/"))}
fn checked(root:&Path,path:&Path)->Result<(),String>{super::resolve(root,&relative(root,path)?,false)?;Ok(())}
fn remove(root:&Path,path:&Path,recursive:bool)->Result<(),String>{
 if path==root{return Err("不能删除工作区根目录".into());}
 let _parent=super::windows::hold_directory(root,path.parent().ok_or("路径无效")?)?;checked(root,path)?;
 if path.is_dir(){
  if recursive{let _dir=super::windows::hold_directory(root,path)?;for entry in std::fs::read_dir(path).map_err(|e|e.to_string())?{remove(root,&entry.map_err(|e|e.to_string())?.path(),true)?;}}
  std::fs::remove_dir(path).map_err(|e|e.to_string())
 }else{std::fs::remove_file(path).map_err(|e|e.to_string())}
}
fn copy(root:&Path,source:&Path,target:&Path)->Result<(),String>{
 let _source=super::windows::hold_directory(root,source.parent().ok_or("路径无效")?)?;
 let _target=super::windows::hold_directory(root,target.parent().ok_or("路径无效")?)?;checked(root,source)?;
 if target.exists(){return Err("复制目标已经存在".into());}
 if source.is_dir(){
  let _dir=super::windows::hold_directory(root,source)?;std::fs::create_dir(target).map_err(|e|e.to_string())?;
  for entry in std::fs::read_dir(source).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let source=entry.path();let target=target.join(entry.file_name());super::resolve(root,&relative(root,&target)?,true)?;copy(root,&source,&target)?;}
 }else{
  let mut input=super::windows::read_file(source)?;let temp=target.with_file_name(format!(".copy-{}",uuid::Uuid::new_v4().simple()));
  let result=(||{let mut output=std::fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|e|e.to_string())?;std::io::copy(&mut input,&mut output).map_err(|e|e.to_string())?;output.sync_all().map_err(|e|e.to_string())?;drop(output);std::fs::hard_link(&temp,target).map_err(|e|e.to_string())})();let _=std::fs::remove_file(temp);result?;
 }Ok(())
}
pub fn action(root:&Path,name:&str,args:&Value)->Result<Value,String>{
 let path=super::resolve(root,args["path"].as_str().unwrap_or(""),false)?;
 match name{
  "workspace_delete"=>{remove(root,&path,args["recursive"].as_bool().unwrap_or(false))?;},
  "workspace_rename"=>{
   if path==root{return Err("不能重命名工作区根目录".into());}let to=args["to"].as_str().ok_or("缺少目标文件名")?;super::upload::valid_path(to)?;let target=super::resolve(root,to,true)?;
   let _from=super::windows::hold_directory(root,path.parent().ok_or("路径无效")?)?;let _to=super::windows::hold_directory(root,target.parent().ok_or("路径无效")?)?;
   if target.exists()||target.starts_with(&path){return Err("目标已存在或位于源目录内".into());}std::fs::rename(path,target).map_err(|e|e.to_string())?;
  },
  "workspace_copy"=>{
   if !path.is_dir(){return Err("粘贴目标必须是文件夹".into());}let sources=args["paths"].as_array().ok_or("缺少复制文件")?;let moving=args["move"].as_bool().unwrap_or(false);
   for source in sources{
    let source=super::resolve(root,source.as_str().ok_or("源路径无效")?,false)?;if source==root{return Err("不能复制工作区根目录".into());}
    let filename=source.file_name().ok_or("源文件名无效")?.to_string_lossy();let mut target=path.join(filename.as_ref());let mut index=2;
    if moving&&target==source{continue;}
    if target.starts_with(&source){return Err("不能把文件夹放进自身目录".into());}
    while target.exists(){target=path.join(format!("{filename} ({index})"));index+=1;}
    super::resolve(root,&relative(root,&target)?,true)?;
    if moving{let _from=super::windows::hold_directory(root,source.parent().ok_or("路径无效")?)?;let _to=super::windows::hold_directory(root,&path)?;std::fs::rename(&source,&target).map_err(|e|e.to_string())?;}else{copy(root,&source,&target)?;}
   }
  },
  _=>return Err("未知文件操作".into())
 }Ok(json!({"ok":true}))
}
