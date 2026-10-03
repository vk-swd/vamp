import { invoke } from '@tauri-apps/api/core';
export { invoke };

export function callInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  
  console.log(`calling invoke: ${cmd} ${JSON.stringify(args)} ${new Error().stack}`);
  try {
    return invoke<T>(cmd, {cmd: args});
  } catch (error) {
    console.error(`Error calling invoke: ${cmd}`, error);
    return Promise.resolve<T>(undefined as unknown as T);
  }
}
