export { getApi as getClient } from '../api.ts';
import { getApi } from '../api.ts';
export function motionStyleReference(projectId: string, style: string) {
  return getApi().bible.update(projectId, { style });
}
export async function motionCall(action: string, input: Record<string, unknown>): Promise<any> {
  const api = (window as any).vidflow;
  if (!api?.motion?.[action]) throw new Error('Chưa kết nối công cụ chuyển động');
  return api.motion[action](input);
}
