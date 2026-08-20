import { initDb, Test1, Test2 } from './testTrackGet';

console.log("Starting DB tests...");
// (window as any).__TRANSPORT__ = 'ws';

try {
    await Test1();
} catch (e) {
    console.error(`Test1 failed: ${e}`);
    throw e;
}
