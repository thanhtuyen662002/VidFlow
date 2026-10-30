import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir, assertSafeOutputPath } from './paths.ts';
import { MediaInputError, probe } from './probe.ts';
import { runMediaFiles } from './runner.ts';
import { UnsafePathError } from './errors.ts';

export interface MediaSegment { path: string; in: number; out?: number }
export interface ConcatSegmentsOptions {
  outputName?: string;
  outputPath?: string;
  fps?: number;
  width?: number;
  height?: number;
  audioSampleRate?: number;
  audioChannels?: number;
}
function invalid(message: string): never {
  throw new MediaInputError('MEDIA_INVALID_SEGMENTS', message);
}

/** Accurate cuts and normalized MP4 output; originals are never modified. */
export async function concatSegments(projectDir: string, segments: readonly MediaSegment[], options: ConcatSegmentsOptions = {}) {
  if (!segments.length) invalid('Danh sách đoạn không được rỗng');
  const dataDir = dataDirectory();
  const project = assertInsideDataDir(projectDir, dataDir);
  const directory = resolveInside(project, 'exports');
  const inputs = segments.map(segment => assertInsideDataDir(segment.path, dataDir));
  const infos = await Promise.all(inputs.map(input => probe(input)));
  const ends = segments.map((segment, i) => {
    const end = segment.out ?? infos[i].durationSec;
    if (!Number.isFinite(segment.in) || !Number.isFinite(end) || segment.in < 0 ||
      segment.in >= end || end > infos[i].durationSec) invalid(`Đoạn ${i + 1}: cần 0 <= in < out <= thời lượng nguồn`);
    return end;
  });
  const fps = options.fps ?? infos[0].fps;
  const width = options.width ?? infos[0].width;
  const height = options.height ?? infos[0].height;
  const rate = options.audioSampleRate ?? infos[0].audioSampleRate ?? 48000;
  const channels = options.audioChannels ?? infos[0].audioChannels ?? 2;
  if (!Number.isFinite(fps) || fps <= 0 || ![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n % 2 === 0) ||
    !Number.isSafeInteger(rate) || rate <= 0 || ![1, 2, 3, 4, 5, 6, 7, 8].includes(channels)) {
    invalid('Thông số chuẩn hóa không hợp lệ: kích thước phải chẵn, fps và tần số âm thanh phải dương, số kênh từ 1 đến 8');
  }
  const layout = ['mono', 'stereo', '2.1', 'quad', '5.0', '5.1', '6.1', '7.1'][channels - 1];
  const requested = options.outputPath === undefined
    ? resolveInside(directory, options.outputName ?? 'concat.mp4')
    : assertInsideDataDir(options.outputPath, dataDir);
  // resolveInside also checks canonical parents, including symlinks.
  resolveInside(directory, relative(directory, requested));
  if (extname(requested).toLowerCase() !== '.mp4') invalid('Đầu ra phải là tệp MP4 trong exports/');
  const paths = { dataDir, projectDir: project, inputPaths: inputs };
  try { assertSafeOutputPath(requested, paths); }
  catch (error) {
    if (!(error instanceof UnsafePathError) || error.reason !== 'Output already exists') throw error;
  }
  // Check source aliases even when the requested filename already exists.
  for (const input of inputs) {
    if (requested.toLowerCase() === input.toLowerCase()) invalid('Đầu ra không được trùng tệp nguồn');
  }
  const filters: string[] = [];
  segments.forEach((segment, i) => {
    const duration = ends[i] - segment.in;
    filters.push(`[${i}:v:0]trim=start=${segment.in}:end=${ends[i]},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    const audio = infos[i].hasAudio
      ? `[${i}:a:0]atrim=start=${segment.in}:end=${ends[i]},asetpts=PTS-STARTPTS`
      : `anullsrc=r=${rate}:cl=${layout},atrim=duration=${duration},asetpts=PTS-STARTPTS`;
    filters.push(`${audio},aresample=${rate},aformat=sample_rates=${rate}:channel_layouts=${layout},apad,atrim=duration=${duration}[a${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[v][a]`);
  await mkdir(dirname(requested), { recursive: true });
  const temporary = join(dirname(requested), `.concat-${randomUUID()}.mp4`);
  let reserved: string | undefined;
  try {
    await runMediaFiles('ffmpeg', (files, output) => [
      ...files.flatMap(file => ['-i', file]), '-filter_complex', filters.join(';'),
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', output!,
    ], { ...paths, outputPath: temporary, timeoutMs: 300000 });
    const measured = await probe(temporary);
    for (let suffix = 0; ; suffix++) {
      const name = suffix ? `${basename(requested, extname(requested))}_${suffix}.mp4` : basename(requested);
      const output = join(dirname(requested), name);
      if (existsSync(output)) continue;
      assertSafeOutputPath(output, paths);
      try {
        const handle = await open(output, 'wx');
        reserved = output;
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    await rename(temporary, reserved!);
    const output = reserved!;
    reserved = undefined;
    return { path: output, durationSec: measured.durationSec };
  } finally {
    await rm(temporary, { force: true });
    if (reserved) await rm(reserved, { force: true });
  }
}
