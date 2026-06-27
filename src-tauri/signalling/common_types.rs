
use serde::{Deserialize, Serialize};


#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct WsMsg<T> {
    pub src: String,
    pub dst: String,
    pub payload: T,
}
