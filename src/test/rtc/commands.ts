import { RtcConnector } from '/reference_files/src/transport/rtc-ts/connectors/rtc_connector';

type BrowserTestEnv = {
  COTURN_IP?: string;
  COTURN_PORT?: string;
  WS_URL: string;
  STUN_CREDENTIALS?: string;
  TAG: string;
};

type IceCredentials = {
  username: string;
  credential: string;
};

type RtcTestConnection = {
  connector: RtcConnector;
  dc: RTCDataChannel;
  dcClosed: Promise<void>;
};

function parseCredentials(value: string | undefined): IceCredentials | undefined {
  if (!value) {
    return undefined;
  }
  const [username, credential] = value.split(':');
  return { username, credential };
}

export function createIceServers(env: BrowserTestEnv): RTCIceServer[] {
  if (!env.COTURN_IP || !env.COTURN_PORT) {
    return [];
  }

  const credentials = parseCredentials(env.STUN_CREDENTIALS);
  const server: RTCIceServer = {
    urls: `turn:${env.COTURN_IP}:${env.COTURN_PORT}`,
  };

  if (credentials) {
    server.username = credentials.username;
    server.credential = credentials.credential;
  }

  return [server];
}

export async function setUpIceConnection(env?: BrowserTestEnv, ac?: AbortController): Promise<string> {
  
  console.log('setUpIceConnection with env:', JSON.stringify(env));
  return new Promise<string>(async (resolve, reject) => {
            const connector = new RtcConnector(
                env.TAG,
                'default',
                env.WS_URL,
                { iceServers: createIceServers(env) },
                (frame) => {
                    console.log('[rtc]', frame);
                    resolve(frame);
                },
            );
            setTimeout(() => {
                ac.abort();
                connector.close();
                reject('timeout');
            }, 30000);
            
            connector.startPeerConnection();
            while (!connector.isClosed()) {
              try {
                connector.send('test message');
                break;
              } catch (e) {
                console.error('Error sending message:', e);
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
        });
}

export {};

declare global {
  interface Window {
    setUpIceConnection: () => Promise<void>;
  }
}

window.setUpIceConnection = setUpIceConnection;
console.log('RTC test commands loaded');