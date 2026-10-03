use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemoteRequest<T> {
    pub id: String,
    pub cmd: T,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteResult<T> {
    Ok { value: T },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataTransportMessage<T1, T> {
    Request(RemoteRequest<T1>),
    Response(RemoteResponse<T>),
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct RemoteResponse<T> {
    pub id: String,
    pub result: RemoteResult<T>,
}

impl<T> RemoteResponse<T> {
    pub fn ok(id: String, value: T) -> Self {
        Self { id, result: RemoteResult::Ok { value } }
    }

    pub fn error(id: String, message: impl Into<String>) -> Self {
        Self { id, result: RemoteResult::Error { message: message.into() } }
    }
}
