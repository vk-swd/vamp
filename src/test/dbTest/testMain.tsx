import { initDb, Test1, Test2 } from './testTrackGet';
import { resetDatabase } from '../../db/tauriDb';
import { log } from '../../logger';

console.log("Starting DB tests...");
(window as any).__TRANSPORT__ = 'ws';

try {
    await Test1();
    log("Test1 succeeded for ws");
    (window as any).__TRANSPORT__ = 'tauri';
    await resetDatabase();
    await Test1();
    log("Test1 succeeded for tauri");
} catch (e) {
    log(`Test1 failed: ${e}`);
    throw e;
}
