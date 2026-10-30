import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir, assertSafeOutputPath } from '../media/paths.ts';
import { runMediaFiles } from '../media/runner.ts';
import { segmentVideoFilter } from '../media/concat-segments.ts';
import { normalize } from './audio.ts';
import { timelineFps, timelineSrt, videoClips } from './subtitles.ts';
import type { Timeline } from './timeline.ts';

/** Two ffmpeg filter-parser escaping levels, including Windows drive colons. */
export function escapeSubtitlePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/([\\':,;\[\] ])/g, '\\$1').replace(/([\\',;\[\]])/g, '\\$1');
}
export interface FinalExportOptions {
  projectDir: string; mixedAudioPath: string; aspect: '16:9' | '9:16';
  outDir?: string; timestamp?: string; timeoutMs?: number;
}
/** Accepts the path returned by M7.2 mix(), preserving its licence checks. */
export async function exportFinal(timeline: Timeline, options: FinalExportOptions) {
  const dataDir = dataDirectory();
  const projectDir = assertInsideDataDir(options.projectDir, dataDir);
  const root = resolveInside(projectDir, 'exports');
  const outDir = options.outDir ? assertInsideDataDir(options.outDir, projectDir) : root;
  if (outDir !== root) resolveInside(root, relative(root, outDir));
  const stamp = options.timestamp ?? new Date().toISOString().replace(/[-:.]/g, '');
  if (!/^[a-z0-9_-]+$/i.test(stamp)) throw new Error('Invalid export timestamp');
  if (!['16:9', '9:16'].includes(options.aspect)) throw new Error('Invalid aspect');
  const clips = videoClips(timeline), fps = timelineFps(timeline);
  if (!clips.length) throw new Error('Empty video timeline');
  let endFrame = 0;
  for (const clip of clips) {
    const start = Math.round(clip.timelineStart * fps), frames = Math.round(clip.duration * fps);
    if (start !== endFrame || frames <= 0 || clip.inPoint < 0 || clip.outPoint <= clip.inPoint ||
      Math.abs(clip.outPoint - clip.inPoint - clip.duration) > 0.000001) throw new Error('Export requires contiguous valid clips');
    endFrame += frames;
  }
  const context = { dataDir, projectDir, timeoutMs: options.timeoutMs ?? 300000 };
  const inputs = [...clips.map(c => assertInsideDataDir(c.sourcePath, projectDir)), assertInsideDataDir(options.mixedAudioPath, projectDir)];
  const stem = `${basename(projectDir).replace(/[^a-z0-9_-]/gi, '_')}_${stamp}_${options.aspect.replace(':', 'x')}`;
  const path = resolveInside(outDir, `${stem}.mp4`), srtPath = resolveInside(outDir, `${stem}.srt`);
  for (const output of [path, srtPath]) assertSafeOutputPath(output, { ...context, inputPaths: inputs });
  await mkdir(outDir, { recursive: true });
  const audio = resolveInside(root, `final-audio-${randomUUID()}.wav`);
  let wroteSrt = false;
  try {
    const loudness = await normalize(options.mixedAudioPath, audio, context);
    const srt = timelineSrt(timeline);
    await writeFile(srtPath, srt, { encoding: 'utf8', flag: 'wx' }); wroteSrt = true;
    const [width, height] = options.aspect === '16:9' ? [1920, 1080] : [1080, 1920];
    const filters = clips.map((c, i) => segmentVideoFilter(i, c.inPoint, c.outPoint, fps, width, height, true)
      .replace(`[v${i}]`, `,trim=end_frame=${Math.round(c.duration * fps)}[v${i}]`));
    filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[joined]`);
    filters.push(`[joined]${srt ? `subtitles=filename=${escapeSubtitlePath(srtPath)}` : 'null'}[v]`);
    await runMediaFiles('ffmpeg', (files, output) => [...files.flatMap(f => ['-i', f]), '-filter_complex_threads', '1',
      '-filter_complex', filters.join(';'), '-map', '[v]', '-map', `${clips.length}:a:0`,
      '-t', String(endFrame / fps), '-af', `apad,atrim=duration=${endFrame / fps}`,
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
      '-movflags', '+faststart', output!], { ...context, inputPaths: [...inputs.slice(0, -1), audio], outputPath: path });
    return { path, srtPath, width, height, loudness };
  } catch (error) {
    await unlink(path).catch(() => {});
    if (wroteSrt) await unlink(srtPath).catch(() => {});
    throw error;
  } finally { await unlink(audio).catch(() => {}); }
}
