export interface RenderProgress {
  jobId: string; shotId?: string; chainId?: string; take?: number;
  status: string; percent?: number; message?: string; timestamp: string;
}
export interface ProgressSource { onRenderProgress(callback: (payload: RenderProgress) => void): () => void }
export function createProgressSource() {
  const listeners = new Set<(payload: RenderProgress) => void>();
  return {
    onRenderProgress(callback: (payload: RenderProgress) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    emit(payload: RenderProgress) { for (const callback of listeners) { try { callback(payload); } catch { /* Observers cannot interrupt rendering. */ } } },
  };
}
