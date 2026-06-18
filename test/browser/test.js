import puppeteer from 'puppeteer';

const COTURN_IP = process.env.COTURN_IP;
const COTURN_PORT = process.env.COTURN_PORT;
const STUN_CREDENTIALS = process.env.STUN_CREDENTIALS;
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


const result = await page.evaluate((COTURN_IP, COTURN_PORT, STUN_CREDENTIALS) => {
    return new Promise((resolve, reject) => {
        console.log('Starting WebRTC test', COTURN_IP, COTURN_PORT, STUN_CREDENTIALS);
         const iceConfig = {
            iceServers: [
                {
                    urls: `turn:${COTURN_IP}:${COTURN_PORT}`,
                    username: STUN_CREDENTIALS.split(':')[0],
                    credential: STUN_CREDENTIALS.split(':')[1],
                },
                {
                    urls: `stun:${COTURN_IP}:${COTURN_PORT}`,
                    username: STUN_CREDENTIALS.split(':')[0],
                    credential: STUN_CREDENTIALS.split(':')[1],
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
}, COTURN_IP, COTURN_PORT, STUN_CREDENTIALS);

console.log('[RESULT]', result);

await browser.close();
