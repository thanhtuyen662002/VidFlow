export const REDACTION_MASK = '[REDACTED]';
export const SENSITIVE_KEYS = Object.freeze([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key',
  'api_key', 'apikey', 'access_token', 'refresh_token', 'id_token', 'token',
  'auth', 'session', 'sessionid', 'sid', 'password', 'passwd', 'pwd', 'secret',
  'oauth', 'oauth_token', 'auth_token', 'session_id', 'session_token', 'csrf_token', 'xsrf-token',
  'client_secret', 'code', 'state', 'sig', 'signature', 'key', 'x-goog-*',
  'x-client-data', '__Secure-*', '__Host-*', 'SAPISID', 'APISID', 'HSID', 'SSID', 'NID',
]);
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.some(pattern => pattern.endsWith('*')
    ? key.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())
    : key.toLowerCase() === pattern.toLowerCase());
}
export function redactUrl(url: string): string {
  // Preserve spelling, escaping and order of all non-sensitive URL components.
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, key) => {
    let decoded: string;
    try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { decoded = key; }
    return isSensitiveKey(decoded) ? `${separator}${key}=${REDACTION_MASK}` : match;
  });
}
export function redactString(text: string): string {
  const keys = SENSITIVE_KEYS.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[\\w-]*')).join('|');
  const assignments = new RegExp(`(["']?)\\b(${keys})\\1(\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s&;,<>"'}]+)`, 'gi');
  return redactUrl(text)
    .replace(/\b((?:set-cookie|cookie|authorization|proxy-authorization)\s*:\s*)[^\r\n<]*/gi, `$1${REDACTION_MASK}`)
    .replace(/\b(Bearer|Basic|OAuth)\s+[^\s"'<>;,]+/gi, `$1 ${REDACTION_MASK}`)
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTION_MASK)
    .replace(/\bya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+/g, REDACTION_MASK)
    .replace(assignments,
      (match, quote, key, separator) => isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${REDACTION_MASK}` : match);
}
export function redactHeaders(headers: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  if (!headers || typeof headers !== 'object') return result;
  const iterable = headers as { entries?: () => Iterable<[string, unknown]> };
  const entries = typeof iterable.entries === 'function' ? iterable.entries() : Object.entries(headers);
  for (const [key, value] of entries) result[key] = isSensitiveKey(key) ? REDACTION_MASK : redactObject(value);
  return result;
}
export function redactCookies(cookies: unknown): unknown {
  return (redactObject({ cookies }) as Record<string, unknown>).cookies;
}
export function redactObject(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(item: unknown): unknown {
    if (typeof item === 'string') return redactString(item);
    if (typeof item === 'bigint') return String(item);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (item instanceof Error) return { name: redactString(item.name), message: redactString(item.message), stack: redactString(item.stack ?? ''), ...visit({ ...item }) as object };
    if (Array.isArray(item)) return item.map(visit);
    const result: Record<string, unknown> = Object.create(null);
    const entries = item instanceof Map ? item.entries() : Object.entries(item);
    for (const [rawKey, val] of entries) {
      const key = String(rawKey);
      result[key] = isSensitiveKey(key) || (key === 'value' && 'name' in item && isSensitiveKey(String(item.name))) ? REDACTION_MASK
        : /cookies$/i.test(key) ? visitCookies(val) : visit(val);
    }
    return result;
  }
  function visitCookies(cookies: unknown): unknown {
    if (!Array.isArray(cookies)) return REDACTION_MASK;
    if (seen.has(cookies)) return '[Circular]';
    seen.add(cookies);
    return cookies.map(cookie => {
      if (!cookie || typeof cookie !== 'object') return REDACTION_MASK;
      return { ...visit(cookie) as object, value: REDACTION_MASK };
    });
  }
  return visit(value);
}
