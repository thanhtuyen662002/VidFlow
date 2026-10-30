import { loadSelectors } from './selectors.ts';
import type { SelectorProfile, Selectors } from './selectors.ts';

export interface SelectorPage { countSelector(selector: string): Promise<number> }
export function playwrightPageAdapter(page: { locator(selector: string): { count(): Promise<number> } }): SelectorPage {
  return { countSelector: selector => page.locator(selector).count() };
}
export type SelectorResult = { name: string; selector: string; status: 'dat' | 'hong' | 'chua_dien'; message: string };
export async function runSelftest(page: SelectorPage, profile: SelectorProfile, selectors: Selectors = loadSelectors(undefined, profile)) {
  const results: SelectorResult[] = [];
  for (const [name, entry] of Object.entries(selectors)) {
    const selector = entry?.selector ?? '';
    if (!selector.trim()) {
      results.push({ name, selector, status: 'chua_dien', message: `Selector ${name} chưa điền (ghi chú: ${entry?.note ?? 'không có'})` });
      continue;
    }
    let count = 0;
    try { count = await page.countSelector(selector); } catch { /* Invalid CSS is a broken selector too. */ }
    results.push({ name, selector, status: count >= 1 ? 'dat' : 'hong', message: count >= 1 ? `Selector ${name} đạt` : `Selector ${name} hỏng: không tìm thấy phần tử` });
  }
  return { ok: results.length > 0 && results.every(result => result.status === 'dat'), results };
}
