import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';
import { UnsafePathError } from './errors.ts';
import { assertInsideDataDir, assertSafeOutputPath } from './paths.ts';
import { probe } from './probe.ts';
import { runMediaFiles } from './runner.ts';

export type LogoCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export interface LogoCropConfig { corner: LogoCorner; widthPct: number; heightPct: number }
export const DEFAULT_LOGO_CROP: Readonly<LogoCropConfig> = Object.freeze({
  corner: 'bottom-right', widthPct: 0.15, heightPct: 0.08,
});
export interface CropLogoOptions { config?: Partial<LogoCropConfig>; fileName?: string }

export function buildLogoCropFilter(width: number, height: number, config: Partial<LogoCropConfig> = {}) {
  const settings = { ...DEFAULT_LOGO_CROP, ...config };
  if (!['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(settings.corner) ||
    ![settings.widthPct, settings.heightPct].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 0.5)) {
    throw new RangeError('Invalid Flow logo corner or percentages (must be in (0, 0.5])');
  }
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Invalid dimensions');
  const w = Math.max(1, Math.round(width * settings.widthPct));
  const h = Math.max(1, Math.round(height * settings.heightPct));
  const right = settings.corner.endsWith('right');
  const bottom = settings.corner.startsWith('bottom');
  const rectangle = { x: right ? width - w : 0, y: bottom ? height - h : 0, width: w, height: h };
  // M3: shrink both axes equally, anchored opposite the logo, then scale back.
  // Removing either full band excludes the rectangle. Prefer the smaller zoom.
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  const units = Math.floor(divisor * (1 - Math.min(w / width, h / height)));
  if (units < 1) throw new RangeError('Dimensions too small for an exact aspect-ratio crop');
  const cw = width / divisor * units;
  const ch = height / divisor * units;
  const x = right ? 0 : width - cw;
  const y = bottom ? 0 : height - ch;
  return { rectangle, filter: `crop=w=${cw}:h=${ch}:x=${x}:y=${y}:exact=1,scale=${width}:${height}` };
}

async function cropLogo(projectDir: string, source: string, video: boolean, options: CropLogoOptions) {
  // Only crop the configured Flow corner. Never detect, blur, or inpaint AI
  // watermarks (including SynthID), or intentionally strip AI declarations.
  buildLogoCropFilter(1280, 720, options.config);
  const dataDir = dataDirectory();
  const project = assertInsideDataDir(projectDir, dataDir);
  const input = assertInsideDataDir(source, dataDir);
  const extension = extname(input).toLowerCase();
  if (!(video ? extension === '.mp4' : ['.png', '.jpg', '.jpeg'].includes(extension))) {
    throw new RangeError('Expected PNG/JPG image or MP4 video');
  }
  const name = options.fileName ?? `${basename(input, extname(input)).replace(/[^a-zA-Z0-9_-]/g, '_')}_flow-crop${extension}`;
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_. -]*$/.test(name) || extname(name).toLowerCase() !== extension) {
    throw new UnsafePathError('Invalid logo crop filename');
  }
  const directory = resolveInside(project, video ? 'exports' : 'frames');
  const output = resolveInside(directory, name);
  const paths = { dataDir, projectDir: project, inputPaths: [input] };
  assertSafeOutputPath(output, paths);
  const info = await probe(input);
  const { filter } = buildLogoCropFilter(info.width, info.height, options.config);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.flow-${randomUUID()}${extension}`);
  try {
    await runMediaFiles('ffmpeg', (inputs, out) => [
      '-i', inputs[0], '-map', '0:v:0', ...(video ? ['-map', '0:a?'] : []),
      '-map_metadata', '0', '-map_metadata:s:v:0', '0:s:v:0', '-vf', filter,
      ...(video ? ['-c:v', 'libx264', '-crf', '18', '-fps_mode', 'passthrough',
        ...(info.pixelFormat ? ['-pix_fmt', info.pixelFormat] : []), '-c:a', 'copy'] : ['-frames:v', '1']),
      out!,
    ], { ...paths, outputPath: temporary, timeoutMs: video ? 300000 : 30000 });
    assertSafeOutputPath(output, paths);
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  return { path: output, width: info.width, height: info.height };
}

export function cropLogoImage(projectDir: string, imagePath: string, options: CropLogoOptions = {}) {
  return cropLogo(projectDir, imagePath, false, options);
}
export function cropLogoVideo(projectDir: string, videoPath: string, options: CropLogoOptions = {}) {
  return cropLogo(projectDir, videoPath, true, options);
}
