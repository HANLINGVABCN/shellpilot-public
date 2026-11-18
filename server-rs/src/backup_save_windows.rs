use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

#[repr(C)]
struct OpenFileName {
    size:u32, owner:isize, instance:isize, filter:*const u16, custom_filter:*mut u16,
    custom_filter_size:u32, filter_index:u32, file:*mut u16, file_size:u32,
    file_title:*mut u16, file_title_size:u32, initial_directory:*const u16, title:*const u16,
    flags:u32, file_offset:u16, file_extension:u16, default_extension:*const u16,
    custom_data:isize, hook:*const std::ffi::c_void, template:*const u16,
    reserved:*mut std::ffi::c_void, reserved_size:u32, flags_ex:u32,
}
#[link(name="comdlg32")]
extern "system" { fn GetSaveFileNameW(options:*mut OpenFileName)->i32; fn CommDlgExtendedError()->u32; }

pub fn pick_path(filename:&str)->Result<Option<PathBuf>,String>{
    let extension=if filename.ends_with(".json"){"json"}else{"spex"};
    let mut file=vec![0u16;32768];
    let initial:Vec<u16>=filename.encode_utf16().collect();
    if initial.len()>=file.len(){return Err("备份文件名过长".into());}
    file[..initial.len()].copy_from_slice(&initial);
    let filter:Vec<u16>=format!("ShellPilot 备份 (*.{extension})\0*.{extension}\0\0").encode_utf16().collect();
    let title:Vec<u16>="选择备份文件保存位置\0".encode_utf16().collect();
    let default_extension:Vec<u16>=extension.encode_utf16().chain(Some(0)).collect();
    let mut options=OpenFileName {
        size:std::mem::size_of::<OpenFileName>() as u32,owner:0,instance:0,filter:filter.as_ptr(),
        custom_filter:null_mut(),custom_filter_size:0,filter_index:1,file:file.as_mut_ptr(),file_size:file.len() as u32,
        file_title:null_mut(),file_title_size:0,initial_directory:null(),title:title.as_ptr(),
        flags:0x80000|0x2|0x800|0x8,file_offset:0,file_extension:0,default_extension:default_extension.as_ptr(),
        custom_data:0,hook:null(),template:null(),reserved:null_mut(),reserved_size:0,flags_ex:0,
    };
    if unsafe{GetSaveFileNameW(&mut options)}==0 {
        let code=unsafe{CommDlgExtendedError()};
        return if code==0 {Ok(None)}else{Err(format!("无法打开保存对话框（{code}）"))};
    }
    let length=file.iter().position(|value|*value==0).unwrap_or(file.len());
    let path=PathBuf::from(OsString::from_wide(&file[..length]));
    if !path.is_absolute(){return Err("请选择完整保存路径".into());}
    Ok(Some(path))
}
