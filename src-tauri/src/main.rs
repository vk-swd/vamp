


// Prevents an extra console window on Windows in release. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod db;
use tauri::Manager;
use webkit2gtk::glib::DateTime;

use crate::commands::default_dir;

#[tauri::command]
fn log_from_ui(message: String) {
    println!("[UI] {}", message);
}
struct AppConfig {
    db_path: std::path::PathBuf,
    db_filename: String,
    window_idx: usize,
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let test_dir_env = std::env::var("TEST_DIR");
            let config = if let Ok(test_dir) = test_dir_env {
                AppConfig { 
                    db_path: std::path::PathBuf::from(test_dir), 
                    db_filename: chrono::Local::now().format("%Y%m%d_%H%M%S").to_string() + "_test.db",
                    window_idx: 1 
                }
            } else {
                AppConfig { 
                    db_path: default_dir(app.handle())?, 
                    db_filename: "vampagent3.db".to_string(),
                    window_idx: 0 
                }
            };
            std::fs::create_dir_all(&config.db_path).map_err(|e| e.to_string())?;
            let db_full_path = config.db_path.join(&config.db_filename);
            tauri::async_runtime::block_on(
                commands::setup_database(app.handle().clone(), db_full_path)
            ).map_err(|e| e.to_string())?;
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[config.window_idx])?.build()?;
            // Apply webkit settings for ALL builds (debug + release)
        
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};

                    let w = webview.inner();
                    let settings = WebViewExt::settings(&w).unwrap();

                    // Spoof modern Chrome so YouTube serves the correct player JS
                    settings.set_user_agent(Some(
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
                            (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    ));

                    // Media Source Extensions – required for DASH/HLS adaptive streaming
                    settings.set_enable_mediasource(true);

                    // Allow autoplay without a prior user gesture (needed for the IFrame API)
                    settings.set_media_playback_requires_user_gesture(false);

                    // Encrypted Media Extensions – required for HD/DRM streams on YouTube
                    settings.set_enable_encrypted_media(true);

                    // GPU-accelerated video decoding
                    settings.set_hardware_acceleration_policy(
                        webkit2gtk::HardwareAccelerationPolicy::Always,
                    );

                    // WebGL – YouTube's player uses it for rendering overlays
                    settings.set_enable_webgl(true);

                    // MediaStream – suppresses the enumerate-devices console errors
                    settings.set_enable_media_stream(true);
                  
                }).unwrap();
            // Open DevTools only in debug builds
            // #[cfg(debug_assertions)]
            // window.open_devtools();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![log_from_ui,
            commands::add_track,        commands::update_track,
            commands::get_tracks,       commands::get_track,
            commands::delete_track,
            commands::add_listen,       commands::get_listens_for_track,
            commands::add_tag,          commands::edit_tag,
            commands::delete_tag,       commands::get_all_tags,
            commands::get_tags,
            commands::assign_tag,       commands::remove_tag,
            commands::get_tags_for_track,
            commands::add_meta,         commands::update_meta,
            commands::delete_meta,      commands::get_meta_for_track])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

