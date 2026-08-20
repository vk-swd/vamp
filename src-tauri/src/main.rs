// Prevents an extra console window on Windows in release. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod db;
mod transport;
use tauri::Manager;

use crate::db::repository::ArcRepo;

#[tauri::command]
fn log_from_ui(message: String) {
    println!("[UI] {}", message);
}


#[tauri::command]
async fn test_sleep() {
    static SLEEPIDX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let idx = SLEEPIDX.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now_formatted_time: String = chrono::Local::now().format("%H:%M:%S").to_string();
    println!("[UI] entered sleep function {} at {}", idx, now_formatted_time);
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let now_formatted_time = chrono::Local::now().format("%H:%M:%S").to_string();
    println!("[UI] Slept for 2 seconds {} at {}", idx, now_formatted_time);
}

struct UserConfig {
    db_path: std::path::PathBuf,
    db_filename: String,
    window_idx: usize,
    is_test: bool,
    crypto_dir: Option<std::path::PathBuf>,
}

enum LaunchMode {
    Test,
    DbFolderDefined,
    DefaultDb,
}

fn create_user_config() -> UserConfig {
    let test_dir_env = std::env::var("TEST_DIR");
    let app_dir_env = std::env::var("VAMP_DIR");
    let crypto_dir_env = std::env::var("CRYPTO_DIR");
    
    let mut launch_mode = LaunchMode::DefaultDb;
    if app_dir_env.is_ok() {
        launch_mode = LaunchMode::DbFolderDefined;
    }
    if test_dir_env.is_ok() {
        launch_mode = LaunchMode::Test;
    }
    match launch_mode {
        LaunchMode::Test => UserConfig {
            db_path: std::path::PathBuf::from(test_dir_env.unwrap()),
            db_filename: chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
                + "_test.db",
            window_idx: 1, //windows are defined in tauri config
            is_test: true,
            crypto_dir: crypto_dir_env.ok().map(std::path::PathBuf::from),
        },
        LaunchMode::DbFolderDefined => UserConfig {
            db_path: std::path::PathBuf::from(app_dir_env.unwrap()),
            db_filename: "vampa.db".to_string(),
            window_idx: 0,
            is_test: false,
            crypto_dir: crypto_dir_env.ok().map(std::path::PathBuf::from),
        },
        LaunchMode::DefaultDb => UserConfig {
            db_path: dirs::data_dir().unwrap(),
            db_filename: "vampagent3.db".to_string(),
            window_idx: 0,
            is_test: false,
            crypto_dir: crypto_dir_env.ok().map(std::path::PathBuf::from),
        },
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = 1420;
    tauri::async_runtime::set(tokio::runtime::Handle::current());
    let user_config = create_user_config();

    std::fs::create_dir_all(&user_config.db_path).expect("failed to create db directory");
    let db_full_path = user_config.db_path.join(&user_config.db_filename);

    let repo: ArcRepo = commands::create_repo(db_full_path, user_config.is_test)
        .await
        .expect("failed to initialize database");

    let guard = crate::commands::listen_guard::ListenGuard::new();


    // if !matches!(user_config.window_idx, 1) {
        let repo1 = repo.clone();
        let guard1 = guard.clone();

        match transport::ws_server::start(
            repo1,
            guard1,
            "0.0.0.0:8090".parse().unwrap(),
        ).await {
            Ok(_) => println!("[WS] started"),
            Err(e) => eprintln!("[WS] failed to start: {e}"),
        }
    // } 
    
    tauri::Builder::default()
        // .plugin(tauri_plugin_localhost::Builder::new(port.clone()).build())
        .setup(move |app| {
            app.handle().manage(repo.clone());
            app.handle().manage(guard.clone());

            

            let mut url: String = format!("http://localhost:{}", port);
            if matches!(user_config.window_idx, 1) {
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
            commands::dispatch::dispatch,
            test_sleep
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
