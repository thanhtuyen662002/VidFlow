/** Redact diagnostics before retaining or exposing them. */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|access_token|key|sig|signature|session)\s*=\s*[^\s&;"']+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s]+/gi, '$1<user>')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1<user>');
}
