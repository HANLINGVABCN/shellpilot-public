use std::{collections::HashSet,path::{Path,PathBuf},sync::Arc};
use serde::Deserialize;
use serde_json::{json,Value};
use tokio::io::AsyncWriteExt;

#[derive(Default,Deserialize)]
pub struct Manifest {#[serde(default)]pub files:Vec<String>,#[serde(default)]pub directories:Vec<String>}
pub fn valid_path(input:&str)->Result<(),String>{
 if input.is_empty()||input.split('/').any(|part|part.is_empty()||part=="."||part==".."||part.eq_ignore_ascii_case(".shellpilot")||part.ends_with([' ','.'])||part.chars().any(|c|c.is_control()||"\\:<>\"|?*".contains(c))||{
  let stem=part.split('.').next().unwrap_or("").to_ascii_uppercase();matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL")||(stem.starts_with("COM")||stem.starts_with("LPT"))&&stem.len()==4&&stem.as_bytes()[3].is_ascii_digit()
 }){return Err(format!("上传路径无效：{input}"));}Ok(())
}
pub fn plan(manifest:&Manifest)->Result<Vec<String>,String>{
 let mut files=HashSet::new();let mut dirs=HashSet::new();
 for file in &manifest.files{valid_path(file)?;if !files.insert(file.to_lowercase()){return Err(format!("上传包含重名文件：{file}"));}let mut parent=file.as_str();while let Some((path,_))=parent.rsplit_once('/'){dirs.insert(path.to_string());parent=path;}}
 for dir in &manifest.directories{valid_path(dir)?;let mut parent=dir.as_str();dirs.insert(parent.to_string());while let Some((path,_))=parent.rsplit_once('/'){dirs.insert(path.to_string());parent=path;}}
 if dirs.iter().any(|dir|files.contains(&dir.to_lowercase())){return Err("上传中文件和文件夹路径冲突".into());}
 let mut dirs:Vec<_>=dirs.into_iter().collect();dirs.sort_by_key(|path|(path.matches('/').count(),path.clone()));Ok(dirs)
}
pub fn join(directory:&str,path:&str)->String{if directory.is_empty(){path.into()}else{format!("{directory}/{path}")}}
pub fn ensure_directory(root:&Path,path:&str)->Result<PathBuf,String>{
 let mut current=String::new();let mut target=root.to_path_buf();
 for part in path.split('/').filter(|part|!part.is_empty()){
  current=join(&current,part);target=super::resolve(root,&current,true)?;
  let _lease=super::windows::hold_directory(root,target.parent().ok_or("目录无效")?)?;
  if !target.exists(){std::fs::create_dir(&target).map_err(|e|e.to_string())?;}
  if !target.is_dir(){return Err(format!("目标被文件占用：{current}"));}
 }Ok(target)
}
#[cfg(not(target_os="android"))]
fn preflight(root:&Path,path:&str,directory:bool)->Result<(),String>{
 let mut current=String::new();
 for part in path.split('/'){
  current=join(&current,part);let target=root.join(&current);
  if std::fs::symlink_metadata(&target).is_err(){return Ok(());}
  super::resolve(root,&current,false)?;
  if current==path&&!directory{return Err(format!("文件 {path} 已存在，请先改名或删除旧文件"));}
  if !target.is_dir(){return Err(format!("目录被文件占用：{current}"));}
 }Ok(())
}
#[cfg(target_os="android")]
async fn android_directory(path:&str)->Result<(),String>{
 let mut current=String::new();
 for part in path.split('/').filter(|part|!part.is_empty()){
  let parent=current.clone();current=join(&current,part);
  let list=super::android::action("workspace_list",&json!({"path":parent}),false).await?;
  match list["entries"].as_array().and_then(|entries|entries.iter().find(|item|item["name"]==part)){
   Some(entry) if entry["directory"]==true=>{},
   Some(_)=>return Err(format!("目录被文件占用：{current}")),
   None=>{super::android::action("workspace_mkdir",&json!({"path":current}),false).await?;}
  }
 }Ok(())
}
pub async fn receive(st:&Arc<crate::AppState>,args:&std::collections::HashMap<String,String>,multipart:&mut axum::extract::Multipart)->Result<Value,String>{
 let _lock=st.workspace.mutation.lock().await;
 if !st.workspace.config.lock().await.enabled{return Err("工作区已关闭".into());}
 let directory=args.get("path").cloned().unwrap_or_default();if !directory.is_empty(){valid_path(&directory)?;}
 #[cfg(not(target_os="android"))]let root=st.workspace.root().await?;
 #[cfg(not(target_os="android"))]{let dir=super::resolve(&root,&directory,false)?;if !dir.is_dir(){return Err("上传目标必须是工作区文件夹".into());}}
 #[cfg(target_os="android")]super::android::action("workspace_list",&json!({"path":directory}),false).await?;
 let mut manifest:Option<Manifest>=None;let mut files=Vec::new();let mut directories=Vec::new();
 while let Some(mut field)=multipart.next_field().await.map_err(|e|e.to_string())?{
  if field.name()==Some("manifest"){
   if manifest.is_some()||!files.is_empty(){return Err("上传清单必须放在文件之前".into());}
   let mut bytes=Vec::new();while let Some(chunk)=field.chunk().await.map_err(|e|e.to_string())?{if bytes.len()+chunk.len()>4*1024*1024{return Err("文件夹清单超过4MB，请分批上传".into());}bytes.extend_from_slice(&chunk);}
   let value:Manifest=serde_json::from_slice(&bytes).map_err(|_|"上传目录清单无效")?;let dirs=plan(&value)?;
   #[cfg(not(target_os="android"))]{
    for path in &value.files{preflight(&root,&join(&directory,path),false)?;}
    for path in &dirs{preflight(&root,&join(&directory,path),true)?;}
    for path in &dirs{ensure_directory(&root,&join(&directory,path))?;}
   }
   #[cfg(target_os="android")]{
    for path in &dirs{android_directory(&join(&directory,path)).await?;}
    for path in &value.files{let target=join(&directory,path);let(parent,name)=target.rsplit_once('/').unwrap_or(("",target.as_str()));let list=super::android::action("workspace_list",&json!({"path":parent}),false).await?;if list["entries"].as_array().is_some_and(|entries|entries.iter().any(|entry|entry["name"]==name)){return Err(format!("文件 {target} 已存在，请先改名或删除旧文件"));}}
   }
   directories=dirs;manifest=Some(value);continue;
  }
  let name=if let Some(manifest)=&manifest{manifest.files.get(files.len()).ok_or("上传文件数量与清单不一致")?.clone()}else{field.file_name().ok_or("请选择文件")?.to_string()};
  if field.file_name().is_none(){return Err("上传包含未知字段".into());}valid_path(&name)?;let relative=join(&directory,&name);
  #[cfg(not(target_os="android"))]{
   let parent=relative.rsplit_once('/').map(|(parent,_)|parent).unwrap_or("");let dir=ensure_directory(&root,parent)?;
   let _lease=super::windows::hold_directory(&root,&dir)?;let target=super::resolve(&root,&relative,true)?;
   if target.exists(){return Err(format!("文件 {relative} 已存在，请先改名或删除旧文件"));}
   let temp=dir.join(format!(".upload-{}",uuid::Uuid::new_v4().simple()));
   let result=async{
    let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await.map_err(|e|e.to_string())?;
    while let Some(chunk)=field.chunk().await.map_err(|e|e.to_string())?{file.write_all(&chunk).await.map_err(|e|e.to_string())?;}
    file.sync_all().await.map_err(|e|e.to_string())?;drop(file);
    // Hard-link creation fails if another process created the destination meanwhile.
    tokio::fs::hard_link(&temp,&target).await.map_err(|e|e.to_string())?;Ok::<(),String>(())
   }.await;let _=tokio::fs::remove_file(&temp).await;result?;
  }
  #[cfg(target_os="android")]{
   if let Some((parent,_))=relative.rsplit_once('/'){android_directory(parent).await?;}
   let local=crate::data_dir().join(format!(".workspace-upload-{}",uuid::Uuid::new_v4().simple()));
   let result=async{let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&local).await.map_err(|e|e.to_string())?;while let Some(chunk)=field.chunk().await.map_err(|e|e.to_string())?{file.write_all(&chunk).await.map_err(|e|e.to_string())?;}file.sync_all().await.map_err(|e|e.to_string())?;drop(file);super::android::request(json!({"op":"import","path":relative,"localPath":local})).await?;Ok::<(),String>(())}.await;
   let _=tokio::fs::remove_file(&local).await;result?;
  }
  files.push(relative);
 }
 if manifest.as_ref().is_some_and(|manifest|manifest.files.len()!=files.len()){return Err("上传中断，已完成文件保留，请刷新查看".into());}
 st.broadcast_all(&json!({"type":"workspace-files-changed"}));Ok(json!({"files":files,"directories":directories}))
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn folder_plan_preserves_nested_empty_directories(){let value=Manifest{files:vec!["项目/子目录/文件.txt".into()],directories:vec!["项目/空目录".into()]};assert_eq!(plan(&value).unwrap(),vec!["项目","项目/子目录","项目/空目录"]);}
 #[test]fn upload_paths_reject_escape_and_reserved_files(){for path in ["../secret","a/../../secret","/absolute","a\\b","a:b","a/.shellpilot/key","A/.ShellPilot/disk","a/CON.txt","a/..","a//b"]{assert!(valid_path(path).is_err(),"{path}");}assert!(valid_path("项目/.env").is_ok());}
 #[test]fn upload_collision_checks_include_case_and_directory_conflicts(){assert!(plan(&Manifest{files:vec!["A.txt".into(),"a.txt".into()],directories:vec![]}).is_err());assert!(plan(&Manifest{files:vec!["dir".into(),"dir/file".into()],directories:vec![]}).is_err());}
}
