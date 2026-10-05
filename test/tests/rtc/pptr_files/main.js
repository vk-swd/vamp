import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const COTURN_IP = process.env.COTURN_IP;
const COTURN_PORT = process.env.COTURN_PORT;
const WS_URL = process.env.WS_URL;
const STUN_CREDENTIALS = process.env.STUN_CREDENTIALS;
const TAG = process.env.RTC_SESSION_ID;
const env = { COTURN_IP, COTURN_PORT, WS_URL, STUN_CREDENTIALS, TAG };
const browser = await puppeteer.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
    ],
});

const page = await browser.newPage();

page.on('console', (msg) => console.log('[PAGE]', msg.text()));
page.on('pageerror', (err) => console.error('[PAGE ERROR]', err.message));

await page.goto(pathToFileURL('/' + process.env.PUPPETEER_PAGE_NAME).href);

try {
    const result = await page.evaluate(async (env) => {
        console.log('Setting up tests with env:', env);
        return window.testFn(env, new AbortController());
    }, env);

    console.log('[RESULT]', result);
} catch (err) {
    console.error('[ERROR]', err);
    process.exitCode = 1;
}
await browser.close();
