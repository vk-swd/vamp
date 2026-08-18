1. The signalling server (SS) forwards payloads between two participants.
   1. To separate concerns it is made as a simple forwarding middlebox. Participants will decide on what to do with the information forwarded.
   2. The SS does not assign protocol meaning to the payload. It treats a routing tag as a two-person room.
1. Message elements:
   1. <a id = "message_el_rtt_tag">Routing tag (RT)</a> used to create the [routing record](#rtt_records) or/and add a participant into [rtt pair](#rtt_pair)
   2. <a id = "message_el_payload">Optional payload</a> - unmodified char buffer forwarded to [another](#rtt_pair) participant.
      1. Can be missing, then the [RT](#message_el_rtt_tag) will be used to create/update [routing record](#rtt_records) .
2. Persistence state:
   1. <a id = "state_connection">Connection state</a> - used for breaking [bursts](#sec_message_flood) and for [message limits](#sec_message_limits). Owned by the connection , not shared with other threads and limits incoming messages regardless of their contents.
   1. Connection table (<a id = "ct">CT</a>) - contains a record of physical ws connections.
      1. Implemented as a <<a id =  "connection_id">CID</a>, Connection> map. CID is a unique id assigned by SS when TCP connection is open. A record is made when WS connection is upgraded.
      2. Connection record contains the outgoing buffer to queue message for sending.
   2. Routing table (<a id="rtt">RTT</a>)
      1. Contains <a id="rtt_records">RTT records</a> that consist of:
         1. <a id = "rtt_tag">Routing tag (RT)</a> - identifies the forwarding rule. Supposed to be unique and belong to two conenctions exclusively.
         2. <a id="rtt_pair">Pair of connections</a>. When one connection receives a message, it tries to forward it to the other connection.
9. Flows:
   1. Happy path:
      1. <a id="hs1">HS1</a>: First participant (p1) -> SS: connect, assign connection id, create connection record.
      2. <a id="hs2">HS2</a>: p1 -> SS: sends a message with no payload and creates routing record using the [rtt tag](#message_el_rtt_tag).
      3. <a id="hs3">HS3</a>: Second participant (p2) -> SS: connect, assign connection id, create conenction record
      4. <a id="hs4">HS4</a>: p2 -> SS: sends a message with a payload and:
         * fills the last spot in the created routing record using the [rtt tag](#message_el_rtt_tag)
         * sends data to the p1, which is found using the [rtt record](#rtt_records) and the [CT](#ct) 
      5. <a id="hs5">HS5</a>: p2 -> SS: receive message from p2 and route it to p1 like in [HS4](#hs4), an so on.
   2. Unhappy paths:
       1. P1 disconnects after [HS1](#hs1):
           1. [HS3](#hs3) and [HS4](#hs4) happen with no p1 - messages dropped and rate limited.
              1. Once p1 reconnects, it will take its spot in the room and the forwarding will work. But there would be an opening for the [room spot hijacking](#sec_tag_hijack)
       3. Any participant sends message without [payload](#message_el_payload) - ratelimit and drop this message. If the [RT](#rtt_tag) needs change, new connection should be established.
       5. Participants send messages with inconsistent [RT tags](#message_el_rtt_tag) - drop the connection. See [rate limiting measures](#sec_ignore_flagged).
       5. [HS2](#hs2) and [HS4](#hs4) don't happen - see [idle connections](#sec_idle_connections)
       6. Any kind of abuse happening when the malicious actor [hijacked](#sec_tag_hijack) the spot should be handled by users themselves (an encryption could be implemented at this layer, but it will not be implemented now).

11. Security:
    1. The [tag hijack](#sec_tag_hijack) suggests anyone can impersonate a room participant and deny connection to someone else or engage in an interaction. How it addressed:
       1. Long [RT tags](#rtt_tag) and rate limiting - makes RT fishing long and unpredicteable.
       2. Can be addressed by an heuristic checking that [HS2](#hs2), [HS4](#hs4) sequence took place and the [HS2](#hs2) was denied for someone else trying same tag, but it is out of scope for now.
       3. It is easy to detect in logging. Which is to be implemented.
       4. [No forwarding feedback](#sec_no_forward_ack) - do not send feedback to let anyone know that some tag does not belong toa ny participants.
    2. Other denial of service - no comprehensive protection is implemented, other then some [rate limiting](#sec_rate_limiting) 
       1. <a id = "sec_busy_work">Busy work</a>: When malicious actors create teir rooms and start hijacking bandwidth, imitating legitimate activity. Partially addressed by [message limits](#sec_message_limits)
       2. <a id = "sec_message_flood">Message bursts</a>: if many [busy](#sec_busy_work) connections are established, they might flood the service, so a basic rate limiting should also be in place.  
12. Guardrails:
    1. <a id = "sec_rate_limiting">Rate limiting</a>:
       1. <a id = "sec_idle_connections">Port exchaustion</a>: To prevent malicious actors taking over all the ports, connections will be dropped if no message arrives after 5 seconds the connection was established. 5 seconds are chosen because it is expected that [HS1](#hs1) and [HS2](#hs2) and [HS3](#hs3) with [HS4](#hs4) should happen in an immediate sequence, so if someone just opens a connection to let it sit, he will get filtered. And if it tries opening connection to often, it will potentially get blocked by an external protection service.
       2. <a id = "sec_message_limits">Message limits</a>: since the server handles signalling, it is expected that any participant pair should exchange a limited number of messages per session. Single connection is expected to service a single session, so to contain abuse, a message limit can be imposed on any given connection.
    1. <a id = "sec_ignore_flagged">Flagged connections</a>: when messages inconsistent [rtt tag](#message_el_rtt_tag) arrive form a single connection, drop it and if it tries to reconnect let the external rate limiter block it. Don't touch the other participant - it might be a normal one. Though it should also be able to detect impostors.
    1. <a id = "sec_lack_of_forwarding">Stale connections</a>: Stale [rtt records](#rtt_records) mean no forwarding occurs due to lack of other participant or not sending any payload. In a signalling exchange both parties should send something so if one does not send anything to be forwarded, it is removed. It should be something reasonable which would allow for a lengthy message processing by participants.
    1. <a id = "sec_no_forward_ack">Don't give feedback</a> in whether a [forwarding pair](#rtt_pair) had another peer where the message was forwarded or not. This should give fewer information to anyone trying to probe the tags.
13. Implementation:


   ```mermaid
   flowchart
      subgraph Server
         accept_connections
         TcpListener
         spawn
         serverState
      end
      spawn1["spawn async task"]
      spawn2["spawn async task"]
      spawn3["spawn async task"]

      TcpListener -.-> accept_connections
      accept_connections --> spawn
      spawn --> |loop|accept_connections
      spawn --> set_up_ws_connection
      spawn-->set_up_ws_connection1[set_up_ws_connection]
      spawn-->set_up_ws_connection2[...]

      set_up_ws_connection -.->|add connection on connection start <br> remove connection and rtt records on its end|serverState

      set_up_ws_connection -->|listen_task|spawn1
      spawn1 --> wait_for_incoming
      ws_con -.-> wait_for_incoming 
      wait_for_incoming --> rate_limit_by_time_window_and_total_cnt_and_inconsistent_tag
      dst_sender_q["Send queue"]
      NonIdleMarker
      subgraph MsgProcessor
         record_rtr_and_get_forwarding_queue["record_rtr_and_get_forwarding_queue<br>schedule_send" ]
         rate_limit_by_time_window_and_total_cnt_and_inconsistent_tag["Rate limit by:<br>1. Time window<br>2. Total count<br>3. Tag"]


         rate_limit_by_time_window_and_total_cnt_and_inconsistent_tag -.-> msgRateLimiter
         msgRateLimiter -.-> rate_limit_by_time_window_and_total_cnt_and_inconsistent_tag

         rate_limit_by_time_window_and_total_cnt_and_inconsistent_tag --> mark_incoming
         mark_incoming --> record_rtr_and_get_forwarding_queue
         serverState -.-> |find connection to forward to|record_rtr_and_get_forwarding_queue
         record_rtr_and_get_forwarding_queue -.->|add rtt record<br>remove rtt record with absent connection| serverState
         record_rtr_and_get_forwarding_queue --> mark_forwarded
      end

      mark_forwarded --> |loop|wait_for_incoming
      mark_incoming -.-> NonIdleMarker
      mark_forwarded -.-> NonIdleMarker
      record_rtr_and_get_forwarding_queue -.-> dst_sender_q



      set_up_ws_connection -->|egress_task|spawn2
      spawn2-->|egress_task|wait_new_to_send
      dst_sender_q -.-> wait_new_to_send 
      wait_new_to_send --> send
      send --> |loop|wait_new_to_send
      send -.-> ws_con

     
      set_up_ws_connection -->|start_idle_checker|spawn3
      spawn3-->|start_idle_checker NonIdleMarker|check_idle_value
      check_idle_value --> sleep
      sleep --> |loop|check_idle_value
      NonIdleMarker -.-> check_idle_value
      check_idle_value ==> |cancel all async tasks<br>stop the conenction| set_up_ws_connection
      set_up_ws_connection -.-> ws_con
      ws_con -.- serverState
      dst_sender_q -.- serverState
   ```




    Entities:
      1. ServerTask is spawned to accept connections.
      1. Connection - a class that keeps handles to spawns a tasksets up a ws connection.
      ```
         type ConnectionId = uint64;
         const SEND_BUFFER_LIMIT = 100
         
         fn spawnEgressTask(close_notifyer, ws_egress, send_spsc_q_getter) {
            return spawn([close_notifyer, ws_egress, send_spsc_q_getter] {
               loop {
                  select {
                     close_notifyer.cancelled() {
                        break;
                     }
                     msg = send_spsc_q_getter.get().await {
                        match ws_egress.send(msg).await {
                           ok - continue,
                           error - {
                              // connection lost. participant reconnect
                              close_notifyer.cancel();
                              break;
                           }
                        }
                     }
                  }
               }
            })
         }

      ```

      ```
         type RoutingTag = String;
         struct RoutingRecord {
            listener: Option<ConnectionId>;
            subscriber: Option<ConnectionId>;
         }
      ```
      ```
         struct ServerState {
            rtt: Hash<RoutingTag, RoutingRecord>
            ct: Hash<ConnectionId, ConnectionHandler>
         }
      ```
      ```
         struct NonIdleMarker {
            // Plan for it to be used on the first message and 
            atomic_incrememnt_incoming();
            atomic_incrememnt_forwarded();
            atomic_get_incoming();
            atomic_get_forwarded();
            atomicReadNonIdleAndSetAsIdle() {

            }
         }
         struct MsgRateLimiter {
            tag: Option<RttTag>;
            rateLimitByTime();
            limitMessages();
            tryBrandRttTag(tag) {
               if (!this->tag) {
                  this->tag = tag;
               }
               if (this->tag != tag) {
                  return Err("impostor")
               }
            }
         }
         // enough time to upgrade to ws and receive forwardable message
         // so a strong sequence of ws upgrade => 1 message receive => start waiting is required.
         const IDLE_CKECK_TO = 60s;
         const FIRST_MESSAGE_MAX_DELAY = 5s;
         fn startIdleChecker(non_idle_marker, con_stopper) -> JoinHandle {
            const idle_checking_task = spawn([non_idle_marker, con_stopper](){
               bool checked_idle = false;
               // #sec_idle_connections
               let timeout = FIRST_MESSAGE_MAX_DELAY;
               let incoming = 0;
               let forwarded = 0;
               const check_incoming = [](){
                  const new_incoming = non_idle_marker.atomic_get_incoming();
                  if (new_incoming == incoming) {
                     return false;
                  }
                  incoming.assign(new_incoming);
                  return true;
               }
               const check_forwarded = [](){
                  const new_forwarded = non_idle_marker.atomic_get_incoming();
                  if (new_forwarded == forwarded) {
                     return false;
                  }
                  forwarded.assign(new_forwarded);
                  return true;
               }
               let checker = check_incoming;
               loop {
                  select {
                     con_stopper.cancelled() {
                        break;
                     }
                     sleep(timeout) {
                        if (!checker()) {
                           con_stopper.cancel();
                           break;
                        }
                     }
                  }
                  timeout = IDLE_CKECK_TO; 
                  checker = check_forwarded;
               }
            })
            return idle_checking_task;
         }
         fn recordConnection(tcp_connection_bundle, cid, sercer_state) {
            const lock_guard = server_state.lock();
            server_state.rtt.get(cid, tcp_connection_bundle);
         }
         fn record_rtr_and_get_forwarding_queue(rtt_tag, cid, server_state) {
            const locked_state = server_state.lock();
            const connection = locked_state.get(cid);
            if (!locked.state.rtt.has(rtt_tag)) {
               locked.state.rtt.insert(rtt_tag, [cid]);
               return null_opt;
            }
            const rtt_record = locked.state.rtt.get(rtt_tag);
            if (rtt_record.pair.full() && !rtt_record.pair.contains(cid)) {
               // rtt_tag occupied - let connection expire
               return null_opt;
            }
            if (!rtt_record.pair.full() && !rtt_record.pair.contains(cid)) {
               // rtt_tag occupied - let connection expire
               rtt_record.pair.append(cid);
            }
            const other = get_other_con(rtt_record.pair);
            if (!other) {
               return null_opt;
            }
            return locked_state.ct.get(other)?.send_spsc_q_putter.clone();
         }

         fn makeFwdCallback(server_state, src_con_id) {
            return [server_state, src_con_id](rtt_tag, message){
               const get_dst_sender = record_rtr_and_get_forwarding_queue(rtt_tag, src_con_id, server_state)
               return get_dst_sender.try_send(message)?
            }
         }
         fn makeMsgProcessingClosure(msg_rate_limiter, non_idle_marker, con_stopper, fwd_msg_cb) {
            return [msg_rate_limiter, non_idle_marker, con_stopper](message) {
               // #sec_message_flood
               msg_rate_limiter.rateLimitByTime()?;
               // #sec_busy_work
               msg_rate_limiter.limitMessages()?;

               const parsed_msg = parse_incoming(message)?;
               non_idle_marker.atomic_incrememnt_incoming();
               match msg_rate_limiter.tryBrandRttTag(parsed_msg.rtt_tag) {
                  ok -> {}
                  err -> {
                     con_stopper.cancel();
                     return;
                  }
               }  
               fwd_msg_cb(parsed_msg.rtt_tag, message)?
               non_idle_marker.atomic_incrememnt_forwarded();
            };
         }
         fn setUpWsConnection(tcp_connection, server_state) {
            con_stopper: CancellationToken;
            non_idle_marker: sPtr<NonIdleMarker>>;

            const src_con_id = CID::generate();

            const fwd_callback = makeFwdCallback(server_state, src_con_id);
            spawn([server_state, fwd_callback](){
               const msg_rate_limiter = new MsgRateLimiter;               
               const [ws_ingress, ws_egress] = upgrade_to_ws(tcp_connection).await?;
               connection = Connection::new(con_stopper, tcpConnection, msgProcessingClosure).await
               idle_check_task = startIdleChecker(non_idle_marker.clone(), con_stopper.clone());

               close_notifyer: CacncelationToken;
               [send_spsc_q_getter, send_spsc_q_putter] = new spsc_message_passing_queue(SEND_BUFFER_LIMIT);

               const msg_process_callback = makeMsgProcessingClosure(msg_rate_limiter, non_idle_marker, con_stopper, fwd_callback);
               const receiving_join_handle = listen_task(close_notifyer, msg_process_callback, ws_ingress);
               const send_join_handle = spawnEgressTask(close_notifyer, ws_egress, send_spsc_q_getter);
               recordConnection(src_con_id, {
                  spawn(connection.listen()),
                  con_stopper,
                  non_idle_marker
               })
               await_both(receiving_join_handle, receiving_join_handle);
               removeRecordsFor(src_con_id);
            })
         }
         
         async listen_task(close_notifyer, msg_process_callback, ws_ingress) {
            return spawn([close_notifyer, msg_process_callback, ws_ingress]{
               loop {
                  select {
                     close_notifyer.cancelled() {
                        return Err; 
                     }
                     msg = match ws_ingress.get().await {
                        error - {
                           close_notifyer.cancel();
                           return Err;
                        }
                     }
                     msg_process_callback(msg).await.on_error(ignore it); // socker closure triggered externally.
                  }
               }
            })
         }
         IdleConnectionChecker
            In ConnectionHandler - operates in connection receiver loop....needs to close the connection if there are no meaningful messages after 5 seconds.
               If only gibberish arrives, also block the thing. The user is given 5 seconds to send something worth looking at. If it registers itself successfully (server) then this check is no longer performed and further checking is done by incomplete rtt monitor.
      ```
     

UPD notes:
1. Removing message roles and types, because 
    1. those are an example of securuty through obscurity and don't bring much to limit abuse. Especially since this is a public code *face palm*. 
    2. Identity could be checked by participants themselves.
    3. Not closing bad connections or dropping messages silently, open other paths for abuse and gets in the way of other ways of rate limiting (like blocking connection attempts).
    4. Roles also shouldn't matter because signalling server shouldn't enforce any kind of relationships. Just forward messages.
   So the implementation is: 
    1. Treat this pair as a 2 person room. One participant forwards to another. No message types, just optional payload. 
    2. Once someone announced its rtt_tag, no other tag is allowed for this connection. 
    3. The tag must be announced immediately. After that, everything is rate limited and the pair is monitored for activity. 
    4. If someone sends wrong rtt_tag this connection should be closed.
    5. Messages without payload will beused to register participant in rtt or will be dropped/rate limited. rtt.

Tests:
   1. General use:
      1. Three participants: S1, C1, C2, SS - four participants: SS - signalling server; S1, C1, C2 - participants connecting to the SS. S1 will open connection and wait until C1 or C2 to connect to it. Different scenarios are to be tested to perform several execution flows:
         1. Happy path - participants connect to SS and exchange data
            1. Check that messages sent within all the restrictions enforced by the server are delivered on both sides.
         2. Test [](#sec_busy_work) prevention
         3. Test [](#sec_idle_connections) prevention (use shorter timeouts in server config)
         4. Test [](#sec_ignore_flagged) - bad connection should be closed
         5. Test [](#sec_lack_of_forwarding) - connect, register but dont send
         6. Test [](#sec_message_flood) - configure 1 msg per forever, send 10, fwd 1. Then test shorter window (couldb e flaky test due to network conditions).
         7. Test [](#sec_message_limits) - set 3 msgs, send 10, receive 3. Count drop stats.
