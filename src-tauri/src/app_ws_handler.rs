use async_trait::async_trait;
use tokio_tungstenite::tungstenite::Message;
use crate::commands::common::MyRes;
use crate::transport;
use crate::db::repository::ArcRepo;
use crate::commands::listen_guard::ArcListenGuard;

struct WsMsgHandler {
    app_core: std::sync::Arc<crate::app_core::AppCore>
}

pub struct WsHandle {
    msg_handler: std::sync::Arc<WsMsgHandler>,
    _ws_server: tokio::task::JoinHandle<()>,
    // stopper
}
pub async fn make_ws_handle(addr: std::net::SocketAddr, app_core: std::sync::Arc<crate::app_core::AppCore>) -> MyRes<WsHandle> {
    let handler = std::sync::Arc::new(crate::app_ws_handler::WsMsgHandler { app_core });
    let ws_join_handle = transport::ws_server::start(addr, handler.clone()).await?;
    Ok(WsHandle {
        msg_handler: handler,
        _ws_server: ws_join_handle,
    })
}

#[async_trait]
impl crate::transport::ws_server::WsMessageHandler for WsMsgHandler {
    async fn handle(&self, message: Message) -> Message {
        let text = match message {
            Message::Text(text) => text,
            _ => {
                println!("[WS] unsupported message type: {:?}", message);
                return Message::Text("{\"error\":\"unsupported_message_type\"}".to_string().into());
            }
        };

        let request = match serde_json::from_str::<crate::defines::WsRequest>(&text) {
            Ok(request) => request,
            Err(error) => {
                println!("[WS] failed to parse request: {}: {}", error, text);
                let response = crate::defines::WsResponse::<serde_json::Value>::error(String::new(), format!("{}: {}", error, text));
                let response_text = serde_json::to_string(&response)
                    .unwrap_or_else(|_| "{\"error\":\"serialization_error\"}".to_string());
                return Message::Text(response_text.into());
            }
        };
        let id = request.id;
        let cmd = request.cmd;
        let response = match crate::commands::dispatch::execute(&self.app_core.repo, &self.app_core.guard, cmd).await {
            Ok(value) => crate::defines::WsResponse::ok(id, value),
            Err(error) => crate::defines::WsResponse::error(id, error),
        };
        let response_text = serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"error\":\"serialization_error\"}".to_string());
        Message::Text(response_text.into())
    }
}
