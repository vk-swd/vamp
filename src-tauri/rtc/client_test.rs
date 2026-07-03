

mod client;
mod dc;
use client::run_client;
use tokio;
#[path="../src/commands/common.rs"]
mod common;
use std::env;


#[tokio::main]
async fn main() {
    env_logger::init();
    log::info!("[RTC_CLIENT] starting client ");    
    let ss_url = common::get_env_str("SS_URL", "ws://localhost:9001");
    let session_id = common::get_env_str("RTC_SESSION_ID", "default_session");
    log::info!("[RTC_CLIENT] starting client {ss_url} session_id {session_id}");
    run_client(ss_url.as_str(), session_id).await;
    /*
        set up ws connection to expect an offer. Keep the connection open.
        get offer 
        get ice candidates and negotiate answer
        send answer back and expect datachannel to open
    
     */
}