mod bridge;

/// 从 tauri.conf.json 的 window 配置创建主窗口。
/// 桌面专属的多窗口、窗口状态恢复、内嵌 server 子进程、单实例、装饰条
/// 等能力已随桌面打包链路一并移除。
fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("main window config missing");
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(bridge::BridgeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    // Android 上只有 WS 桥需要暴露给前端；HTTP 走 plugin-http，事件走 WS。
    // Android 上只有 WS 桥需要暴露给前端；HTTP 走 plugin-http，事件走 WS。
    let builder = builder
        .setup(|app| {
            let _ = create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::ws_bridge_connect,
            bridge::ws_bridge_send,
            bridge::ws_bridge_close,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PiUI client");

    app.run(|_app_handle, _event| {});
}
