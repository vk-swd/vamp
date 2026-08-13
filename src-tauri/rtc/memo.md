


This is a rust implementation of a routine establishing ICE datachannel using a websocket signalling server.

It's goal is to open RTCPeerConnection to other peer and a datachannel over it and maintain both.

To do that, a connection to signalling server and to a turn server need to be maintained as well.

### Control Flow

There are several parallel contorl flows:
1. #### Connection to signalling server:

    Keep reestablishing connection while it is required. Otherwise close it.
2. #### Connection to another participant:

    Signalling server [does not provide message forwarding feedback](../signalling/memo.md##sec_no_forward_ack) and its design allows an unreliable delivery to another peer:
    ```mermaid
    sequenceDiagram
        p1 ->> ss: connect
        p1 ->> ss: offer1
        rect rgb(260, 200, 200)
        ss ->> ss: discard offer1
        end
        p2 ->> ss: connect
        p1 ->> p1: resend timeout
        p1 ->> ss: resend offer1
        ss --x p2: connection lost
        rect rgb(260, 200, 200)
        ss ->> ss: discard offer1
        end
        ss -> p2: connection restored
    ```
    #### Ack messages
     Ack messages were introduced for faster failure detection.
    
     Acks are are sent back to sender, so that this sender can identify networking issue and retry the delivery. 
     
     Delivery retries were decided to move away from the [negotiation layer](#negotiation-handling) for simplicity. Negotiator will only track stale state timeout to restart negotiation itself, not to resend concrete messages (out buffer overflow = failure to send, timeout = clear buffer and renegotiate).

     #### Unordered messages
     But even with delivery confirmation there is a problem of unordered message delivery, which would prompt some message buffering and preprocessing on a receiver's side:

      ```mermaid
    sequenceDiagram
        participant p1
        participant ss
        participant p2
        rect rgb(220, 200, 200)
        note over p1, p2: unordered offer1 caused missing candidate 1
        p1 ->> ss: offer1
        ss --x p2: conenction drop
        p1 ->> ss: candidate 1
        ss ->> ss: offer1 drop
        ss -> p2: connection restore
        ss ->> p2: candidate1
        p2 ->> p1: candidate1 ack
        rect rgb(260, 200, 200)
        p2 ->> p2: candidate 1 ignored
        p1 ->> p2: offer1 resend
        p2 ->> p2: RTCPeerConnection create
        end
        end

        rect rgb(220, 200, 200)
        note over p1, p2: failed offer delivery and offer reset promote wrong offer
        p1 ->> ss: offer1
        ss --x p2: conenction drop
        p1 ->> p1: offer reset
        ss -> p2: connection restore
        rect rgb(260, 200, 200)
        p1 ->> p2: offer2
        p1 ->> p2: resend offer1
        end
        end
    ```
    Such [lack of order](#unordered-messages) is addressd by:
    1. <a id="unordered_signalling_messages_payload_seq_num">Sequence numbers</a> in payload messages.
    2. <a id="unordered_signalling_messgaes_hol">Send one message at a time</a>. It was chosen as an alternative to a reorder buffer to keep code simpler and message flow more steady as low latency is not as critical in the negotiation stage at this scale.

3. #### Negotiation handling:
    The core principles are described in https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation - polite peer will disregard negotiation that he initiated and take impolite peer's offer for basis.

    ```mermaid
    sequenceDiagram
        participant p1 as Polite
        participant ss
        participant p2 as Impolite
        p1 ->> ss: polite offer
        p2 ->> ss: impolite offer
        ss ->> p1: impolite offer
        ss ->> p2: polite offer
        p2 ->> p2: drop polite offer
        p1 ->> p1: rollback and take impolite offer
        p1 ->> p2: impolite answer
    ```
    ### Stale answers and candidates

    Even with measures against [message loss](#ack-messages) and [reordering](#unordered-messages) there are several unhappy paths (UPs) that might cause wrong answers or candidate messages be addressed to negotiations session:

    ```mermaid
    sequenceDiagram
        participant p1 as Polite
        participant ss
        participant p2 as Impolite

          
        rect rgb(220, 200, 200)
        note over p1,p2: UP - reset offer - stale answer
        p1->>ss: offer1
        p1->>p1: reset offer
        ss->>p2: offer1
        p2->>ss: answer1
        rect rgb(260, 200, 200)
        p1->>ss: offer2
        ss->>p1: answer1
        end
        end
 
        rect rgb(220, 200, 200)
        note over p1,p2: UP - reset offer - stale answer 2
        p1->>ss: offer1
        p2->>ss: offer2
        ss->>p2: offer1
        p2->>p2: discard offer1
        ss->>p1: offer2
        p1->>p1: rollback offer1
        p1->>ss: answer2
        p2->>p2: reset connection
        rect rgb(260, 200, 200)
        p2->>ss: offer3
        ss->>p2: answer2
        end
        end
    ```
    
    <a id="negotiation_session_id">Negotiation session id</a> is introduced to make sure that session receives messages relevant to current sdp pair.


### Signalling connection handling pipeline
if i get ack to element in the out q , then i get another one when i resend it and i cant get one before i send it.

```mermaid
flowchart RL
    subgraph Block1["Negotiator"]
        subgraph IQ["Incoming Queues"]
            A1["Answers and Candidates"]
            A12["Offers"]
        end
        A2["Processing Task"]
        subgraph Db["Ice Restart Debouncer"]
            A11["IceRestartQueue"]
            A22["IceRestartDebouncer"]
        end
        A3["Session Id Filter"]
        A4["RtcPeerConnection"]

        A12 -->|Politely restart negotiation| A2
        A4 -->|Candidates| A1
        A1 -->A3
        A3 -->|Handle negotiation messages| A2
        A4 -->|"ICE (dis)connected"| A22
        A2 -->|"Negotiation started/ended"| A22
        A22 -->|"Signal restart"| A11
        A11--> |"Get restart signal"| A2
        A2 -->|Start/end negotiation| A3
    end

   

    subgraph wsc["WsConnector"]
        subgraph queues["Async Queues"]
            C1["Send<br>Queue"]
            C2["Ack Queue"]
        end
        C4["Sender Task"]
        C5["Receiver Task"]
        C6["Filter Old and Duplicate msgs"]
        C1-->|Schedule delivery|C4
        C5-->C6
        C6-->A1
        C6 --> A12
        C5-->|Ack for our sent msg|C2
        C5-->|Ack to received msg|C1
    end

    A2 --> |Reliable send| queues
    
```

```mermaid
    sequenceDiagram
        participant p as Other<br>Peer
        participant ss as Signalling<br>Server
        participant pcrec as WsReceiver
        participant wc as WsSender
        participant pcout as OutBuffer
        participant pcn as InBuffer
        participant i as Interruptor
        participant neg as Negotiation
        neg ->> pcn: offer1
        loop
            wc -> pcout: try get <br> prioritised  <br>  messages: <br> none found
            wc ->> wc: no acks to process
            wc ->> wc: no acks to send        
            wc <<->> pcn: get offer1
            loop
                par
                    wc ->> ss: try send or restart <br> ws connection <br> including WsReceiver
                    and
                    i ->> wc: mb interrupt + <br> custom op
                end
            end
            par
                wc -> pcout: wait for offer1 ack
            and
                i ->> wc: mb interrupt
            end
        end

        neg ->> pcn: candidate1
        neg ->> pcn: candidate2
        ss ->>p: offer1
        p ->> pcrec: offer1 ack
        pcrec ->> pcout : offer1 incoming ack

        wc <<->> pcout : get and process <br> offer1 ack
        wc <<->>  pcn: get candidate 1 and repeat the loop

        p ->> pcrec : answer1
        pcrec ->> pcout : answer1 outgoing ack 
        pcrec ->> neg : answer1

```

### Restarting ICE
1. 



#### Implementation

1. Signalling:
```

struct WireMessage<T> {
    // look up ws_server implementation, probably should make a common type
    tag: String,
    message: Option<T>
}
struct WsTransportMsg<T> {
    seq_num: u64,
    node_id: String
    payload: Option<T>
}

enum InterruptorMsg {
    CancelAndClearQueue,
    RestartWsSocket // if added after ws restart - the queue will be cleaned up before starting
}

struct IncomingMsgHandler<T> {
    IncomingMsgHandler() {
        
    }
    to_transport(msg: String) => WireMessage<WsTransportMsg<T>> {
        return sede_parse_or_something(msg)?;
    }
    handle(s_msg: T) {
        
    }
}

fn startReceiveTask<T>(rx, stopper, receipt_handler, mb_filter_msg, ack_q, send_q) -> JoinHandle {
    return tokio::spawn(move [rx, stopper, mb_filter_msg, receipt_handler, ack_q, send_q]() => {
        while {
            select {
                stopper.cancelled() {
                    break;
                }
                match rx.next() {
                    Ok(msg_raw) => {
                        const wire_msg: WireMessage<WsTransportMsg<T>> = receipt_handler.to_transport(msg_raw);
                        const t_msg = wire_msg.message;
                        const ack = {t_msg.seq_num, t_msg.node_id};
                        if (t_msg.payload) {
                            send_ack(t_msg.id, t_msg.seq_num);
                            mb_filter_msg(t_msg);
                            receipt_handler.handle(t_msg.payload).ignore_error();
                        } else {
                            ack_q.try_send({t_msg.seq_num, t_msg.node_id}) {
                                ok -> _
                                err -> {
                                    //log and record metric. Normally it should not happen
                                    // but if nobody drains acks (no signalling happening sends), it might happen.
                                }
                            }
                        }
                    }
                    Err() => {
                        // dont reset connection, it will be restarted from outside
                        break;
                    }
                }
            }
        }
    })
}

fn startSenderTask(tx, send_q, stopper) {
    return spawn([tx, send_q, stopper]() {
        loop {
            select {
                stopper.cancelled(),
                match send.next() => {
                    Ok(msg) => {
                        match tx.send(msg).await {
                            Ok() => _
                            Err() => {
                                // something wrong with websocket, need restart
                                break;
                            }
                        }
                    }
                    Err() => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                        sleep(1s);
                    }
                }
            }
        }
    })
}
struct WsConnector {
    sender_task: JoinHandle
    receiver_task: JoinHandle;
    send_q: mpsc_in_handle;
    ack_q: mpsc_in_handle;
    stopper: CancelToken;

    receipt_handler: Arc<IncomingMsgHandler>; //could be a generic trait with a handle(T) function 
    new(url, rtt_tag, node_id, last_seq_number) => ConnectionHandler {
        this.last_in_node_id = node_id;
    }
    mb_filter_msg(seq_num, node_id) {
        //if never seen this id, assign and start tracking, 
        // otherwise check if this seq num is not smaller or the same as the one received before; 
        // Add required state
    }
    makeSender() {
        loop {
            const local_stopper = new TokioCancelToken();
            const (rx, tx) = tungstenite_whatever::open(url);
            const receive_handle = startReceiveTask(rx, 
                                                    local_stopper.clone(),
                                                    this.receipt_handler.clone(),
                                                    this.ack_q.clone(),
                                                    this.send_q.clone()
            );
            const sender_handle = startSenderTask(tx, this.send_q.clone(), local_stopper);
            select {
                this.stopper.cancelled() {
                    local_stopper.cancel();
                    receive_handle.await();
                    sender_handle.await();
                    break;
                }
                receive_handle {
                    // likely some error occurred needing reconnection
                    local_stopper.cancel();
                    sender_handle.await();
                    // continue and restart connection
                }
                sender_hadnle {
                    // likely some error occurred needing reconnection
                    local_stopper.cancel();
                    receive_handler.await();
                    // continue and restart connection
                }
            }
            // add a metric for connection restarts
        }
    }
    stop() {
        this.stopper.cancel();
    }
    send_and_wait_ack(msg_out: WsTransportMsg<SignalMsg>,
                      ack_q&, send_q&) {
        // not a thread safe function - ack queue can only be 
        // polled by a single task at a time
        match send_q.try_send(msg_out).await {
            Ok() => _;
            Err() => {
                // can't send the message (buffer full or somehting else) 
                // retry with a delay + connection restart is handled in makeSender
            }
        }
        loop {
            match this.ack_q.next() {
                Ok(ack) => {
                    //we might be getting old acks, those are safe to be ignored.
                    if (seq_num == ack.seq_num) {
                        return Ok();
                    }
                    //ignore unexpected akk and keep waiting.
                    continue;
                }
                Err() => {
                    // ack queue is not closed for anything
                    // should never happen but in case it does add logs and metrics
                }
            }
        }      
    }
    send_and_wait_ack_repeated(msg_out: WsTransportMsg<SignalMsg>,
                      ack_q&, send_q&) {
        loop {
            select {
                sleep(6s) => {
                    continue;
                }
                match send_and_wait_ack() {
                    Ok() => return Ok()
                    Err() => continue; // if connection related problems will be handled by
                    // 
                }
            }
            // sleep in case send_and_wait_ack fails fast - dont want a flood
            sleep(1s);           
        }               
    }

    send_ack(sn, id) {
        const msg_out: WsTransportMsg<SignalMsg> = {sn, id};
        match send_q.try_send(msg_out).await {
            Ok() => _;
            Err() => {
                // can't send the message (buffer full or somehting else) to ws - restart connection
            }
        }
        // Don't wait for acks on acks
        // Lost ack = deliver retry
    }

    send(msg: SignalMsg) {
        // If cancelled, should not have leftover state:
        // send_q will be emptied by sender task
        // might loose some acks, but i won't need those acks if send is cancelled

        const sn = this.seq_num_out.next();
        const id = this.node_id_out;
        const msg_out: WsTransportMsg<SignalMsg> = {sn, id, msg};

        // infinite send. can be blocked by cancelling the delivery from outside
        // delivery retries will done indefinitely here
        select {
            send_and_wait_ack_repeated(msg_out, this.ack_q, this.send_q)
            this.stopper.is_cancelled() => Err(the stopper wil decide what to do)
        }
    }
}

```