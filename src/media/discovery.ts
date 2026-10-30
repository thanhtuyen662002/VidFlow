import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { MediaToolNotFoundError } from './errors.ts';
import type { MediaTool } from './errors.ts';

const cache = new Map<MediaTool, string>();
export function resetMediaToolCache(): void { cache.clear(); }
function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return process.platform !== 'win32' || ['.exe', '.com'].includes(extname(file).toLowerCase());
  } catch { return false; }
}
function discover(tool: MediaTool): string {
  const cached = cache.get(tool);
  if (cached) return cached;
  const override = process.env[`VIDFLOW_${tool.toUpperCase()}`];
  let result: string | undefined;
  if (override !== undefined) {
    if (override && executable(resolve(override))) result = resolve(override);
    else throw new MediaToolNotFoundError(tool, 'env');
  } else {
    const extensions = process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT || '.EXE;.COM').split(';')] : [''];
    for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = resolve(join(directory.replace(/^"|"$/g, ''), tool + extension));
        if (executable(candidate)) { result = candidate; break; }
      }
      if (result) break;
    }
  }
  if (!result) throw new MediaToolNotFoundError(tool, 'PATH');
  cache.set(tool, result);
  return result;
}
export function resolveFfmpeg(): string { return discover('ffmpeg'); }
export function resolveFfprobe(): string { return discover('ffprobe'); }
