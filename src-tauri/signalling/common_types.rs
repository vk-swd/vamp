
use serde::{Deserialize, Serialize};


#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMsg<T> {
    Server {
        announced_addr: String,
    },
    ServerAnswer {
        dst: String,
        payload: T,
    },
    Client {
        dst: String,
        payload: T,
    },
}
