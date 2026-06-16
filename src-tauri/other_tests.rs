use std::sync::Arc;
use std::time::Duration;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::select;
use tokio::sync::Notify;
use tokio::runtime::Builder;

use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;




mod signalling {
    pub mod server;
}


use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Default)]
struct NotifySuite {
    shutdown: Arc<Notify>,
    server_started: Arc<Notify>,
    server_sender_closed: Arc<Notify>,
    send_task_is_wrapped: Arc<Notify>,
    serer_async_sender_up: Arc<Notify>,
    test_done: Arc<Notify>,
}
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::signalling::server::{SimpleResult, msg_to_txt};

async fn run_server(addr: SocketAddr, notifier: Arc<NotifySuite>) {
    let listener = TcpListener::bind(addr).await.expect("failed to bind TCP listener");

    // Pin shutdown future so it can be polled across loop iterations.
    let shutdown = notifier.shutdown.clone();
    tokio::pin!(shutdown);

    let mut next_id: u64 = 0;
    notifier.server_started.notify_one();
    loop {
        tokio::select! {
            biased; // modifier to check shutdown first
            _ = notifier.shutdown.notified() => break,
            result = listener.accept() => {
                match result {
                    Ok((stream, _peer)) => {
                        log::info!("[SS] New TCP connection form {}, assigning socket id={}", _peer.to_string(), next_id);
                        let socket_id = next_id;
                        next_id += 1;
                        tokio::spawn(server_connection(stream, notifier.clone()));
                    }
                    Err(e) => log::error!("[SS] Accept error: {e}"),
                }
            }
        }
    }
    notifier.test_done.notify_one();
}
async fn server_connection<S>(stream: S, notifier: Arc<NotifySuite>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static, {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[SS] WebSocket handshake error: {e}");
            return;
        }
    };
    log::info!("[SS] WebSocket handshake has been successfully completed");
    let (write, mut read) = ws_stream.split();
    let (server_tx, mut server_rx) = mpsc::unbounded_channel::<String>();
    let server_sender_closed = notifier.server_sender_closed.clone();
    let serer_async_sender_up = notifier.serer_async_sender_up.clone();
    tokio::spawn(async move {
        serer_async_sender_up.notify_one();
        let moved_write_handle = write;
        while let Some(msg) = server_rx.recv().await {}
        server_sender_closed.notify_one();
    });
    notifier.serer_async_sender_up.notified().await;
    let rn = signalling::server::next_msg(&mut read).await;
    let msg = match rn {
        SimpleResult::Ok(msg) => match msg_to_txt(&msg) {
            Some(t) => t,
            None => "   [SS] msg_to_txt fail".to_string(),
        }
        SimpleResult::Err(e) => format!("   [SS] unknown error: {e:?}"),
    };
    log::info!("[SS] Received from client: {msg}");
    drop(server_tx);
    notifier.server_sender_closed.notified().await;
    log::info!("[SS] Server about to close the connection");
}

async fn make_sure_notifier_blocked(notify: Arc<Notify>, msg: String) {
    for _ in 0..3 {
        tokio::select! {
            _ = sleep(Duration::from_secs(1)) => {
                log::info!("[SS] Waiting for {msg} to complete...");
            },
            _ = notify.notified() => {
                panic!("[SS] {msg} unexpectedly finished");
            }
        }
    }
}
async fn test_main() {
    let notify_suite = Arc::new(NotifySuite::default());
    {
        let url = "ws://localhost:8080";
        let server_spawned_handle = tokio::spawn(run_server("127.0.0.1:8080".parse().unwrap(), notify_suite.clone()));
        notify_suite.server_started.notified().await;
        
        let (client_tx, mut client_rx) = mpsc::unbounded_channel::<String>();
        let (ws_stream, _) = match connect_async(url).await {
            Ok((stream, response)) => (stream, response),
            Err(e) => {
                log::error!("[SS] WebSocket connection error: {e}");
                return;
            }
        };
        log::info!("[SS] WebSocket handshake has been successfully completed");

        let (mut write, mut read) = ws_stream.split();
        let send_task_is_wrapped = notify_suite.send_task_is_wrapped.clone();
        let async_sender_handle = tokio::spawn(async move {
            while let Some(msg) = client_rx.recv().await {
                if let Err(e) = write.send(Message::Text(msg)).await {
                    log::error!("[SS] Failed to send message: {e}");
                    break;
                }
            }
            send_task_is_wrapped.notify_one();
        });
        let new_msg = format!("Hello at {}", chrono::Local::now().format("%H:%M:%S%.3f"));
        match client_tx.send(new_msg) {
            Ok(_) => (),
            Err(e) => {
                log::error!("[SS] Failed to send message: {e}");
            }
        }
        log::info!("[SS] Sent message to server, waiting for response...");
        match signalling::server::next_msg(&mut read).await {
            SimpleResult::Ok(msg) => match msg_to_txt(&msg) {
                Some(t) => log::info!("[SS] Received from server: {t}"),
                None => log::error!("[SS] msg_to_txt fail"),
            }
            SimpleResult::Err(e) => log::error!("[SS] unknown error{e:?}"),
        };
        drop(async_sender_handle);
        make_sure_notifier_blocked(notify_suite.send_task_is_wrapped.clone(), "client send task".to_string()).await;
        drop(client_tx);
        notify_suite.send_task_is_wrapped.notified().await;
        log::info!("[SS] client send task is wrapped, test done");
    }
    make_sure_notifier_blocked(notify_suite.test_done.clone(), "test done".to_string()).await;
    notify_suite.shutdown.notify_one();
    notify_suite.test_done.notified().await;
    log::info!("[SS] test_done completed");
}

async fn tests() {
   

}

pub fn main() {
    env_logger::Builder::from_default_env()
        .format_timestamp_millis()
        .filter_level(log::LevelFilter::Info)
        .init();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(test_main());
}