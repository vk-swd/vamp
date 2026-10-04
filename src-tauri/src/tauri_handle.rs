use tauri::Manager;
use std::sync::Arc;
use crate::app_core::AppCore;
pub struct TauriHandle<B> {
    builder: B,
}

#[tauri::command]
pub async fn app_dispatch(
    app: tauri::State<'_, Arc<AppCore>>,
    cmd: Option<crate::commands::dispatch::Command>,
) -> Result<serde_json::Value, String> {
    let Some(cmd) = cmd else {
        return Ok(serde_json::json!({ "error": "No command provided" }));
    };
    crate::commands::dispatch::dispatch_with_core(&app, cmd)
        .await
        .map_err(|error| error.to_string())
}

impl TauriHandle<tauri::Builder<tauri::Wry>> {
    pub fn new(port: u16, app_core: std::sync::Arc<crate::app_core::AppCore>) -> Self {
        Self {
            builder: tauri::Builder::default()
                .setup(move |app| {
                    app.handle().manage(app_core.clone());
                    let webviews = app.webview_windows();
                    for webview in webviews {
                        // Do something with each webview if needed
                        #[cfg(target_os = "linux")]
                        webview.1
                            .with_webview(|webview| {
                                use webkit2gtk::{SettingsExt, WebViewExt};

                                let w = webview.inner();
                                let settings = WebViewExt::settings(&w).unwrap();

                                println!("Creating window with settings: {:?}", settings);
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
                    }
                    Ok(())
                })
                .invoke_handler(tauri::generate_handler![
                    crate::tauri_handle::app_dispatch
                ])
                .plugin(tauri_plugin_opener::init())
        }
    }

    pub fn run(self, context: tauri::Context<tauri::Wry>) {
        self.builder.run(context).expect("error while running tauri application");
    }
}
