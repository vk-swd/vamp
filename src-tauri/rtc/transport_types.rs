use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransportMsg<T> {
    Ack { sn: u32, node_id: String },
    Normal { sn: u32, node_id: String, payload: T },
}

#[derive(Deserialize, Serialize, Clone, Debug, specta::Type)]
pub struct WireMsg<T> {
    pub tag: String,
    pub message: Option<TransportMsg<T>>,
}