import { writeFileSync } from 'node:fs';
import { getRunEvidenceDir, getScreenshotsDir, resolveInside } from '../paths.ts';
import { redactHeaders, redactObject, redactString, redactUrl } from '../redact.ts';

function save(runId: string, name: string, extension: string, data: string | Uint8Array): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('Invalid evidence name');
  const filename = resolveInside(getRunEvidenceDir(runId), `${name}.${extension}`);
  writeFileSync(filename, data, { mode: 0o600 });
  return filename;
}
export function saveHtml(runId: string, name: string, html: string): string {
  // Remove values before text filtering, including unquoted attributes and either attribute order.
  const clean = html.replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag =>
    /\btype\s*=\s*(?:"(?:password|hidden)"|'(?:password|hidden)'|(?:password|hidden)\b)/i.test(tag)
      ? tag.replace(/\s+value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '') : tag);
  return save(runId, name, 'html', redactString(clean));
}
export function saveNetworkLog(runId: string, entries: unknown): string {
  // Bodies are omitted recursively, including HAR response.content.text.
  const filtered = redactObject(entries);
  function omitBodies(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(omitBodies);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (/^(body|responseBody|text)$/i.test(key)) continue;
      if (/^headers$/i.test(key)) result[key] = Array.isArray(item) ? redactObject(item) : redactHeaders(item);
      else if (/^url$/i.test(key) && typeof item === 'string') result[key] = redactUrl(item);
      else result[key] = omitBodies(item);
    }
    return result;
  }
  return save(runId, 'network', 'json', JSON.stringify(omitBodies(filtered), null, 2));
}
/** Login pages default to skipping. To mask, provide bytes captured with Playwright's mask option. */
export function saveScreenshot(runId: string, name: string, buffer: Uint8Array,
  options: { loginPage?: boolean; maskedBuffer?: Uint8Array } = {}): string | undefined {
  if (options.loginPage && !options.maskedBuffer) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('Invalid screenshot name');
  const filename = resolveInside(getScreenshotsDir(runId), `${name}.png`);
  writeFileSync(filename, options.maskedBuffer ?? buffer, { mode: 0o600 });
  return filename;
}
export function saveNote(runId: string, text: string): string {
  return save(runId, 'note', 'txt', redactString(text));
}
