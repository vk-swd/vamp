mod common_types;
#[path="../src/commands/common.rs"]
mod common;
mod ws_server;
#[cfg(test)]
#[path = "ws_server_test.rs"]
mod ws_server_test;

use ws_server::{run_server_with_config, ServerConfig};

#[tokio::main]
async fn main() {
    env_logger::init();

    let port = common::get_env_num("SS_PORT", 9001);
    let ip_v4_addr = common::get_env_str("SS_ADDR", "0.0.0.0");
    let addr = format!("{}:{}", ip_v4_addr, port)
        .parse()
        .expect("invalid SS_ADDR/SS_PORT combination");

    run_server_with_config(addr, ServerConfig::default()).await;
}
