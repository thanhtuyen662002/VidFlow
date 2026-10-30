import { writeFile, rename } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FlowJobDriver } from '../jobDriver.ts';
import type { FlowPage } from '../driver.ts';
import { flowDriver } from '../driver.ts';
import { resolveInside } from '../../paths.ts';

/** Test-only adapter for the existing M5 fake service and guarded driver. */
export function createFakeJobDriver(db: DatabaseSync, options: { failGeneration?: (jobId: string, takeIndex: number) => boolean } = {}): FlowJobDriver {
  return { async run(job, account, context) {
    const { startFakeFlow } = await import('./index.ts');
    const delayMs = Number(process.env.VIDFLOW_FAKE_DELAY_MS ?? 200);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs >= context.timeoutMs) throw new Error('Invalid fake delay');
    const service = await startFakeFlow({ delayMs, onGenerate() {
      db.prepare('INSERT INTO flow_fake_requests(job_id,created_at) VALUES (?,?)').run(job.id, new Date().toISOString());
    } });
    const timeout = AbortSignal.timeout(context.timeoutMs);
    let cookie = '', prompt = '', remoteId = '', credits = 100;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(service.url + path, { signal: timeout, redirect: 'manual',
        method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return response;
    };
    const page: FlowPage = {
      async goto() { const response = await request('/login', {}); cookie = response.headers.get('set-cookie')!.split(';')[0]; },
      async fill(value) { prompt = value; },
      async upload() {}, async guard() {}, async credits() { return credits; },
      async click() {
        const result = await (await request('/api/generate', { prompt })).json(); remoteId = result.id; credits = result.credits;
        if (options.failGeneration?.(job.id, JSON.parse(job.payload).takeIndex ?? 0)) throw new Error('Injected fake generation timeout');
      },
      async text(name) {
        if (name !== 'downloadButton') return '';
        const result = await (await request('/api/jobs/' + remoteId)).json();
        return result.status === 'done' ? 'Download' : '';
      },
      async download(directory, input) {
        const bytes = Buffer.from(await (await request(`/media/${remoteId}.mp4`)).arrayBuffer());
        const file = resolveInside(directory, `${input.id}_${input.takeIndex ?? 0}.mp4`);
        await writeFile(file + '.partial', bytes, { flag: 'wx' }); await rename(file + '.partial', file); return file;
      },
    };
    try {
      const payload = JSON.parse(job.payload);
      const result = await flowDriver.runJob({ ...payload, id: job.id, projectId: job.project_id!, accountId: account.id },
        { db, page, browser: undefined as never, url: service.url, timeoutMs: context.timeoutMs });
      if (result.kind !== 'completed') throw new Error('Fake Flow: ' + result.kind);
      return { kind: 'success', media: result.files.map(path => ({ path, kind: 'video', bytes: 1 })) };
    } finally { await service.close(); }
  } };
}
