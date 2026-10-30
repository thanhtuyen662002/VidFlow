import { parseArgs } from 'node:util';
import { loadSelectors } from './selectors.ts';
import { playwrightPageAdapter, runSelftest } from './selftest.ts';
import type { SelectorPage } from './selftest.ts';
import { redactString } from '../redact.ts';

type IO = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
// Supplying a page keeps command tests independent of Playwright and Chromium.
export async function runFlowSelftestCommand(args: string[], io: IO = process, page?: SelectorPage): Promise<number> {
  const destination = io;
  io = {
    stdout: { write: text => destination.stdout.write(redactString(text)) },
    stderr: { write: text => destination.stderr.write(redactString(text)) },
  };
  let cleanup: (() => Promise<unknown>) | undefined;
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      profile: { type: 'string', default: 'mock' }, config: { type: 'string' }, url: { type: 'string' },
    } });
    if (positionals.length) throw new Error('flow selftest chỉ nhận --profile, --config, --url');
    if (values.profile !== 'mock' && values.profile !== 'real') throw new Error('Profile phải là mock hoặc real');
    const profile = values.profile;
    const selectors = loadSelectors(values.config, profile);
    const unfilled = Object.values(selectors).every(entry => !entry.selector.trim());
    if (profile === 'real' && unfilled) io.stdout.write('Chưa điền selector Flow thật\n');
    if (!page && !unfilled) {
      let url = values.url;
      if (profile === 'real') {
        if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Flow thật cần --url http(s) hợp lệ');
      } else if (url) throw new Error('--url chỉ dùng cho profile real');
      // No browser module is loaded for an entirely unfilled profile.
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true, timeout: 30000 });
      cleanup = () => browser.close();
      if (profile === 'mock') {
        const { startFakeFlow } = await import('./mock/index.ts');
        const mock = await startFakeFlow();
        cleanup = async () => { try { await browser.close(); } finally { await mock.close(); } };
        url = mock.url + '/selftest';
      }
      const browserPage = await browser.newPage();
      await browserPage.goto(url!, { timeout: 30000, waitUntil: 'domcontentloaded' });
      page = playwrightPageAdapter(browserPage);
    }
    const report = await runSelftest(page ?? { countSelector: async () => 0 }, profile, selectors);
    for (const result of report.results) io.stdout.write(result.message + '\n');
    io.stdout.write(report.ok ? 'Selftest đạt\n' : 'Selftest chưa đạt: ' + report.results.filter(result => result.status !== 'dat').map(result => result.name).join(', ') + '\n');
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write('vidflow: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  } finally { await cleanup?.(); }
}
