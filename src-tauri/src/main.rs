// Prevents an extra console window on Windows in release. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use webkit2gtk::gio::DBusMessageHeaderField::Sender;
mod commands;
mod db;
mod transport;
mod app_core;
mod app_ws_handler;
mod db_config;
mod tauri_handle;
#[path = "../specta_export.rs"]
mod specta_export;
#[path = "../rtc/mod.rs"]
mod rtc;
#[path = "../../common/defines.rs"]
pub mod defines;


// const tauri_conf: &'static str = env!("TAURI_CONFIG");


#[tokio::main]  
async fn main() {
    env_logger::init();
    let port: u16 = 1420;
    tauri::async_runtime::set(tokio::runtime::Handle::current());
    let app_core = app_core::make_app_core().await.expect("failed to initialize app core");

    let ws_handle = app_ws_handler::make_ws_handle("0.0.0.0:8090".parse().unwrap(), app_core.clone()).await.expect("failed to start ws server");
    tauri_handle::TauriHandle::new(port, app_core)
        .run(tauri::generate_context!());
    // cancel ws_handle and wait for it to finish
}

