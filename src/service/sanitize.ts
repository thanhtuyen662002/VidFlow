import { redactString } from '../redact.ts';
export const sensitiveKey = /cookie|token|authorization|password|secret|apikey/i;
/** Also scrub serialized JSON, since repository content/payload fields may contain JSON. */
export function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(sanitize(parsed, secrets)); } catch {}
    let text = redactString(value);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, sanitize(item, secrets)]));
  return value;
}
export function collectSecrets(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') collectSecrets(parsed, found); } catch {}
  } else if (Array.isArray(value)) value.forEach(item => collectSecrets(item, found));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && typeof item === 'string' && item) found.add(item);
    collectSecrets(item, found);
  }
  return found;
}
