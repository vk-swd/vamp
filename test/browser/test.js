import puppeteer from 'puppeteer';

const SIG_URL = 'ws://vps_front:9000';
const TURN_HOST = 'vps_front';
const TURN_PORT = 9001;
const CLIENT_ID = 'browser-test-client';
const SERVER_ID = 'browser-test-server';

const browser = await puppeteer.launch({
    // browser: 'chrome',
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


const result = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
        console.log('Starting WebRTC test');
         const iceConfig = {
            iceServers: [
                {
                    urls: `turns:host1:9011`,
                    username: 'username1',
                    credential: 'pass1',
                },
                {
                    urls: `stun:host1:9011`,
                    username: 'username1',
                    credential: 'pass1',
                },
            ],
        };
        function logIce(hh, ...message) {
            console.log(hh, ...message);
        }
        const pc1 = new RTCPeerConnection(iceConfig);

        pc1.createDataChannel("probe");
        pc1.onicecandidate = (e) => {
            if (e.candidate) {
                console.log('iceLog1', e.candidate.type + ' - ' + (e.candidate.address || 'hidden'));
            } else {
                logIce('iceLog1', 'ICE gathering complete');
                resolve('Test complete');
            }
        };

        pc1.oniceconnectionstatechange = () => {
            logIce('iceLog1', 'ICE state: ' + pc1.iceConnectionState);
        };

        pc1.onicegatheringstatechange = () => {
            logIce('iceLog1', 'Gathering: ' + pc1.iceGatheringState);
        };
        pc1.onerror = (err) => {
            reject(`PeerConnection error: ${err}`);
        }

        pc1.createOffer()
            .then(offer => pc1.setLocalDescription(offer))
    })
})

console.log('[RESULT]', result);

await browser.close();
