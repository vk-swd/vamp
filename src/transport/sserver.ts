import { WebSocketServer, WebSocket } from 'ws';
import https from 'https';
import fs from 'fs';
// import crypto from 'crypto';
// crypto.randomUUID

enum OriginType {
    CLIENT = 'client',
    SERVER = 'server',
    ERROR = 'error',
}

type SSMsg = { originType: OriginType, src: string, dst: string, payload: string }
type WSNodeConfig = {
    port: number;
    certFile?: string;
    keyFile?: string;
};
const ROUTE_LIMIT = 2; //aka simultaniously connecting device limit
export class WSNode {
    // Server shares the token with the client offline (qr code, etc). 
    // Client connects with this code and looks for the server.
    // In this sequence the possible risks are:
    /**
     * 1. Someone presents themselves as server - it will get ignored by other clients - no token shared
     * 2. Someone spawns clients with differnt tokens (brute force) - good luck with that (rate limiting + complexity)
     * 3. Someone spawns many servers with different tokens to fish for clients:
     *  - If server with same token exists - it the bad actor will get kicked out
     *  - If server does not exist and later real server tries to register - it won't, so it will choose different token and share it with others. So no phishing here.
     * 4. DDOS with client connections - rate limit and accept the risk. No expensive task is performed upon connection anyway.
     * 5. DDOS with server connections - that potentially may leak memory since tokens should be tracked. Especially if the server expects a connection.
     *      I tried avoiding complex configuration like certificate configuring etc. so that the server is stateless.
     *      For limited individual use that whould be acceptable risk.
     * 6. Server is expected to service 1 device at the same time so the signalling session will get closed once a client is found.
     *      UPD - 
     * 7. Impersonating server does not make sense - 1 server per token and client will get wrong instance to connect to.
     */
    wss: WebSocketServer;
    socketId = 0;
    connections = new Map<number, { ws: WebSocket, localAddrs: Array<string>, remoteSockets: Array<number> }>();
    rTable = new Map<string, number>();
    private constructor(private config: WSNodeConfig) {
        if (config.certFile && config.keyFile) {
            const server = https.createServer({
                cert: fs.readFileSync(config.certFile),
                key:  fs.readFileSync(config.keyFile),
            });
            this.wss = new WebSocketServer({ server, maxPayload: 8192 });
            server.listen(config.port, () =>
                console.log(`[SS] WSS signalling server listening on wss://0.0.0.0:${config.port}`)
            );
        } else {
            this.wss = new WebSocketServer({ port: config.port, maxPayload: 8192 });
            console.log(`[SS] WS signalling server listening on ws://0.0.0.0:${config.port}  (set SS_CERT + SS_KEY for WSS)`);
        }

        this.wss.on('connection', (ws: WebSocket) => {
            console.log('[SS] New connection');
            const socketId = this.socketId++;
            this.connections.set(socketId, { ws, localAddrs: [], remoteSockets: [] });
            ws.onerror = (err) => {
                console.error('[SS] WebSocket error:', err.message);
            }
            ws.onmessage = (msg) => {
                if (!this.connections.has(socketId)) {
                    console.error('[SS] Failed to parse message: connection not found');
                    return;
                }
                let data: SSMsg;
                try {
                    data = JSON.parse(msg.data.toString()) as SSMsg;
                } catch (err) {
                    console.error('[SS] Failed to parse message:', err);
                    return;
                }
                if (this.rTable.has(data.src) && this.rTable.get(data.src) !== socketId) {
                    console.error('[SS] Source already registered from a different connection:', data.src);
                    ws.send(JSON.stringify({ src: OriginType.ERROR, msg: 'Source already registered from a different connection' }));
                    return;
                }
                if ((data.dst != data.src) && !this.rTable.has(data.dst)) {
                    console.error('[SS] Destination not found for message:', data.dst);
                    ws.send(JSON.stringify({ src: OriginType.ERROR, msg: 'Destination not found' }));
                    return;
                }
                const remoteInfo = this.connections.get(socketId)!
                // TODO - add dst limiting PER CONNECTION too.
                if (remoteInfo.localAddrs!.length > ROUTE_LIMIT) {
                    ws.send(JSON.stringify({ src: OriginType.ERROR, msg: 'too many refs, reset server registration' }));
                    return;
                }
                this.rTable.set(data.src, socketId);
                remoteInfo.localAddrs.push(data.src);
                const dstCon = this.connections.get(this.rTable.get(data.dst)!)
                if (data.dst == data.src) {
                    return;
                }
                if (!dstCon) {
                    console.error('[SS] Failed to find connection for destination:', data.dst);
                    ws.send(JSON.stringify({ src: OriginType.ERROR, msg: 'Failed to find connection for destination' }));
                    return;
                }
                dstCon.ws.send(msg.data, (err) => {
                    if (err) {
                        console.error('[SS] Failed to forward message:', err);
                        ws.send(JSON.stringify({ src: OriginType.ERROR, msg: 'Failed to forward message' }));
                    }
                });
            }
            ws.on('close', () => {
                console.log('[SS] Connection closed');
                const con = this.connections.get(socketId);
                if (con) {
                    for (const src of con.localAddrs) {
                        this.rTable.delete(src);
                    }
                    this.connections.delete(socketId);
                }
            });
        });
        this.wss.on('error', (err) => {
            console.error('[SS] Server error:', err);
        });
    }
}


