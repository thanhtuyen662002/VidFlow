import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveFfmpeg, resolveFfprobe } from './discovery.ts';
import { MediaToolExitError, MediaToolNotFoundError, MediaToolTimeoutError } from './errors.ts';
import type { MediaTool } from './errors.ts';
import { assertInsideDataDir, assertSafeOutputPath } from './paths.ts';
import type { OutputPathOptions } from './paths.ts';

export interface RunOptions { timeoutMs: number; cwd?: string; signal?: AbortSignal }
export interface RunResult { stdout: string; stderrTail: string }
import { redactSensitive } from './redaction.ts';

function run(tool: MediaTool, args: string[], options: RunOptions): Promise<RunResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  const binary = tool === 'ffmpeg' ? resolveFfmpeg() : resolveFfprobe();
  return new Promise((accept, reject) => {
    const child = spawn(binary, ['-hide_banner', ...(tool === 'ffmpeg' ? ['-nostdin'] : []), ...args], {
      shell: false, windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let pending = '';
    const lines: string[] = [];
    let timedOut = false;
    let aborted = false;
    const tail = () => redactSensitive([...lines, pending].slice(-20).join('\n'));
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const limit = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); }, 2000);
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', () => { clearTimeout(limit); child.kill('SIGKILL'); });
      } else child.kill('SIGKILL');
    };
    const abort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => {
      const parts = (pending + chunk).split(/\r\n|[\r\n]/);
      pending = parts.pop()!.slice(-8192);
      for (const line of parts) {
        lines.push(line.slice(-8192));
        if (lines.length > 200) lines.shift();
      }
    });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', () => {
      cleanup();
      reject(new MediaToolNotFoundError(tool, process.env[`VIDFLOW_${tool.toUpperCase()}`] === undefined ? 'PATH' : 'env'));
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (timedOut) reject(new MediaToolTimeoutError(options.timeoutMs, tail()));
      else if (code !== 0 || aborted) reject(new MediaToolExitError(code, signal, tail()));
      else accept({ stdout, stderrTail: tail() });
    });
  });
}
/** Low-level argument runner; file operations should use runMediaFiles. */
export function runFfmpeg(args: string[], options: RunOptions): Promise<RunResult> { return run('ffmpeg', args, options); }
export function runFfprobe(args: string[], options: RunOptions): Promise<RunResult> { return run('ffprobe', args, options); }
/** Build arguments from validated paths, never from unvalidated user paths. */
export function runMediaFiles(tool: MediaTool, buildArgs: (inputs: string[], output?: string) => string[],
  options: RunOptions & OutputPathOptions & { outputPath?: string }): Promise<RunResult> {
  const inputs = options.inputPaths.map(file => assertInsideDataDir(file, options.dataDir));
  const output = options.outputPath === undefined ? undefined : assertSafeOutputPath(options.outputPath, options);
  if (options.cwd) assertInsideDataDir(options.cwd, options.dataDir);
  return run(tool, [...(tool === 'ffmpeg' ? ['-n'] : []), ...buildArgs(inputs, output)], options);
}
