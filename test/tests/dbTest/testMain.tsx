import { getWsClient } from '@ts-src/db/dispatchClient';
import { Test1 } from './testTrackGet';
import { BrowserTestEnv } from '../rtc/commands';

console.log("Starting DB tests...");
(window as any).__TRANSPORT__ = 'ws';


window.testFn = async (env: BrowserTestEnv, ac?: AbortController) => {
    try {
        await getWsClient(env.WS_URL);
        await Test1();
    } catch (e) {
        throw e;
    }
}