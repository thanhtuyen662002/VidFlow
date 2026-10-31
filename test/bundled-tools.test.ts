import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBundledTools } from '../src/app/bundled-tools.ts';
import config from '../config/vite.main.config.ts';

test('installed app uses the bundled ffmpeg and browsers unless the user set them', () => {
  const resources = join('C:', 'VidFlow', 'resources');
  const env: NodeJS.ProcessEnv = { VIDFLOW_FFPROBE: 'D:/own/ffprobe.exe' };
  useBundledTools(resources, env, () => true);
  assert.equal(env.VIDFLOW_FFMPEG, join(resources, 'ffmpeg', 'ffmpeg.exe'));
  assert.equal(env.VIDFLOW_FFPROBE, 'D:/own/ffprobe.exe');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(resources, 'ms-playwright'));
});

test('development run without bundled files keeps PATH and default browsers', () => {
  const env: NodeJS.ProcessEnv = {};
  useBundledTools(join('C:', 'electron', 'resources'), env, () => false);
  useBundledTools(undefined, env, () => true);
  assert.deepEqual(env, {});
});

test('main bundle keeps preload, selectors and prompts relative to dist-electron', () => {
  const plugin = (config.plugins ?? []).flat().find(p => p && typeof p === 'object' && 'name' in p && p.name === 'copy-sandbox-preload') as
    { enforce?: string; transform: (code: string, id: string) => string | undefined };
  assert.equal(plugin.enforce, 'pre');
  // Without this the main bundle reads {} instead of its environment (data folder, PATH, tool paths).
  assert.equal(config.define?.['process.env'], 'process.env');
  const cases: Array<[string, string]> = [
    ['src/app/main.ts', "new URL(/* @vite-ignore */ './preload.cjs'"],
    ['src/flow/selectors.ts', "new URL(/* @vite-ignore */ './assets/flow-selectors.json'"],
    ['src/script/prompts.ts', "new URL(/* @vite-ignore */ './assets/prompts/'"],
  ];
  for (const [file, expected] of cases) {
    const id = join(process.cwd(), file);
    const output = plugin.transform(readFileSync(id, 'utf8'), id);
    assert.ok(output?.includes(expected), `${file} resource URL was not rewritten`);
  }
});
