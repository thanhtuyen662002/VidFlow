import { existsSync } from 'node:fs';

export const BROWSER_SKIP_REASON = 'Bỏ qua: chưa cài Chromium của Playwright (đặt PLAYWRIGHT_BROWSERS_PATH hoặc chạy npx playwright install chromium)';
export async function resolveChromium(): Promise<string | undefined> {
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch { return undefined; }
}
export const browserAvailable = Boolean(await resolveChromium());
export async function launchHeadless() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    return { browser, context, page, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
