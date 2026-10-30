/** Filter diagnostics, including secrets supplied through an injected environment. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET/i.test(key) && value) text = text.split(value).join('[REDACTED]');
  }
  return text
    .replace(/((?:["']?)(?:api[_-]?key|[\w-]*token|secret|authorization|bearer|password|cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}/g, '[REDACTED]');
}
