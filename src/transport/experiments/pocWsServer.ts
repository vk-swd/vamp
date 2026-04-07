import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { AssetKind, AssetMessage } from './types.js';


const PORT = parseInt(process.env.PORT ?? '8080', 10);

function getDataToSend(path: string, kind: AssetKind): string {
    if (!existsSync(path)) {
        console.error(`Error: File "${path}" does not exist.`);
        process.exit(1);
    }
    const msg: AssetMessage = { kind, data: '' };
    try {
        msg.data = readFileSync(path).toString('base64');
    } catch (err) {
        console.error(`Error: Could not read file "${path}":`, err);
        process.exit(1);
    }
    return JSON.stringify(msg);
}
const getEnv = (vName: string) => {
    const val = process.env[vName];
    if (!val) {
        console.error(`Error: ${vName} environment variable is not set.`);
        process.exit(1);
    }
    return val;
}
// const STYLE_PATH = getEnv('STYLE_PATH');
// const styleData = getDataToSend(STYLE_PATH, 'style');
const SCRIPT_PATH = getEnv('SCRIPT_PATH');
const scriptData = getDataToSend(SCRIPT_PATH, 'script');

const httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket, req) => {
    const clientAddr = req.socket.remoteAddress;
    console.log(`Client connected: ${clientAddr}`);
    for (const [kind, data] of [
        // ['style', styleData], 
        ['script', scriptData]] as const) {
        ws.send(data, (err) => {
            if (err) {
                console.error(`Failed to send ${kind} to ${clientAddr}:`, err);
            } else {
                console.log(`Sent ${kind} to ${clientAddr}`);
            }
        });
    }

    ws.on('close', () => {
        console.log(`Client disconnected: ${clientAddr}`);
    });
});

httpServer.listen(PORT, () => {
    console.log(`WebSocket server listening on ws://localhost:${PORT}`);
    console.log(`Serving script: ${SCRIPT_PATH}`);
    // console.log(`Serving style: ${STYLE_PATH}`);
});
