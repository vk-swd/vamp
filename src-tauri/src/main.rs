// Prevents an extra console window on Windows in release. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod db;
mod transport;
use tauri::Manager;

use crate::commands::default_dir;
use crate::db::repository::ArcRepo;

#[tauri::command]
fn log_from_ui(message: String) {
    println!("[UI] {}", message);
}
struct UserConfig {
    db_path: std::path::PathBuf,
    db_filename: String,
    window_idx: usize,
}

enum LaunchMode {
    Test,
    DbFolderDefined,
    DefaultDb,
}

fn main() {
    let port: u16 = 1420;
    tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(port.clone()).build())
        .setup(move |app| {
            let test_dir_env = std::env::var("TEST_DIR");
            let app_dir_env = std::env::var("VAMP_DIR");
            let mut launch_mode = LaunchMode::DefaultDb;
            if app_dir_env.is_ok() {
                launch_mode = LaunchMode::DbFolderDefined;
            }
            if test_dir_env.is_ok() {
                launch_mode = LaunchMode::Test;
            }

            let user_config = match launch_mode {
                LaunchMode::Test => UserConfig {
                    db_path: std::path::PathBuf::from(test_dir_env.unwrap()),
                    db_filename: chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
                        + "_test.db",
                    window_idx: 1,
                },
                LaunchMode::DbFolderDefined => UserConfig {
                    db_path: std::path::PathBuf::from(app_dir_env.unwrap()),
                    db_filename: "vampa.db".to_string(),
                    window_idx: 0,
                },
                LaunchMode::DefaultDb => UserConfig {
                    db_path: default_dir(app.handle())?,
                    db_filename: "vampagent3.db".to_string(),
                    window_idx: 0,
                },
            };
            std::fs::create_dir_all(&user_config.db_path).map_err(|e| e.to_string())?;
            let db_full_path = user_config.db_path.join(&user_config.db_filename);
            tauri::async_runtime::block_on(commands::setup_database(
                app.handle().clone(),
                db_full_path,
            ))
            .map_err(|e| e.to_string())?;

            if !matches!(launch_mode, LaunchMode::Test) {
                let repo = app.handle().state::<ArcRepo>().inner().clone();
                let guard = app.handle().state::<crate::commands::listen_guard::ArcListenGuard>().inner().clone();
                let cert_path = user_config.db_path.join("cert.pem");
                let key_path = user_config.db_path.join("key.pem");
                tauri::async_runtime::block_on(
                    // transport::ws_server::start(repo, guard, "127.0.0.1:8090".parse().unwrap(), &cert_path, &key_path)
                    transport::ws_server::start(
                        repo,
                        guard,
                        "0.0.0.0:8090".parse().unwrap(),
                        &cert_path,
                        &key_path,
                    ),
                )
                .map_err(|e| e.to_string())?;
            } 
            

            let mut url: String = format!("http://localhost:{}", port);
            if matches!(launch_mode, LaunchMode::Test) {
                url += &format!("/src/test/dbTest/mockPage.html");
            }
            let mut win_config = app.config().app.windows[user_config.window_idx].clone();
            win_config.url = tauri::WebviewUrl::External(url.parse().unwrap());
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &win_config)?
                .build()?;
            // Apply webkit settings for ALL builds (debug + release)

            #[cfg(target_os = "linux")]
            window
                .with_webview(|webview| {
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
                })
                .unwrap();
            // Open DevTools only in debug builds
            // #[cfg(debug_assertions)]
            // window.open_devtools();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_from_ui,
            commands::dispatch::dispatch
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
