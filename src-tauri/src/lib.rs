// Tauri 2 桌面/移动壳：内嵌 Rust 后端，WebView 加载本地 127.0.0.1 服务
#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 数据目录：%APPDATA%/ShellPilot（桌面打包后程序目录只读）
            #[cfg(desktop)]
            let data_dir = app.path().data_dir().map(|base| base.join("ShellPilot"))
                ?;
            #[cfg(mobile)]
            let data_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("data"));
            let _ = std::fs::create_dir_all(&data_dir);
            std::env::set_var("SHELLPILOT_DATA", &data_dir);
            shellpilot_server::init_data_dir(data_dir);

            let app_handle=app.handle().clone();
            let st=shellpilot_server::AppState::new();
            #[cfg(target_os="windows")]
            {*st.folder_picker.write().unwrap()=Some(std::sync::Arc::new(shellpilot_server::workspace::windows::pick_folder));}
            *st.external_opener.write().unwrap()=Some(std::sync::Arc::new(move|url|app_handle.opener().open_url(url,None::<&str>).map_err(|error|format!("无法打开系统浏览器：{error}"))));
            let port = tauri::async_runtime::block_on(async move {
                shellpilot_server::bootstrap(&st).await;
                shellpilot_server::start_server(st, 3737)
                    .await
                    .unwrap_or(3737)
            });
            let url: tauri::Url = format!("http://127.0.0.1:{}", port)
                .parse()
                .expect("valid url");

            let navigation_handle=app.handle().clone();
            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .on_navigation(move|url|{
                    if url.scheme()=="http" && url.host_str()==Some("127.0.0.1") && url.port_or_known_default()==Some(port){return true;}
                    if let Ok(url)=shellpilot_server::external::web_url(url.as_str()){
                        let _=navigation_handle.opener().open_url(url,None::<&str>);
                    }
                    false
                })
                .title("ShellPilot")
                .inner_size(1040.0, 720.0)
                .min_inner_size(380.0, 320.0);
            // 关掉 WebView2 原生拖放拦截：否则页面内的 HTML5 拖拽（主机卡拖进工作台等）全部失效。
            #[cfg(desktop)]
            {
                win = win.disable_drag_drop_handler();
                let state=shellpilot_server::load_json_or("window-state.json",serde_json::json!({}));
                let monitor=app.primary_monitor()?;
                let (max_width,max_height)=monitor.as_ref().map(|m| {
                    let size=m.size().to_logical::<f64>(m.scale_factor());
                    ((size.width-80.0).max(380.0),(size.height-100.0).max(320.0))
                }).unwrap_or((1600.0,1000.0));
                let width=state["width"].as_f64().filter(|v|v.is_finite()).unwrap_or(1040.0).clamp(380.0,max_width);
                let height=state["height"].as_f64().filter(|v|v.is_finite()).unwrap_or(720.0).clamp(320.0,max_height);
                win=win.inner_size(width,height).center().maximized(state["maximized"].as_bool().unwrap_or(false));
            }
            #[cfg(target_os = "windows")]
            {
                win = win.additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
                );
            }
            let window=win.build()?;
            #[cfg(desktop)]
            {
                let state=shellpilot_server::load_json_or("window-state.json",serde_json::json!({}));
                if let (Some(x),Some(y))=(state["x"].as_i64(),state["y"].as_i64()) {
                    // Restore only positions still visible on a connected display.
                    let visible=window.available_monitors()?.iter().any(|m| {
                        let p=m.position(); let s=m.size();
                        x>=p.x as i64 && y>=p.y as i64 && x+160<(p.x as i64+s.width as i64) && y+100<(p.y as i64+s.height as i64)
                    });
                    if visible { let _=window.set_position(tauri::PhysicalPosition::new(x as i32,y as i32)); }
                }
            }

            #[cfg(desktop)]
            {
                // 创建系统托盘菜单
                let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出 ShellPilot").build(app)?;
                let tray_menu = MenuBuilder::new(app)
                    .items(&[&show_item, &quit_item])
                    .build()?;

                let mut tray_builder = TrayIconBuilder::new()
                    .tooltip("ShellPilot - AI SSH 工作台")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    });

                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }

                let _ = tray_builder.build(app)?;
            }

            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(desktop)]
            {
            if matches!(_event,tauri::WindowEvent::Resized(_)|tauri::WindowEvent::Moved(_)|tauri::WindowEvent::CloseRequested{..})
                && !_window.is_minimized().unwrap_or(false) {
                let mut state=shellpilot_server::load_json_or("window-state.json",serde_json::json!({}));
                let maximized=_window.is_maximized().unwrap_or(false);
                state["maximized"]=serde_json::json!(maximized);
                if !maximized {
                    if let (Ok(size),Ok(scale))=(_window.inner_size(),_window.scale_factor()) {
                        let size=size.to_logical::<f64>(scale);
                        if size.width>=380.0 && size.height>=320.0 {
                            state["width"]=serde_json::json!(size.width); state["height"]=serde_json::json!(size.height);
                        }
                    }
                    if let Ok(position)=_window.outer_position() { state["x"]=serde_json::json!(position.x); state["y"]=serde_json::json!(position.y); }
                }
                shellpilot_server::save_json("window-state.json",&state);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                let settings = shellpilot_server::get_settings();
                let close_to_tray = settings
                    .get("closeToTray")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if close_to_tray {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
