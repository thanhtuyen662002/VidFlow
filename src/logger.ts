import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataDirectory, resolveInside } from './paths.ts';
import { redactObject } from './redact.ts';

/** Synchronous writes: no pending records remain when close/flush returns. */
export function createLogger(options: { filename?: string; console?: boolean } = {}) {
  const filename = resolveInside(dataDirectory(), options.filename ?? 'logs/vidflow.log');
  function log(level: string, message: unknown, context?: unknown) {
    const line = JSON.stringify(redactObject({ level, message, context })) + '\n';
    mkdirSync(dirname(filename), { recursive: true });
    appendFileSync(filename, line, { encoding: 'utf8', mode: 0o600 });
    if (options.console) process.stderr.write(line);
  }
  return {
    log, info: (message: unknown, context?: unknown) => log('info', message, context),
    warn: (message: unknown, context?: unknown) => log('warn', message, context),
    error: (message: unknown, context?: unknown) => log('error', message, context),
    flush() {}, close() {},
  };
}
