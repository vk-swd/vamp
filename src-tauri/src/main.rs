// Prevents an extra console window on Windows in release. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::Manager;

#[tauri::command]
fn log_from_ui(message: String) {
    println!("[UI] {}", message);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Apply webkit settings for ALL builds (debug + release)
            window
                .with_webview(|webview| {
                    #[cfg(target_os = "linux")]
                    
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
        .invoke_handler(tauri::generate_handler![log_from_ui])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

