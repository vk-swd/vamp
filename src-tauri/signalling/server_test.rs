mod common_types;
use tokio;
mod s_server;
#[path="../src/commands/common.rs"]
mod common;

#[tokio::main]
async fn main() {
    
    let port = common::get_env_num("SS_PORT", 9001);
    let ip_v4_addr = common::get_env_str("SS_ADDR", "0.0.0.0");
    let addr = format!("{}:{}", ip_v4_addr, port).parse().unwrap();
    s_server::run_server(addr).await;
}