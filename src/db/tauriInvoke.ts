import { invoke } from '@tauri-apps/api/core';
export { invoke };

export function callInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}
