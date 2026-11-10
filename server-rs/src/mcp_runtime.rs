//! Immutable MCP executable copies keep STDIO independent of GUI upgrades.
use std::path::{Path,PathBuf};
use sha2::{Digest,Sha256};
use serde_json::json;
use std::sync::Mutex;
static CACHE:Mutex<Option<PathBuf>>=Mutex::new(None);

fn hash(path:&Path)->Result<String,String>{
    use std::io::Read;
    let mut file=std::fs::File::open(path).map_err(|e|e.to_string())?;
    let mut digest=Sha256::new();let mut buffer=[0u8;65536];
    loop{let size=file.read(&mut buffer).map_err(|e|e.to_string())?;if size==0{break;}digest.update(&buffer[..size]);}
    Ok(format!("{:x}",digest.finalize()))
}

pub fn executable()->Result<PathBuf,String>{
    let source=std::env::current_exe().map_err(|e|e.to_string())?;
    if !cfg!(windows)||source.file_name().is_some_and(|name|name=="shellpilot-mcp.exe"){return Ok(source);}
    let mut cache=CACHE.lock().map_err(|_|"MCP运行路径不可用")?;
    if let Some(path)=cache.as_ref(){if path.is_file(){return Ok(path.clone());}}
    let digest=hash(&source)?;
    let directory=crate::data_dir().join("mcp-runtime").join(&digest);
    std::fs::create_dir_all(&directory).map_err(|e|format!("创建MCP运行目录失败：{e}"))?;
    let destination=directory.join("shellpilot-mcp.exe");
    if destination.is_file(){
        if hash(&destination)?!=digest{return Err("MCP运行文件校验失败，原文件保留".into());}
    }else{
        let temporary=directory.join(format!(".copy-{}",uuid::Uuid::new_v4().simple()));
        let copied=(||{
            std::fs::copy(&source,&temporary).map_err(|e|e.to_string())?;
            if hash(&temporary)?!=digest{return Err("MCP运行文件复制校验失败".into());}
            match std::fs::rename(&temporary,&destination){
                Ok(())=>Ok(()),
                Err(_) if destination.is_file()&&hash(&destination)?==digest=>Ok(()),
                Err(error)=>Err(error.to_string())
            }
        })();let _=std::fs::remove_file(&temporary);copied?;
    }
    *cache=Some(destination.clone());Ok(destination)
}

pub fn configuration()->Result<serde_json::Value,String>{
    Ok(json!({"command":executable()?.to_string_lossy(),"args":["--mcp"],"env":{"SHELLPILOT_DATA":crate::data_dir().to_string_lossy()}}))
}
