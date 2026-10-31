import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('Windows package is an unsigned x64 NSIS installer with a narrow whitelist', () => {
  const yaml = read('config/electron-builder.yml');
  assert.match(yaml, /win:\s+target:\s+- target: nsis\s+arch:\s+- x64/);
  assert.match(yaml, /directories:\s+output:\s*\S+/);
  const files = yaml.split('files:')[1].split('\nwin:')[0];
  const entries = [...files.matchAll(/^\s+- ['"]?([^'"\r\n]+)['"]?\s*$/gm)].map(match => match[1]);
  assert.deepEqual(entries.filter(entry => !entry.startsWith('!')), [
    'package.json', 'renderer/dist/**/*', 'dist-electron/**/*',
  ]);
  for (const excluded of ['profiles/**', '**/profiles/**', 'test/**', 'tests/**', '**/*.test.*',
    '**/*.spec.*', 'data/**', 'userData/**', '**/data/**', '**/userData/**', '**/*.sqlite*',
    '**/*.db', '.env*', '**/.env*', 'docs/**', 'src/**']) {
    assert.ok(entries.includes(`!${excluded}`), `Missing exclusion: ${excluded}`);
  }
  assert.doesNotMatch(yaml, /^\s*(certificateFile|certificatePassword|sign|signingHashAlgorithms|azureSignOptions)\s*:/m);
  assert.match(yaml, /signExecutable: false/);
  assert.doesNotMatch(yaml, /signAndEditExecutable: false/); // That would also skip the icon.
  assert.match(yaml, /icon: build\/icon\.ico/);
  assert.match(yaml, /oneClick: true/);
  assert.match(yaml, /perMachine: false/);
  assert.match(yaml, /runAfterFinish: true/);
  // ffmpeg and the Playwright browsers ship beside the app, outside the asar whitelist.
  assert.match(yaml, /extraResources:\s+- from: vendor\/ffmpeg\s+to: ffmpeg\s+- from: vendor\/ms-playwright\s+to: ms-playwright/);
});

test('main bundle, preload and manifest paths agree', () => {
  const config = read('config/vite.main.config.ts');
  assert.match(config, /src\/app\/entry\.ts/);
  assert.match(config, /outDir: 'dist-electron'/);
  assert.match(config, /entryFileNames: 'main\.mjs'/);
  assert.match(config, /format: 'es'/);
  assert.match(config, /target: 'node24'/);
  assert.match(config, /copyFileSync\(new URL\('src\/app\/preload\.cjs', root\), new URL\('dist-electron\/preload\.cjs', root\)\)/);
  assert.match(config, /manifest\.dependencies/);
  assert.match(config, /id\.startsWith\('node:'\)/);
  assert.match(read('src/app/main.ts'), /new URL\('\.\/preload\.cjs', import\.meta\.url\)/);
  assert.match(read('vite.config.ts'), /root: 'renderer'/);
  assert.match(read('vite.config.ts'), /outDir: 'dist'/);
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.main, 'dist-electron/main.mjs');
  assert.equal(manifest.scripts['package:win'], 'npm run build && node config/vendor-tools.mjs && electron-builder --win nsis --x64 --config config/electron-builder.yml');
});
