

import { callInvoke } from "./db/tauriInvoke";

function log(message: string) {
    if (window.__TRANSPORT__ === 'ws') {
        if (message) {
        console.log(`WS log: ${message}`);
        } else {
        console.log(`WS log: (empty message)`);
        }
    } else {
        callInvoke("log_from_ui", { message: `${new Date().toISOString()}: ${message}` });
    }
}

export { log };