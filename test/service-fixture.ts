import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createCoreService } from '../src/service/index.ts';
import type { ServiceDependencies } from '../src/service/index.ts';
import type { TestContext } from 'node:test';

const scenes = [1, 2].map(sceneIndex => ({ sceneIndex, durationSec: 3, description: '@Lan walks through a garden with Mickey Mouse', dialogue: [] }));
export function setup(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const promptsDir = join(process.env.VIDFLOW_HOME!, 'prompts'); mkdirSync(promptsDir);
  for (const name of ['script-writer','script-editor']) writeFileSync(join(promptsDir, `${name}.system.md`), name);
  const deps: ServiceDependencies = {
    db, promptsDir, sensitiveValues: ['SECRET_COOKIE_VALUE','SECRET_TOKEN_VALUE'],
    llm: { async complete(request) {
      if (!request.system) return { text: JSON.stringify({ title: 'Garden', description: 'Walk', hashtags: ['#garden'] }), raw: { token: 'SECRET_TOKEN_VALUE' } };
      if (request.system === 'script-editor') return { text: JSON.stringify({ score: 9, comment: 'Good', issues: [] }) };
      const input = JSON.parse(request.prompt);
      return { text: JSON.stringify(input.count ? { variants: Array.from({ length: input.count }, () => ({ scenes })) } : { scenes }) };
    } },
    flowDriver: { async run(job) {
      const payload = JSON.parse(job.payload); mkdirSync(payload.outputDir, { recursive: true });
      const path = join(payload.outputDir, 'video.mp4'); writeFileSync(path, 'fake video');
      return { kind: 'success', media: [{ kind: 'video', path, bytes: 10 }], cookie: 'SECRET_COOKIE_VALUE', token: 'SECRET_TOKEN_VALUE' };
    } },
    duration: async () => 8,
    reviewer: { async review(_scene, takes) { return { takeId: takes[0].id, inPoint: 0, outPoint: 3, reason: 'Good' }; } },
    clock: () => new Date('2026-10-30T00:00:00Z'),
    media: {
      async exportFinal(timeline, options) {
        const path = join(options.projectDir, 'exports', `${timeline.id}.mp4`); writeFileSync(path, 'assembled');
        return { path, srtPath: path + '.srt', width: 1920, height: 1080, loudness: { integratedLufs: -14, truePeak: -1 }, capcutDraft: { ok: true, path: 'draft' }, warnings: [] };
      },
      async mix(_db, _projectId, _input, path) { writeFileSync(path, 'audio'); return { path, loudness: null }; },
    },
  };
  return { db, deps, service: createCoreService(deps) };
}
