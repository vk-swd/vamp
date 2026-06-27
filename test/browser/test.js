import puppeteer from 'puppeteer';


const COTURN_IP = process.env.COTURN_IP;
const COTURN_PORT = process.env.COTURN_PORT;
const WS_URL = process.env.WS_URL;
const STUN_CREDENTIALS = process.env.STUN_CREDENTIALS;
const env = { COTURN_IP, COTURN_PORT, WS_URL, STUN_CREDENTIALS };
const browser = await puppeteer.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
    ],
});

const page = await browser.newPage();

page.on('console', msg => console.log('[PAGE]', msg.text()));
page.on('pageerror', err => console.error('[PAGE ERROR]', err.message));

await page.setContent('<html><body></body></html>');

try {
    await page.addScriptTag({ path: '/browser/commands.js' });
    const result = await page.evaluate(async (env) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30000); // Abort after 30 seconds
        // testfunc(env);
        const { pc1, dc } = await setUpIceConnection(env, ac);
        // const expectedMessage = 'Hello from pc1!';
        // return new Promise((resolve, reject) => {
        //     dc.onmessage = (event) => {
        //         if (expectedMessage === event.data) {
        //             resolve('DataChannel message received successfully');
        //         } else {
        //             reject(`Unexpected message received: ${event.data}`);
        //         }
        //     };
        //     dc.send(expectedMessage);
        // });
    }, env);

    console.log('[RESULT]', result);
} catch (err) {
    console.error('[ERROR]', err);
}
await browser.close();
