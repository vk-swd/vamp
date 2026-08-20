

import { callInvoke } from "./db/tauriInvoke";
import { dispatch } from "./db/dispatchClient";


function test_bcknd_sleep() {
    log(`test_bcknd_sleep() called`);
    return callInvoke("test_sleep");
}
function log(message: string) {
    const msg = `${new Date().toISOString()}: ${message}`
    if (window.__TRANSPORT__ === 'ws') {
        console.log(`WS log: ${msg}`);
    } else {
        dispatch("LogFromUi", { message: msg });
    }
}

window.onerror = (msg, src, line, col, err) => {
    log(`${ JSON.stringify({ type: 'error', msg, src, line, col, stack: err?.stack }) }`);
};

window.onunhandledrejection = (e) => {
    log(`${ JSON.stringify({ type: 'unhandledrejection', msg: e.reason?.message ?? e.reason, stack: e.reason?.stack }) }`);
};

export { log, test_bcknd_sleep };