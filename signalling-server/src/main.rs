mod wsclient;
mod wsserver;

fn hello() {
    println!("Hello from mmod!");
}

fn test_select() {
    println!("Hello from select!");
}


use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration, Instant};
use webrtc::ice::rand;

async fn select_test() {
    let start = Instant::now();

    let mut var1 = String::from("initial");
    let mut var2 = String::from("initial");
    let vRef1 = &mut var1;
    let vRef2 = &mut var2;
    let task1 = async move {
        for _i in 0..10 {
            sleep(Duration::from_millis(200)).await;
            let ts = format!("{:.2?}", start.elapsed());
            (*vRef1).push_str(&format!("; {}", ts));
            println!("task1 wrote at {}", ts);
        }
        1
    };

    let task2 = async move {
        for _i in 0..20 {
            sleep(Duration::from_millis(200)).await;
            let ts = format!("{:.2?}", start.elapsed());
            (*vRef2).push_str(&format!("; {}", ts));
            println!("task2 wrote at {}", ts);
        }
        2
    };

    println!("starting select...");

    tokio::select! {
        v = task1 => println!("select winner: task1 returned {}", v),
        v = task2 => println!("select winner: task2 returned {}", v),
    }

    println!("select done, waiting 5 seconds...");
    sleep(Duration::from_secs(5)).await;

    println!("var1 after wait: {:?}", var1);
    println!("var2 after wait: {:?}", var2);
}



#[tokio::main]
async fn main() {
    while 1 == 1 {
        rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");
        // select_test().await;
        //     wsserver::run_server().await;
        wsclient::run_client("redacted", String::from("hello")).await;
        sleep(Duration::from_secs(1)).await;
    }
}