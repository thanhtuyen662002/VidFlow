import { statSync } from 'node:fs';
import type { FlowJobDriver } from './jobDriver.ts';
import type { FlowDriverContext, FlowJob } from './driver.ts';
import { flowDriver } from './driver.ts';
import { redactString } from '../redact.ts';

/** The existing guarded Playwright driver is the page implementation. */
export function createPageDriver(context: (accountId: string) => Promise<FlowDriverContext>, close: (ctx: FlowDriverContext) => Promise<void> = async ctx => { await ctx.browser.close(); }): FlowJobDriver {
  return { async run(job, account, ctx) {
    let pageContext: FlowDriverContext | undefined;
    try {
      const payload = JSON.parse(job.payload) as Partial<FlowJob>;
      if (typeof payload.prompt !== 'string' || typeof payload.outputDir !== 'string' || typeof (job.project_id ?? payload.projectId) !== 'string') throw new Error('Invalid job');
      pageContext = await context(account.id);
      const result = await flowDriver.runJob({ ...payload, id: job.id, accountId: account.id, projectId: job.project_id ?? payload.projectId!, prompt: payload.prompt, outputDir: payload.outputDir }, { ...pageContext, timeoutMs: ctx.timeoutMs });
      switch (result.kind) {
        case 'completed': return { kind: 'success', media: result.files.map(path => {
          const file = statSync(path);
          const kind = /\.(png|jpe?g|webp)$/i.test(path) ? 'image' as const : /\.(mp4|webm|mov)$/i.test(path) ? 'video' as const : undefined;
          const expected = (payload as { kind?: string }).kind ?? 'video';
          if (!file.isFile() || !file.size || !kind || kind !== expected) throw new Error('Invalid media');
          return { path, kind, bytes: file.size };
        }) };
        case 'out_of_credits': return { kind: 'out_of_credit' };
        case 'rejected': return { kind: 'refused', reason: redactString(result.reason) };
        case 'verification_required': return { kind: 'verification_required' };
        case 'failed': return { kind: 'transient_error', message: redactString(result.error) };
      }
    } catch { return { kind: 'transient_error', message: 'Không thể chạy Flow; kiểm tra cấu hình và selector' }; }
    finally { try { if (pageContext) await close(pageContext); } catch { /* Never log browser diagnostics. */ } }
  } };
}
