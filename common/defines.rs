use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct WsRequest {
    pub id: String,
    pub cmd: crate::commands::dispatch::Command,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsResult<T> {
    Ok { value: T },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct WsResponse<T> {
    pub id: String,
    pub result: WsResult<T>,
}

impl<T> WsResponse<T> {
    pub fn ok(id: String, value: T) -> Self {
        Self { id, result: WsResult::Ok { value } }
    }

    pub fn error(id: String, message: impl Into<String>) -> Self {
        Self { id, result: WsResult::Error { message: message.into() } }
    }
}
