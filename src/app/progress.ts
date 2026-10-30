import type { ProgressSource, RenderProgress } from '../service/progress.ts';

export function createProgressForwarder(source: ProgressSource, send: (channel: string, payload: RenderProgress) => void) {
  let active = true;
  const unsubscribe = source.onRenderProgress(raw => {
    if (!active || typeof raw.jobId !== 'string' || !raw.jobId ||
      !['running', 'completed', 'failed', 'needs_owner'].includes(raw.status) || !Number.isFinite(Date.parse(raw.timestamp))) return;
    const payload: RenderProgress = { jobId: raw.jobId, status: raw.status, timestamp: raw.timestamp };
    for (const key of ['shotId', 'chainId'] as const) if (typeof raw[key] === 'string') payload[key] = raw[key];
    if (Number.isSafeInteger(raw.take) && raw.take! > 0) payload.take = raw.take;
    if (typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 && raw.percent <= 100) payload.percent = raw.percent;
    // Arbitrary worker messages can contain credentials; expose only a fixed status message.
    payload.message = raw.status;
    send('render:progress', payload);
  });
  return () => { active = false; unsubscribe(); };
}
