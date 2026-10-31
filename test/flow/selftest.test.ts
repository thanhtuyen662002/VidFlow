import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSelectors, defaultConfig, motionSelectorNames } from '../../src/flow/selectors.ts';
import { runSelftest, playwrightPageAdapter } from '../../src/flow/selftest.ts';
import { runFlowSelftestCommand } from '../../src/flow/cli.ts';
import { run } from '../../src/cli.ts';
import { startFakeFlow } from '../support/flow-fake/index.ts';
import { mediaHome } from '../helpers/media.ts';

async function fakePage(t: Parameters<typeof mediaHome>[0]) {
  const mock = await startFakeFlow();
  t.after(() => mock.close());
  const html = await (await fetch(mock.url + '/selftest')).text();
  const selectors = new Set([...html.matchAll(/data-testid="([^"]+)"/g)].map(match => `[data-testid="${match[1]}"]`));
  return { countSelector: async (selector: string) => selectors.has(selector) ? 1 : 0 };
}
function capture() {
  let output = '';
  const stream = { write: (text: string) => { output += text; } };
  return { io: { stdout: stream, stderr: stream }, output: () => output };
}

test('mock selectors match the existing mock DOM and CLI passes', async t => {
  mediaHome(t);
  const page = await fakePage(t);
  const report = await runSelftest(page, 'mock');
  assert.equal(report.ok, true);
  assert.ok(report.results.every(result => result.status === 'dat'));
  const log = capture();
  assert.equal(await runFlowSelftestCommand([], log.io, page), 0);
  assert.match(log.output(), /Selftest đạt/);
});

test('changing exactly one selector in the config identifies its name, including CLI', async t => {
  const home = mediaHome(t);
  const config = JSON.parse(readFileSync(defaultConfig, 'utf8'));
  config.mock.submitButton.selector = '[data-testid=khong-ton-tai]';
  const filename = join(home, 'selectors.json');
  writeFileSync(filename, JSON.stringify(config));
  const page = await fakePage(t);
  const report = await runSelftest(page, 'mock', loadSelectors(filename, 'mock'));
  assert.equal(report.ok, false);
  assert.deepEqual(report.results.filter(result => result.status === 'hong').map(result => result.name), ['submitButton']);
  const log = capture();
  assert.equal(await runFlowSelftestCommand(['--config', filename], log.io, page), 1);
  assert.match(log.output(), /Selector submitButton hỏng/);
});

test('real config reports every selector unfilled without opening a browser', async t => {
  mediaHome(t);
  const report = await runSelftest({ countSelector: async () => { throw new Error('must not count'); } }, 'real');
  assert.equal(report.ok, false);
  assert.ok(report.results.every(result => result.status === 'chua_dien' && result.message.includes('chưa điền')));
  const log = capture();
  assert.equal(await runFlowSelftestCommand(['--profile', 'real'], log.io), 1);
  assert.match(log.output(), /Chưa điền selector Flow thật/);
  for (const result of report.results) assert.ok(log.output().includes(result.name));
  const mainLog = capture();
  assert.equal(await run(['flow', 'selftest', '--profile', 'real'], mainLog.io), 1);
  assert.match(mainLog.output(), /Chưa điền selector Flow thật/);
});

test('loader rejects malformed JSON, missing fields and invalid entry types with key names', t => {
  const home = mediaHome(t);
  const filename = join(home, 'bad.json');
  writeFileSync(filename, '{');
  assert.throws(() => loadSelectors(filename), /JSON/);
  for (const entry of [{ note: 'missing selector' }, { selector: 4 }, null]) {
    const config = JSON.parse(readFileSync(defaultConfig, 'utf8'));
    config.mock.submitButton = entry;
    writeFileSync(filename, JSON.stringify(config));
    assert.throws(() => loadSelectors(filename), /mock.submitButton/);
  }
  assert.throws(() => loadSelectors(join(home, '..', 'outside.json')), /inside/);
});

test('selftest continues after invalid CSS and adapter delegates counts', async t => {
  mediaHome(t);
  const page = playwrightPageAdapter({ locator: selector => ({ count: async () => {
    if (selector === '[') throw new Error('invalid CSS');
    return 2;
  } }) });
  const report = await runSelftest(page, 'mock', { bad: { selector: '[' }, good: { selector: 'video' }, empty: { selector: ' ' } });
  assert.deepEqual(report.results.slice(0, 3).map(result => result.status), ['hong', 'dat', 'chua_dien']);
  assert.deepEqual(report.results.slice(3).map(result => result.name), motionSelectorNames);
  assert.ok(report.results.slice(3).every(result => result.status === 'chua_dien'));
  assert.equal(report.ok, false);
});
