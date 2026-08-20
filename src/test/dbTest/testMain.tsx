import { initDb, Test1, Test2 } from './testTrackGet';

console.log("Starting DB tests...");
(window as any).__TRANSPORT__ = 'ws';

Test1();
// initDb();
