import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir, assertSafeOutputPath } from '../media/paths.ts';
import { runMediaFiles } from '../media/runner.ts';
import { segmentVideoFilter } from '../media/concat-segments.ts';
import { normalize } from './audio.ts';
import { timelineFps, timelineSrt, videoClips } from './subtitles.ts';
import type { Timeline } from './timeline.ts';
import { buildCapcutDraft, writeCapcutDraft } from './capcut.ts';
import { createLogger } from '../logger.ts';
import { redactString } from '../redact.ts';
import { probe } from '../media/probe.ts';
import { concatSegments } from '../media/concat-segments.ts';
import { aiDisclosure } from './package.ts';

/** M7 extension for source-timed footage. No spatial crop or audio retiming. */
export async function stretchVideo(projectDir: string, input: string, frames: number, fps: number) {
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid target timing');
  const info = await probe(input);
  if (info.durationSec <= 0) throw new Error('Empty candidate');
  return atomicVideo(projectDir, [input], (files, out) => ['-i', files[0], '-an', '-vf',
    `setpts=(PTS-STARTPTS)*${frames / fps / info.durationSec},fps=${fps},tpad=stop_mode=clone:stop_duration=${frames / fps},trim=end_frame=${frames},setpts=N/(${fps}*TB)`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
}

async function atomicVideo(projectDir: string, inputs: string[], args: (files: string[], out: string) => string[]) {
  const root = assertInsideDataDir(projectDir, dataDirectory());
  const path = resolveInside(root, `exports/${randomUUID()}.mp4`);
  const temporary = resolveInside(root, `exports/${randomUUID()}.partial.mp4`);
  await mkdir(resolveInside(root, 'exports'), { recursive: true });
  try {
    await runMediaFiles('ffmpeg', (files, out) => args(files, out!), {
      dataDir: dataDirectory(), projectDir: root, inputPaths: inputs, outputPath: temporary, timeoutMs: 300000,
    });
    assertSafeOutputPath(path, { dataDir: dataDirectory(), projectDir: root, inputPaths: inputs });
    await rename(temporary, path);
    return path;
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function joinTimedVideos(projectDir: string, paths: string[], fps: number, width: number, height: number) {
  return (await concatSegments(projectDir, paths.map(path => ({ path, in: 0 })), {
    fps, width, height, outputName: `motion-${randomUUID()}.mp4`,
  })).path;
}

/** Audio is taken once from the full source, preserving scene offsets. */
export async function muxSourceAudio(projectDir: string, joined: string, source: string, keepOriginalAudio: boolean, duration: number) {
  const audio = keepOriginalAudio && (await probe(source)).hasAudio;
  return atomicVideo(projectDir, [joined, source], (files, out) => ['-i', files[0], '-i', files[1],
    '-map', '0:v:0', ...(audio ? ['-map', '1:a:0', '-c:a', 'aac'] : ['-an']),
    '-c:v', 'copy', '-t', String(duration), '-metadata', `comment=${aiDisclosure(['Google Flow/Veo']).statement}`,
    '-movflags', '+faststart', out]);
}

export async function discloseVideo(projectDir: string, path: string) {
  assertInsideDataDir(path, resolveInside(projectDir, 'exports'));
  const sidecar = `${path}.ai-disclosure.json`, temporary = `${sidecar}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(aiDisclosure(['Google Flow/Veo']), null, 2), { flag: 'wx' });
    await rename(temporary, sidecar);
  } finally { await unlink(temporary).catch(() => {}); }
  return path;
}

/** Two ffmpeg filter-parser escaping levels, including Windows drive colons. */
export function escapeSubtitlePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/([\\':,;\[\] ])/g, '\\$1').replace(/([\\',;\[\]])/g, '\\$1');
}
export interface FinalExportOptions {
  projectDir: string; mixedAudioPath: string; aspect: '16:9' | '9:16';
  outDir?: string; timestamp?: string; timeoutMs?: number;
  /** Injection point for filesystem failures without changing the video pipeline. */
  draftWriter?: typeof writeCapcutDraft;
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
    let capcutDraft: { ok: true; path: string } | { ok: false; error: string };
    const warnings: string[] = [];
    try {
      const draft = buildCapcutDraft(timeline, { projectDir, aspect: options.aspect });
      const draftPath = await (options.draftWriter ?? writeCapcutDraft)(draft,
        resolveInside(outDir, `${options.aspect.replace(':', 'x')}/capcut_draft`), { projectDir });
      capcutDraft = { ok: true, path: draftPath };
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      capcutDraft = { ok: false, error: message };
      warnings.push(`CapCut draft: ${message}`);
      // A logging failure must never invalidate the completed MP4 either.
      try { createLogger().warn('CapCut draft failed', { error: message, timelineId: timeline.id }); } catch {}
    }
    return { path, srtPath, width, height, loudness, capcutDraft, warnings };
  } catch (error) {
    await unlink(path).catch(() => {});
    if (wroteSrt) await unlink(srtPath).catch(() => {});
    throw error;
  } finally { await unlink(audio).catch(() => {}); }
}
