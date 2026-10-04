use async_trait::async_trait;
use tokio_tungstenite::tungstenite::Message;
use crate::commands::common::MyRes;
use crate::commands::dispatch::Command;
use crate::transport;
use crate::db::repository::ArcRepo;
use crate::commands::listen_guard::ArcListenGuard;

fn error_message(id: String, error: impl Into<String>) -> Message {
    let response = crate::defines::RemoteResponse::<serde_json::Value>::error(id, error);
    let message = crate::defines::DataTransportMessage::<Command, serde_json::Value>::Response(response);
    let text = serde_json::to_string(&message)
        .unwrap_or_else(|_| "{\"error\":\"serialization_error\"}".to_string());
    Message::Text(text.into())
}

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

        let request = match serde_json::from_str::<crate::defines::DataTransportMessage<crate::commands::dispatch::Command, String>>(&text) {
            Ok(request) => match request {
                crate::defines::DataTransportMessage::Request(request) => request,
                crate::defines::DataTransportMessage::Response(_) => {
                    println!("[WS] unexpected response message");
                    return error_message(String::new(), format!("unexpected_response_message"));
                }
            },
            Err(error) => {
                println!("[WS] failed to parse request: {}: {}", error, text);
                return error_message(String::new(), format!("{}: {}", error, text));
            }
        };
        let id = request.id;
        let cmd: Command = request.cmd;
        let result = match crate::commands::dispatch::dispatch_with_core(&self.app_core, cmd).await {
            Ok(value) => crate::defines::RemoteResponse::ok(id.clone(), value),
            Err(error) => return error_message(id, error.to_string()),
        };
        let response = crate::defines::DataTransportMessage::<Command, serde_json::Value>::Response(result);
        let response_text = serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"error\":\"serialization_error\"}".to_string());
        Message::Text(response_text.into())
    }
}
