import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Points VidFlow at the ffmpeg/ffprobe and Playwright browsers the installer ships under resources/
 * (see config/vendor-tools.mjs). Variables the user already set win; a missing bundled file is skipped,
 * so a development run keeps using PATH and the default Playwright browser folder.
 */
export function useBundledTools(resourcesDir: string | undefined, env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync): void {
  if (!resourcesDir) return;
  const defaults: Record<string, string> = {
    VIDFLOW_FFMPEG: join(resourcesDir, 'ffmpeg', 'ffmpeg.exe'),
    VIDFLOW_FFPROBE: join(resourcesDir, 'ffmpeg', 'ffprobe.exe'),
    PLAYWRIGHT_BROWSERS_PATH: join(resourcesDir, 'ms-playwright'),
  };
  for (const [name, path] of Object.entries(defaults)) {
    if (!env[name] && exists(path)) env[name] = path;
  }
}
