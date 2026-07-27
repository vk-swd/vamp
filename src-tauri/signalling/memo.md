1. The signalling server (SS) forwards offers and answers.
   1. To separate concerns it is made as a simple forwarding middlebox. Participants will decide on what to do with the information forwarded.
2. Persistence state:
   1. Connection table (<a id = "ct">CT</a>) - contains a record of physical ws connections.
      1. Implemented as a <<a id =  "connection_id">CID</a>, Connection> map. CID is a unique id assigned by SS when TCP connection is open. A record is made when WS connection is upgraded.
      2. Connection record contains the outgoing buffer to queue message for sending.
   2. Routing table (<a id="rtt">RTT</a>)
      1. Contains <a id="rtt_records">RTT records</a> that consist of:
         1. <a id = "rtt_tag">Routing tag (RT)</a> - identifies the forwarding rule. Supposed to be unique and belong to two conenctions exclusively.
         2. <a id="rtt_pair">Pair of connections</a> where each connections belongs to a distinct <a id="rtt_roles">RTT role</a>:
            1. <a id = "rtt_role_listener">Listener</a> - opens ws connection and announces RT with a Register message. The ws connection creates a record in [CT](#ct). The Register message creates a record in RTT.
            2.  <a id = "rtt_role_subscriber">Subscriber</a> - opens ws connection and sends a Send message with a payload to the [Listener](#rtt_role_listener). The ws connection and the Send message create records in the same tables as for the [Listener](#rtt_role_listener).
      2. When connection receives a message, it looks up its [RTT record](#rtt_records):
         1. If there is no record - it adds one and decides which [role](#rtt_roles) to take based on the 
         <a id = "message_type">message type</a> : 
            1. <a id= "message_register">Register</a> - contains [RT](#rtt_tag). It's intention is set up a [listener](#rtt_role_listener) role in the [rtt record](#rtt_records).
            2. <a id = "message_send">Send</a> - contains contains [RT](#rtt_tag) and a <a id = "message_payload">payload</a>. It will prompt different action based on the [rtt role](#rtt_roles) of a connection where this message is coming from:
               1. The [Subscriber](#rtt_role_subscriber) will send it to [Listener](#rtt_role_listener)
               2. A [listener](#rtt_role_listener) will send it to [subscriber](#rtt_role_subscriber).
                      
            This allows the following problems to happen:
            1. <a id="Note1">Listener takeover</a>: it means that the [Listener](#rtt_role_listener) role is taken by whoever registers first.
            2. <a id="Note2">Listener conflict</a>: If another connection tries regiestering same CT it will be denied.
            3. <a id="Note3">Client takeover</a>: If [Subscriber](#rtt_role_subscriber) records RT but [Listener](#rtt_role_listener) record is not there, his message is dropped, but the record stays as long as the connection stays. He can retry delivery for the same RT until the [Listener](#rtt_role_listener) comes. If another [Subscriber](#rtt_role_subscriber) comes and sends the same RT, he will be ignored.
         2. If there is record, appropriate [role](#rtt_roles) is assigned in the [rtt record](#rtt_records) with the following <a id = "message_restrictions">restrictions</a>:
            1. Send message received from a [Listener](#rtt_role_listener) but there is no [Subscriber](#rtt_role_subscriber) - drop it.
            2. Register message received from a [Subscriber](#rtt_role_subscriber) but there is no [Listener](#rtt_role_listener) - drop it.
            3. Send or Register message received, that targets some [rtt tag](#rtt_tag) served by other connections - drop this message. 
9. Flows:
   1. Happy path:
      1. <a id="hs1">HS1</a>: [Listener](#rtt_role_listener) -> SS: connect, assign connection id, create connection record.
      2. <a id="hs2">HS2</a>: [Listener](#rtt_role_listener) -> SS: send Register message, create routing record.
      3. <a id="hs3">HS3</a>: [Subscriber](#rtt_role_subscriber) -> SS: connect, assign connection id, create conenction record
      4. <a id="hs4">HS4</a>: [Subscriber](#rtt_role_subscriber) -> SS: 
         * receive Send message, 
         * use routing table to find destination routing record
         * add [subscriber](#rtt_role_subscriber) to the destination routng record
         * send data to the associated [Listener](#rtt_role_listener)
      5. <a id="hs5">HS5</a>: [Listener](#rtt_role_listener) -> SS: receive Reply message and route it to the [Subscriber](#rtt_role_subscriber), if any.
   2. Unhappy paths:
        1. [Listener](#rtt_role_listener) disconnects at [HS1](#hs1):
           1. [Subscriber](#rtt_role_subscriber) connects - no [Listener](#rtt_role_listener) records - [Subscriber](#rtt_role_subscriber) keeps hanging at step 3 and all his forwarding requests are dropped and rate limited.
             1. [Listener](#rtt_role_listener) connects - next attempt of 2.1.1 will proceed into the happy step 4.
        2. [Subscriber](#rtt_role_subscriber) disconnects at [HS4](#hs4)
        The record gets removed
         1. [Subscriber](#rtt_role_subscriber) reconnects before hs5 happens - the record gets restored and things get back to waiting for [HS5](#hs5).
         2. [Subscriber](#rtt_role_subscriber) reconnects after [HS5](#hs5) - do nothing, if [Subscriber](#rtt_role_subscriber) misses the message it can handle it in later exchanes with the [Listener](#rtt_role_listener).
      3. [Listener](#rtt_role_listener) sends [register mesasge](#message_register) at stages after [HS2](#hs2) - ignore this message. If the [RT](#rtt_tag) needs change, new connection should be established.
      4. [Listener](#rtt_role_listener) sends [send message](#message_send) before [HS4](#hs4) - there is nobody to send it to, just ignore the message. Let this be handled at the exchange layer.
      5. [Listener](#rtt_role_listener) sends [send message](#message_send) with a wrong [RT](#rtt_tag) - not the tag that is assigned to this conenction - ignore this message ([checked](#guardrail_check_rt_source)).
      6. [Listener](#rtt_role_listener) sends [send message](#message_send) before [HS2](#hs2) - then it will be recorded as a [Subscriber](#rtt_role_subscriber) and actual [subscriber](#rtt_role_subscriber) message at [HS4](#hs4) will get ignored. The users of SS should handle this. Not a vulnerability because this case is about genuine service.
         1. If then a correct [register message](#message_register) sent, it is also ignored since a single connection can only have one [rtt role](#rtt_roles)

11. Security:
    1. The [Note](#note1) suggests anyone can impersonate a server and deny the real server a chance to connect. And also provide malicious data to any [Subscriber](#rtt_role_subscriber).
       1. RT size and the fact and the connection flow nature makes RT fishing long and unpredicteable.
       2. Can be addressed by an heuristic checking that [HS2](#hs2), [HS4](#hs4) sequence took place and the [HS2](#hs2) was denied because of potential [Listener takeover](#note1), but it is out of scope for now.
       3. It is easy to detect in logging. Which is to be implemented.
    2. The [Client takeover](#Note3) is handled ih the same manner as the [Server takeover](#note1)
12. Guardrails:
    1. Rate limiting:
       1. <a id = "idle_connections">Port exchaustion</a>: To prevent malicious actors taking over all the ports, connections will be dropped if no message arrives after 5 seconds the connection was established. 
       2. To limit number of cases blocked by [message restrictions](#message_restrictions), rate limiting should be implemented - only limited number of messages should be handled from a single conenction in na time window.
    1. <a id = "timeout_incomplete_rtts">RTT timeouts</a>: Stale [rtt records](#rtt_records) should have both connections dropped - staleness is defined by lack of messages going back and forth over a time interval. It should be something reasonable which would allow for a lengthy message processing by participants.
    3. <a id= "guardrail_check_rt_source">Check RT in Send</a> message - make sure the connected connection belonging to an [rtt record](#rtt_records) only send [messages](#message_type) containing same [RT](#rtt_tag)
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