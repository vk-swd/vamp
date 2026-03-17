

import { invoke } from "@tauri-apps/api/core";

function log(message: string) {
    invoke("log_from_ui", { message: `${new Date().toISOString()}: ${message}` });
}

export { log };