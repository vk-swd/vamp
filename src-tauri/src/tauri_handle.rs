use tauri::Manager;
use std::sync::Arc;
use crate::app_core::AppCore;
pub struct TauriHandle<B> {
    builder: B,
}

#[tauri::command]
pub async fn app_dispatch(
    app: tauri::State<'_, Arc<AppCore>>,
    cmd: crate::commands::dispatch::Command,
) -> Result<serde_json::Value, String> {
    crate::commands::dispatch::execute(&app.repo, &app.guard, cmd).await
}

impl TauriHandle<tauri::Builder<tauri::Wry>> {
    pub fn new(port: u16, app_core: std::sync::Arc<crate::app_core::AppCore>) -> Self {
        Self {
            builder: tauri::Builder::default()
                // .plugin(tauri_plugin_localhost::Builder::new(port.clone()).build())
                .setup(move |app| {
                    app.handle().manage(app_core.clone());
                    let (window_idx, url) = crate::db_config::create_window_config(port);
                    let mut win_config = app.config().app.windows[window_idx].clone();
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
                    crate::tauri_handle::app_dispatch
                ])
                .plugin(tauri_plugin_opener::init())
        }
    }

    pub fn run(self, context: tauri::Context<tauri::Wry>) {
        self.builder.run(context).expect("error while running tauri application");
    }
}
