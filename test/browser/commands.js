



function logIce(hh, ...message) {
    const formattedNow = new Date().toISOString();
    console.log(`[${formattedNow}] ${hh}`, ...message);
}



async function sendOfferGetAnswer(sdp, src, dst, ac, WS_URL) {
    // Old artefact from page delivery tests
    // 1. Show cached version immediately (no blank flash)
    // const cached = localStorage.getItem(storageLocation);
    // if (cached != null && cached != undefined
    // //  && cached != "undefined"
    // ) {
    //     return cached
    // }
    return new Promise((resolve, reject) => {
        const requewstId = `${Date.now()}-${Math.random()}`;
        // 2. Connect and get fresh content
        const ws = new WebSocket(WS_URL);
        const offerMsg = JSON.stringify({ src, dst, payload: sdp });
        let repeat_offer_send_to = null;
        const killSend = () => {
            if (repeat_offer_send_to) {
                clearTimeout(repeat_offer_send_to);
                repeat_offer_send_to = null;
            }
        }
        ac.signal.addEventListener('abort', () => {
            killSend();
            reject('WebSocket connection aborted');
            ws.close();
        });
        const res = (data) => {
            killSend();
            resolve(data)
            ws.close();
        }
        const rej = (err) => {
            killSend();
            reject(err);
            ws.close();
        }
        const sendOffer = () => {
            logIce('log', `sending message: ${offerMsg}`)
            ws.send(offerMsg);
            repeat_offer_send_to = setTimeout(() => {
                sendOffer();
            }, 1000);
        }
        ws.onopen = () => {
            logIce('log', `opened ws`)
            sendOffer();
        };
        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data)
                logIce('log', `received message: ${e.data}`)
                if (msg.src == dst) {
                    res(msg.payload);
                    return;
                }
                rej(new Error(e.data));
            } catch (err) {
                rej(`Failed to parse message: ${err}`);
            }
        };
        ws.onerror = (err) => {
            // The error event is fired when a connection with a WebSocket has been closed due to an error
            rej(`WebSocket error: ${err}`);
        }
        ws.onclose = () => {
            rej(new Error('WebSocket closed'));
        };
    });
}


function getDataChannel(iceConnection, dcName, ac) {
    return new Promise((resolve, reject) => {
        ac.signal.addEventListener('abort', () => {
            reject('DataChannel creation aborted');
        });
        const dc = iceConnection.createDataChannel(dcName);
        dc.onopen = () => {
            resolve(dc);
        };
        dc.onerror = (err) => {
            reject(`DataChannel error: ${err}`);
        };
    });
}
function setUpIceConnection(env, ac) {
    const { COTURN_IP, COTURN_PORT, STUN_CREDENTIALS, WS_URL } = env;
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
                    'pc1', 
                    'pc2',
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
        return dc1.then(dc => {
            resolve({ pc1, dc });
        }).catch(err => {
            reject(`Failed to create DataChannel: ${err}`);
        });
    })
}
function testfunc(env) {
    const { COTURN_IP, COTURN_PORT, STUN_CREDENTIALS } = env;
    console.log('Starting WebRTC test', COTURN_IP, COTURN_PORT, STUN_CREDENTIALS);
}
