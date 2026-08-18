



function logIce(hh, ...message) {
    const formattedNow = new Date().toISOString();
    console.log(`[${formattedNow}] ${hh}`, ...message);
}



async function sendOfferGetAnswer(sdp, tag, ac, WS_URL) {
    const MAX_CONNECT_ATTEMPTS = 5;
    const CONNECT_RETRY_DELAY_MS = 500;
    return new Promise((resolve, reject) => {
        const offerMsg = JSON.stringify({ tag, payload: sdp });
        let repeat_offer_send_to = null;
        let retry_connect_to = null;
        let ws = null;
        let connectAttempt = 0;
        let opened = false;
        const killSend = () => {
            if (repeat_offer_send_to) {
                clearTimeout(repeat_offer_send_to);
                repeat_offer_send_to = null;
            }
        }
        const killRetry = () => {
            if (retry_connect_to) {
                clearTimeout(retry_connect_to);
                retry_connect_to = null;
            }
        }
        ac.signal.addEventListener('abort', () => {
            killSend();
            killRetry();
            reject('WebSocket connection aborted');
            if (ws) ws.close();
        });
        const res = (data) => {
            killSend();
            killRetry();
            resolve(data)
            ws.close();
        }
        const rej = (err) => {
            killSend();
            killRetry();
            reject(err);
            if (ws) ws.close();
        }
        const sendOffer = () => {
            logIce('log', `sending message: ${offerMsg}`)
            ws.send(offerMsg);
            repeat_offer_send_to = setTimeout(() => {
                sendOffer();
            }, 1000);
        }
        const connect = () => {
            connectAttempt++;
            ws = new WebSocket(WS_URL);
            ws.onopen = () => {
                opened = true;
                logIce('log', `opened ws`)
                sendOffer();
            };
            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data)
                    logIce('log', `received message: ${e.data}`)
                    if (msg.tag === tag && msg.payload) {
                        res(msg.payload);
                        return;
                    }
                } catch (err) {
                    rej(`Failed to parse message: ${err}`);
                }
            };
            ws.onerror = (err) => {
                // The error event is fired when a connection with a WebSocket has been closed due to an error
                logIce('log', `WebSocket error on attempt ${connectAttempt}: ${err}`);
            }
            ws.onclose = () => {
                if (opened) {
                    rej(new Error('WebSocket closed'));
                    return;
                }
                if (connectAttempt >= MAX_CONNECT_ATTEMPTS) {
                    rej(new Error(`Failed to connect to signalling server after ${MAX_CONNECT_ATTEMPTS} attempts`));
                    return;
                }
                logIce('log', `retrying signalling server connection (attempt ${connectAttempt + 1}/${MAX_CONNECT_ATTEMPTS})`);
                retry_connect_to = setTimeout(connect, CONNECT_RETRY_DELAY_MS);
            };
        }
        connect();
    });
}



function getDataChannel(iceConnection, dcName, ac) {
    return new Promise((resolve, reject) => {
        ac.signal.addEventListener('abort', () => {
            reject('DataChannel creation aborted');
        });
        const dc = iceConnection.createDataChannel(dcName);
        const dcClosed = waitForDataChannelClose(dc, ac);
        dc.onmessage = (event) => {
            logIce('log', `dc message received: ${event.data}`);
            if (event.data === 'hello') {
                dc.send('what is your name');
            }
        };
        dc.onopen = () => {
            resolve({ dc, dcClosed });
        };
        dc.onerror = (err) => {
            reject(`DataChannel error: ${err}`);
        };
    });
}
function setUpIceConnection(env, ac) {
    const { COTURN_IP, COTURN_PORT, STUN_CREDENTIALS, WS_URL, TAG } = env;
    return new Promise((resolve, reject) => {
        console.log('Starting WebRTC test', COTURN_IP, COTURN_PORT, STUN_CREDENTIALS);
         const iceConfig = {
            iceServers: [
                {
                    urls: `turn:${COTURN_IP}:${COTURN_PORT}`,
                    username: STUN_CREDENTIALS.split(':')[0],
                    credential: STUN_CREDENTIALS.split(':')[1],
                },
                {
                    urls: `stun:${COTURN_IP}:${COTURN_PORT}`,
                    username: STUN_CREDENTIALS.split(':')[0],
                    credential: STUN_CREDENTIALS.split(':')[1],
                },
            ],
        };
        const pc1 = new RTCPeerConnection(iceConfig);
        ac.signal.addEventListener('abort', () => {
            pc1.close();
            reject('ICE connection aborted');
        });

        pc1.onicecandidate = (e) => {
            if (e.candidate) {
                console.log('iceLog1', e.candidate.type + ' - ' + (e.candidate.address || 'hidden'));
            } else {
                logIce('iceLog1', 'ICE gathering complete');
                sendOfferGetAnswer(
                    pc1.localDescription.sdp, 
                    TAG,
                    ac,
                    WS_URL
                ).then(answerSdp => {
                    pc1.setRemoteDescription({ type: 'answer', sdp: answerSdp })
                        .then(() => {
                            logIce('iceLog1', 'Remote description set', answerSdp);
                        })
                        .catch(err => {
                            reject(`Failed to set remote description: ${err}`);
                        });
                }).catch(err => {
                    reject(`Failed to get answer: ${err}`);
                });
            }
        };
        pc1.oniceconnectionstatechange = () => {
            logIce('iceLog1', 'ICE state: ' + pc1.iceConnectionState);
        };
        pc1.onicecandidateerror = (e) => {
            logIce('iceLog1', 'ICE candidate error: ', e);
        }
        pc1.onicegatheringstatechange = () => {
            logIce('iceLog1', 'Gathering: ' + pc1.iceGatheringState);
        };
        pc1.onerror = (err) => {
            reject(`PeerConnection error: ${err}`);
        }
        const dc1 = getDataChannel(pc1, "probe", ac);
        pc1.createOffer()
            .then(offer => pc1.setLocalDescription(offer))
        return dc1.then(({ dc, dcClosed }) => {
            resolve({ pc1, dc, dcClosed });
        }).catch(err => {
            reject(`Failed to create DataChannel: ${err}`);
        });
    })
}
function waitForDataChannelClose(dc, ac) {
    return new Promise((resolve, reject) => {
        if (dc.readyState === 'closed') {
            resolve();
            return;
        }
        ac.signal.addEventListener('abort', () => {
            reject('DataChannel close wait aborted');
        });
        dc.addEventListener('close', () => {
            logIce('log', 'DataChannel closed');
            resolve();
        });
    });
}
function testfunc(env) {
    const { COTURN_IP, COTURN_PORT, STUN_CREDENTIALS } = env;
    console.log('Starting WebRTC test', COTURN_IP, COTURN_PORT, STUN_CREDENTIALS);
}
