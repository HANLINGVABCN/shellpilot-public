use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub type Saver = std::sync::Arc<dyn Fn(&[u8], &str) -> Result<Option<String>, String> + Send + Sync>;
static SAVING: AtomicBool = AtomicBool::new(false);
struct SaveGuard;
impl Drop for SaveGuard { fn drop(&mut self) { SAVING.store(false, Ordering::SeqCst); } }

pub fn native_available(st: &crate::AppState) -> bool {
    cfg!(target_os = "android") || st.backup_saver.read().map(|saver| saver.is_some()).unwrap_or(false)
}

pub async fn save(st: &crate::AppState, bytes: Vec<u8>, filename: String) -> Result<Value, String> {
    validate_file(&bytes)?;
    if SAVING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("正在选择备份保存位置，请先完成当前导出".into());
    }
    let _guard = SaveGuard;
    #[cfg(target_os = "android")]
    {
        use base64::Engine;
        return crate::workspace::android::request(serde_json::json!({
            "op":"backup-save", "name":filename,
            "data":base64::engine::general_purpose::STANDARD.encode(bytes)
        })).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        let saver = st.backup_saver.read().map_err(|_| "保存接口不可用")?.clone()
            .ok_or("当前环境不支持系统保存对话框，请使用桌面或安卓应用")?;
        let path = tokio::task::spawn_blocking(move || saver(&bytes, &filename)).await.map_err(|e| e.to_string())??;
        Ok(match path {
            Some(path) => serde_json::json!({"saved":true,"path":path}),
            None => serde_json::json!({"saved":false,"cancelled":true})
        })
    }
}

fn validate_file(bytes:&[u8])->Result<(),String>{
    if bytes.starts_with(crate::crypt::MAGIC) { return Ok(()); }
    let value:Value=serde_json::from_slice(bytes).map_err(|_|"备份文件格式无效")?;
    crate::import::validate_import_data(&value).map(|_|())
}

/// Write backup bytes beside the chosen destination, then replace atomically.
pub fn write_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    validate_file(bytes)?;
    let parent = path.parent().ok_or("保存目录无效")?;
    let temporary = parent.join(format!(".shellpilot-export-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name="kernel32")] extern "system" { fn MoveFileExW(from:*const u16, to:*const u16, flags:u32)->i32; }
            let from:Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to:Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        }
        #[cfg(not(windows))]
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

#[cfg(windows)]
pub fn windows_save(bytes: &[u8], filename: &str) -> Result<Option<String>, String> {
    let Some(path)=crate::backup_save_windows::pick_path(filename)? else{return Ok(None);};
    write_backup(&path, bytes).map_err(|error| format!("备份保存失败：{error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(all(test,not(target_os="android")))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn chosen_path_cancel_and_failure_do_not_fake_a_save() {
        let root = std::env::temp_dir().join(format!("shellpilot-backup-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("自选目录 空格.spex");
        let bytes = crate::crypt::encrypt_data(b"fixture backup", "fixture-password");
        let st = crate::AppState::new();
        *st.backup_saver.write().unwrap() = Some(std::sync::Arc::new(|_,_| Ok(None)));
        let cancelled = save(&st, bytes.clone(), "fixture.spex".into()).await.unwrap();
        assert_eq!(cancelled["cancelled"], true);assert_eq!(cancelled["saved"], false);assert!(!path.exists());
        std::fs::write(&path, b"previous backup").unwrap();
        *st.backup_saver.write().unwrap() = Some(std::sync::Arc::new(|_,_| Err("fixture write failure".into())));
        assert!(save(&st, bytes.clone(), "fixture.spex".into()).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous backup");
        let target = path.clone();
        *st.backup_saver.write().unwrap() = Some(std::sync::Arc::new(move |data,_| {write_backup(&target,data)?;Ok(Some(target.to_string_lossy().into_owned()))}));
        let saved = save(&st, bytes.clone(), "fixture.spex".into()).await.unwrap();
        assert_eq!(saved["path"], path.to_string_lossy().as_ref());assert_eq!(saved["saved"], true);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(crate::crypt::decrypt_data(&std::fs::read(&path).unwrap(),"fixture-password").unwrap(), b"fixture backup");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert!(write_backup(&path, b"invalid backup").is_err());assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let plain=serde_json::to_vec(&serde_json::json!({"version":1,"hosts":[],"settings":{},"chats":{},"memories":[]})).unwrap();
        let plain_path=root.join("没有密码.json");write_backup(&plain_path,&plain).unwrap();
        assert_eq!(std::fs::read(&plain_path).unwrap(),plain);
        std::fs::remove_dir_all(root).unwrap();
    }
}
