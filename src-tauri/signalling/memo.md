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
    2. Other denial of service - no comprehensive protection is implemented, other then some [rate limiting](#sec_rate_limiting) 
       1. <a id = "sec_busy_work">Busy work</a>: When malicious actors create teir rooms and start hijacking bandwidth, imitating legitimate activity. Partially addressed by [message limits](#sec_message_limits)
       2. <a id = "sec_message_flood">Message bursts</a>: if many [busy](#sec_busy_work) connections are established, they might flood the service, so a basic rate limiting should also be in place.  
12. Guardrails:
    1. <a id = "sec_rate_limiting">Rate limiting</a>:
       1. <a id = "sec_idle_connections">Port exchaustion</a>: To prevent malicious actors taking over all the ports, connections will be dropped if no message arrives after 5 seconds the connection was established. 5 seconds are chosen because it is expected that [HS1](#hs1) and [HS2](#hs2) and [HS3](#hs3) with [HS4](#hs4) should happen in an immediate sequence, so if someone just opens a connection to let it sit, he will get filtered. And if it tries opening connection to often, it will potentially get blocked by an external protection service.
       2. <a id = "sec_message_limits">Message limits</a>: since the server handles signalling, it is expected that any participant pair should exchange a limited number of messages per session. Single connection is expected to service a single session, so to contain abuse, a message limit can be imposed on any given connection.
    1. <a id = "sec_ignore_flagged">Flagged connections</a>: when messages inconsistent [rtt tag](#message_el_rtt_tag) arrive form a single connection, drop it and if it tries to reconnect let the external rate limiter block it. Don't touch the other participant - it might be a normal one. Though it should also be able to detect impostors.
    1. <a id = "timeout_incomplete_rtts">RTT timeouts</a>: Stale [rtt records](#rtt_records) should have both connections dropped - staleness is defined by lack of messages going back and forth over a time interval. It should be something reasonable which would allow for a lengthy message processing by participants.
13. Implementation:
    Entities:
      1. ServerTask is spawned to accept connections.
      1. Connection - a class that keeps handles to spawns a tasksets up a ws connection.
      ```
         type ConnectionId = uint64;
         const SEND_BUFFER_LIMIT = 100
         struct Connection {
            send_spsc_q_putter: spsc_message_passing_q; //because of [1-1](#rtt_pair) pair use spsc
            close_notifyer: CacncelationToken;
            receiverLoopJoinHandle: JoinHandle
            close() {
               close_notifyer.cancel();
               receiverLoopJoinHandle.await;
            }
            send(message) {
               // fire and forget - loss handling should be done by participants
               this->send_spsc_q_putter.put(message)
            }
            new(tcpConnection, callback: (message) -> void) {
               [send_spsc_q_getter, send_spsc_q_putter] = new spsc_message_passing_queue(SEND_BUFFER_LIMIT);
               this->send_spsc_q_putter = send_spsc_q_putter;
               this->receiverLoopJoinHandle = spawn([this->close_notifyer, callback, tcpConnection, send_spsc_q_getter]{
                  [ws_ingress, ws_egress] = upgrade_to_ws(tcpConnection).await;
                  senderLoopJoinHandle = spawn([this->close_notifyer, ws_egress, send_spsc_q_getter]{
                     loop {
                        select {
                           this->close_notifyer.cancelled() {
                             break 
                           }
                           msg = send_spsc_q_getter.get().await {
                              match ws_egress.send(msg).await {
                                 ok - continue,
                                 error - {
                                    // connection lost. participant reconnect
                                    this->close_notifyer.cancel();
                                    break;
                                 }
                              }
                           }
                        }
                     }
                  })
                  loop {
                     select {
                        this->close_notifyer.cancelled() {
                           break 
                        }
                        msg = match ws_ingress.get().await {
                           error - {
                              this->close_notifyer.cancel();
                              break
                           }
                        }
                        callback(msg).await.on_error(ignore it); // socker closure triggered externally.
                     }
                  }
                  senderLoopJoinHandle.await.
               })
            }
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
            atomicMarkNonIdle() {

            }
            atomicReadNonIdleAndSetAsIdle() {

            }
         }
         const IDLE_CKECK_TO = 60s;
         fn setUpWsConnection(tcp_connection, server_state) {
            idle_cc: IdleConnectionChecker;
            con_stopper: CancellationToken;
            non_idle_marker: sPtr<NonIdleMarker>>;

            const idle_checking_task = spawn([non_idle_marker, con_stopper](){
               bool checked_idle = false;
               loop {
                  select {
                     con_stopper.cancelled() {
                        break;
                     }
                     sleep(IDLE_CKECK_TO) {
                        if (!non_idle_marker.atomicReadNonIdleAndSetAsIdle()) {
                           con_stopper.cancel();
                           break;
                        }
                     }
                  }
               }
            })
            const forward_msg = [server_state,](rtt_tag, payload: Optional<String>){
               // lock server state
               // check #message_restrictions
            }
            
            bool first_msg = true;
            const msgProcessingClosure = [idle_cc, rtt_ec, non_idle_marker, first_msg](message){
               rtt_ec.rate_limit_msg()?;
               const parsed_msg = parse_incoming(message)?;
               if (first_msg) {
                  non_idle_marker.atomicMarkNonIdle();
                  first_msg = false;
               }
            
            };
            connection = Connection::new(tcpConnection, msgProcessingClosure)
            return {
               connection,
               con_stopper,
               non_idle_marker
            }
         }
         struct ConnectionHandler {
            connection: sPtr<Connection>;
            con_stopper: CancellationToken;
            non_idle_marker: sPtr<NonIdleMarker>>;
            new(tcpConnection, server_state: sPtr<Lock<ServerState>>) {
               idle_cc: IdleConnectionChecker;
               const idle_checking_task = spawn([this->non_idle_marker](){
                  bool checked_idle = false;
                  loop {
                     select {
                        self->con_stopper.cancelled() {
                           break;
                        }
                        sleep(IDLE_CKECK_TO) {
                           if (!this->non_idle_marker.atomicReadNonIdleAndSetAsIdle()) {
                              this->close();
                              break;
                           }
                        }
                     }
                  }
               })
               const forward_msg = [server_state](rtt_tag, payload: Optional<String>){
                  // lock server state
                  // check
               }
               const register_msg = [server_state](rtt_tag) {

               }
               bool first_msg = true;
               const msgProcessingClosure = [idle_cc, rtt_ec, this->non_idle_marker, first_msg](message){
                  rtt_ec.rate_limit_msg()?;
                  const parsed_msg = parse_incoming(message)?;
                  if (first_msg) {
                     this->non_idle_marker.atomicMarkNonIdle();
                  }
                  if (parsed_msg.type == Register) {

                  } else if (parsed_msg.type == Send) {
                     forward_msg().await?;
                  } else {
                     return;
                  }
                  this->non_idle_marker.atomicMarkNonIdle();
               };
               this->connection = Connection::new(tcpConnection, msgProcessingClosure)
            }
            mark_non_idle() {
               this->non_idle_marker.atomicMarkNonIdle();
            }
            close() {
               this->connection.close();
            }
         }
         IdleConnectionChecker
            In ConnectionHandler - operates in connection receiver loop....needs to close the connection if there are no meaningful messages after 5 seconds.
               If only gibberish arrives, also block the thing. The user is given 5 seconds to send something worth looking at. If it registers itself successfully (server) then this check is no longer performed and further checking is done by incomplete rtt monitor.

         rtExpiryChecker (extra task + lock server state):
            malicious server and client will just keep sending stuff each other, so if two records are connected, dont apply this check
            con1: RttRecord::lastMsgForwardedTs > 60s => cancel
            con2
            con3
            .
            .
            .
            .
            conN
         conHandler
               Connection
                     receiverLoop (callback; cancellation; ratelimit)
      ```
      1. A list of connections is maintained in the Server.
    2. Connection - a class that handles data receipt and delivery from and to a participant.
    1. State - 

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