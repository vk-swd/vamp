import { invoke } from '@tauri-apps/api/core';
export { invoke };

export function callInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const action = typeof args?.kind === 'string' ? ` (${args.kind})` : '';
  return invoke<T>(cmd, {cmd: args}).catch((error: unknown) => {
    console.error(`Error calling invoke: ${cmd}${action}`, error);
    throw error;
  });
}
