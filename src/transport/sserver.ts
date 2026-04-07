/**
 * Signalling Server (SS) for ICE/WebRTC SDP exchange.
 *
 * Two peer roles:
 *   server – the WebRTC answerer.  Connects first, registers a token.
 *   client – the WebRTC offerer.   Connects later, references the token.
 *
 * Protocol (all messages are JSON):
 *
 *   server → SS  { type: 'register', token: string }
 *   SS → server  { type: 'registered' }              on success
 *                { type: 'error', code, message }    on failure
 *
 *   client → SS  { type: 'offer', token: string, sdp: string }
 *   SS → client  { type: 'ok' }                      offer forwarded
 *                { type: 'error', code, message }    on failure
 *
 *   SS → server  { type: 'offer', peerId: string, sdp: string }
 *
 *   server → SS  { type: 'answer', peerId: string, sdp: string }
 *   SS → client  { type: 'answer', sdp: string }
 *
 * Error codes:  NO_SERVER | SERVER_UNREACHABLE | TOKEN_TAKEN | PARSE_ERROR
 *
 * Environment variables:
 *   SS_PORT  – listening port (default 8443)
 *   SS_CERT  – path to TLS certificate file (enables WSS)
 *   SS_KEY   – path to TLS private key file  (enables WSS)
 */

import { WebSocketServer, WebSocket } from 'ws';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';

// ============================================================
// Protocol types
// ============================================================

type ErrorCode = 'NO_SERVER' | 'SERVER_UNREACHABLE' | 'TOKEN_TAKEN' | 'PARSE_ERROR';

/** Incoming messages a WebRTC server peer may send. */
type ServerInMsg =
    | { type: 'answer'; peerId: string; sdp: string };

/** Incoming messages a WebRTC client peer may send (after the first offer). */
type ClientInMsg =
    | { type: 'offer'; token: string; sdp: string };

/** Any outbound message SS sends to a connected peer. */
type OutMsg =
    | { type: 'registered' }
    | { type: 'ok' }
    | { type: 'error'; code: ErrorCode; message: string }
    | { type: 'offer'; peerId: string; sdp: string }
    | { type: 'answer'; sdp: string };

// ============================================================
// Session
// ============================================================

interface ServerSession {
    id: string;
    token: string;
    ws: WebSocket;
}

interface ClientSession {
    id: string;
    ws: WebSocket;
}

// ============================================================
// SignallingServer – core matching / forwarding logic
// ============================================================

class SignallingServer {
    /** token → server session */
    private readonly servers = new Map<string, ServerSession>();
    /** peerId → client session */
    private readonly clients = new Map<string, ClientSession>();

    // ----------------------------------------------------------
    // Registration
    // ----------------------------------------------------------

    registerServer(ws: WebSocket, token: string): ServerSession | null {
        if (this.servers.has(token)) {
            this.send(ws, { type: 'error', code: 'TOKEN_TAKEN', message: `Token already registered` });
            return null;
        }
        const session: ServerSession = { id: crypto.randomUUID(), token, ws };
        this.servers.set(token, session);
        this.send(ws, { type: 'registered' });
        console.log(`[SS] Server registered  token=${token}`);
        return session;
    }

    registerClient(ws: WebSocket): ClientSession {
        const session: ClientSession = { id: crypto.randomUUID(), ws };
        this.clients.set(session.id, session);
        return session;
    }

    // ----------------------------------------------------------
    // Removal
    // ----------------------------------------------------------

    removeServer(session: ServerSession): void {
        this.servers.delete(session.token);
        console.log(`[SS] Server disconnected  token=${session.token}`);
    }

    removeClient(session: ClientSession): void {
        this.clients.delete(session.id);
    }

    // ----------------------------------------------------------
    // Message handling
    // ----------------------------------------------------------

    handleServerMsg(session: ServerSession, raw: string): void {
        const msg = this.parseMsg<ServerInMsg>(session.ws, raw);
        if (!msg) return;

        if (msg.type === 'answer') {
            this.forwardAnswerToClient(msg.peerId, msg.sdp);
        } else {
            this.send(session.ws, { type: 'error', code: 'PARSE_ERROR', message: 'Unknown message type' });
        }
    }

    handleClientMsg(session: ClientSession, raw: string): void {
        const msg = this.parseMsg<ClientInMsg>(session.ws, raw);
        if (!msg) return;

        if (msg.type === 'offer') {
            this.forwardOfferToServer(session, msg.token, msg.sdp);
        } else {
            this.send(session.ws, { type: 'error', code: 'PARSE_ERROR', message: 'Unknown message type' });
        }
    }

    // ----------------------------------------------------------
    // Forwarding
    // ----------------------------------------------------------

    private forwardOfferToServer(client: ClientSession, token: string, sdp: string): void {
        const server = this.servers.get(token);
        if (!server) {
            this.send(client.ws, {
                type: 'error', code: 'NO_SERVER',
                message: `No server registered with token: ${token}`
            });
            return;
        }

        const delivered = this.send(server.ws, { type: 'offer', peerId: client.id, sdp });
        if (!delivered) {
            this.send(client.ws, {
                type: 'error', code: 'SERVER_UNREACHABLE',
                message: 'Failed to deliver offer to server'
            });
            return;
        }

        this.send(client.ws, { type: 'ok' });
        console.log(`[SS] Offer forwarded  peerId=${client.id}  token=${token}`);
    }

    private forwardAnswerToClient(peerId: string, sdp: string): void {
        const client = this.clients.get(peerId);
        if (!client) {
            // Client already gone – nothing to do, don't notify server
            console.warn(`[SS] Answer for unknown/disconnected client  peerId=${peerId}`);
            return;
        }
        // Delivery failure is not signalled back to server (per spec)
        this.send(client.ws, { type: 'answer', sdp });
        console.log(`[SS] Answer forwarded  peerId=${peerId}`);
    }

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    private parseMsg<T>(ws: WebSocket, raw: string): T | null {
        try {
            return JSON.parse(raw) as T;
        } catch {
            this.send(ws, { type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' });
            return null;
        }
    }

    private send(ws: WebSocket, msg: OutMsg): boolean {
        if (ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(msg));
            return true;
        } catch {
            return false;
        }
    }
}

// ============================================================
// Per-connection state machine
// ============================================================

type PeerRole = 'unknown' | 'server' | 'client';

interface PeerConn {
    role: PeerRole;
    serverSession?: ServerSession;
    clientSession?: ClientSession;
}

function setupConnection(ws: WebSocket, ss: SignallingServer): void {
    const peer: PeerConn = { role: 'unknown' };

    ws.on('message', (data) => {
        const raw = data.toString();

        // Role is determined by the first message received.
        if (peer.role === 'unknown') {
            let msg: any;
            try { msg = JSON.parse(raw); } catch {
                ws.send(JSON.stringify({ type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' }));
                return;
            }

            if (msg.type === 'register' && typeof msg.token === 'string') {
                const session = ss.registerServer(ws, msg.token);
                if (session) {
                    peer.role = 'server';
                    peer.serverSession = session;
                }
                // On TOKEN_TAKEN the error is already sent; leave role as 'unknown'
                // so the peer can close / reconnect with a different token.
            } else if (msg.type === 'offer' && typeof msg.token === 'string' && typeof msg.sdp === 'string') {
                const session = ss.registerClient(ws);
                peer.role = 'client';
                peer.clientSession = session;
                // Process the offer immediately (raw already contains the full message).
                ss.handleClientMsg(session, raw);
            } else {
                ws.send(JSON.stringify({
                    type: 'error', code: 'PARSE_ERROR',
                    message: 'First message must be {"type":"register","token":...} (server) or {"type":"offer","token":...,"sdp":...} (client)'
                }));
            }
            return;
        }

        if (peer.role === 'server' && peer.serverSession) {
            ss.handleServerMsg(peer.serverSession, raw);
        } else if (peer.role === 'client' && peer.clientSession) {
            ss.handleClientMsg(peer.clientSession, raw);
        }
    });

    ws.on('close', () => {
        if (peer.role === 'server' && peer.serverSession) {
            ss.removeServer(peer.serverSession);
        } else if (peer.role === 'client' && peer.clientSession) {
            ss.removeClient(peer.clientSession);
        }
    });

    ws.on('error', (err) => {
        console.error('[SS] WebSocket error:', err.message);
    });
}

// ============================================================
// Entry point
// ============================================================

const PORT      = parseInt(process.env['SS_PORT'] ?? '8443', 10);
const CERT_FILE = process.env['SS_CERT'] ?? '';
const KEY_FILE  = process.env['SS_KEY']  ?? '';

const ss = new SignallingServer();
let wss: WebSocketServer;

if (CERT_FILE && KEY_FILE) {
    const server = https.createServer({
        cert: fs.readFileSync(CERT_FILE),
        key:  fs.readFileSync(KEY_FILE),
    });
    wss = new WebSocketServer({ server });
    server.listen(PORT, () =>
        console.log(`[SS] WSS signalling server listening on wss://0.0.0.0:${PORT}`)
    );
} else {
    wss = new WebSocketServer({ port: PORT });
    console.log(`[SS] WS signalling server listening on ws://0.0.0.0:${PORT}  (set SS_CERT + SS_KEY for WSS)`);
}

wss.on('connection', (ws) => {
    console.log('[SS] New connection');
    setupConnection(ws, ss);
});

wss.on('error', (err) => {
    console.error('[SS] Server error:', err);
});
