import { initDb, Test1, Test2 } from './testTrackGet';
import { resetDatabase } from '@ts-src/db/tauriDb';
import { log } from '@ts-src/logger';

console.log("Starting DB tests...");
// ipc://localhost/app_dispatch
log("Initializing database tests...");
(window as any).__TRANSPORT__ = 'ws';

try {
    // (window as any).__TRANSPORT__ = 'tauri';
    await Test1();
    log("Test1 succeeded for ws");
    await resetDatabase();
    await Test1();
    log("Test1 succeeded for tauri");
} catch (e) {
    log(`Test1 failed: ${e}`);
    throw e;
}
