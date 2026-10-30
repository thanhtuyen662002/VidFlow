import { spawn } from 'node:child_process';
import type { Completion, CompletionRequest, LlmClient } from './types.ts';
import { LlmCliError } from './errors.ts';
import { redact } from './redact.ts';

export interface CliLlmOptions {
  command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv;
  timeoutMs?: number; maxOutputBytes?: number; logger?: (message: string) => void;
}
export class CliLlm implements LlmClient {
  readonly options: CliLlmOptions;
  constructor(options: CliLlmOptions) { this.options = { ...options, args: [...(options.args ?? [])] }; }
  complete(request: CompletionRequest): Promise<Completion> {
    const options = this.options;
    const timeout = request.timeoutMs ?? options.timeoutMs ?? 120_000;
    const limit = options.maxOutputBytes ?? 1_048_576;
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid CLI limits');
    const env = { ...process.env, ...options.env };
    const safe = (text: string) => redact(redact(text, env));
    const log = (text: string) => options.logger?.(safe(text));
    if (request.signal?.aborted) return Promise.reject(new LlmCliError('LLM_ABORTED'));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(options.command, [...(options.args ?? [])], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { reject(new LlmCliError('LLM_SPAWN')); return; }
      let stdout = '', stderr = '', bytes = 0;
      let failure: string | undefined;
      const stop = (code: string) => { failure ??= code; child.kill('SIGKILL'); };
      const abort = () => stop('LLM_ABORTED');
      const timer = setTimeout(() => stop('LLM_TIMEOUT'), timeout);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const collect = (chunk: string, error: boolean) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > limit) { stop('LLM_OUTPUT_LIMIT'); return; }
        if (error) stderr += chunk; else stdout += chunk;
      };
      child.stdout.on('data', chunk => collect(chunk, false));
      child.stderr.on('data', chunk => collect(chunk, true));
      child.stdin.on('error', () => { /* Early CLI exit is reported by close. */ });
      child.on('error', () => { cleanup(); log('LLM CLI spawn failed'); reject(new LlmCliError('LLM_SPAWN')); });
      child.on('close', code => {
        cleanup();
        if (failure || code !== 0) {
          const excerpt = safe(stderr).slice(-4096);
          const error = new LlmCliError(failure ?? 'LLM_EXIT_NONZERO', code, excerpt);
          log(error.message); reject(error);
        } else { log('LLM CLI completed'); resolve({ text: stdout }); }
      });
      const input = request.system ? `${request.system}\n\n${request.prompt}` : request.prompt;
      log(`LLM CLI started; input length=${input.length}`);
      child.stdin.end(input);
    });
  }
}
/** Both CLIs consume the prompt via stdin using the owner's existing login. */
export function claudeLlm(options: Omit<CliLlmOptions, 'command' | 'args'> = {}): CliLlm {
  return new CliLlm({ ...options, command: 'claude', args: ['-p', '--output-format', 'text'] });
}
export function codexLlm(options: Omit<CliLlmOptions, 'command' | 'args'> = {}): CliLlm {
  return new CliLlm({ ...options, command: 'codex', args: ['exec', '-'] });
}
