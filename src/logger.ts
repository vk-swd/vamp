

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

window.onerror = (msg, src, line, col, err) => {
    log(`${ JSON.stringify({ type: 'error', msg, src, line, col, stack: err?.stack }) }`);
};

window.onunhandledrejection = (e) => {
    log(`${ JSON.stringify({ type: 'unhandledrejection', msg: e.reason?.message ?? e.reason, stack: e.reason?.stack }) }`);
};

export { log };