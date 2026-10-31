import type { DatabaseSync } from 'node:sqlite';
import { editVideo, generateFrameImage, launchFlowContext } from '../flow/driver.ts';
import type { MotionDependencies } from './render.ts';

export function browserMotion(db: DatabaseSync): Omit<MotionDependencies, 'db' | 'style'> {
  // Coordinator requests a synchronous context. The two overrides below own
  // asynchronous browser acquisition and supply the actual driver context.
  const context: MotionDependencies['context'] = () => ({ db, timeoutMs: 120000 } as ReturnType<MotionDependencies['context']>);
  return { context,
    edit: async job => {
      const browser = await launchFlowContext(job.accountId);
      try { return await editVideo(job, { db, browser, url: 'https://labs.google/fx/tools/flow', timeoutMs: 120000 }); }
      finally { await browser.close(); }
    },
    image: async job => {
      const browser = await launchFlowContext(job.accountId);
      try { return await generateFrameImage(job, { db, browser, url: 'https://labs.google/fx/tools/flow', timeoutMs: 120000 }); }
      finally { await browser.close(); }
    },
  };
}
