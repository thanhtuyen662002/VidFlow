import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { runMediaFiles } from '../media/runner.ts';
import { assertSafeOutputPath } from '../media/paths.ts';
import { getProject } from '../repo/projects.ts';
import { getMusicTrack } from '../repo/music.ts';
import { resolveInside } from '../paths.ts';

export interface AudioContext { dataDir: string; projectDir: string; timeoutMs?: number }
export interface Loudness { integratedLufs: number; truePeak: number }
export interface LoudnormMeasurement extends Loudness { lra: number; threshold: number; offset: number }
function finite(value: number, name: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} không hợp lệ`);
  return value;
}
/** ffmpeg calls its pass-one values input_i/input_tp; pass two calls them measured_I/measured_TP. */
export function parseLoudnorm(stderr: string): LoudnormMeasurement {
  for (const match of [...stderr.matchAll(/\{[^{}]*\}/g)].reverse()) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(match[0]); } catch { continue; }
    if (!('input_i' in row) && !('measured_I' in row)) continue;
    const read = (a: string, b: string) => {
      const value = row[a] ?? row[b];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Thiếu số đo loudnorm');
      return finite(Number(value), a);
    };
    return { integratedLufs: read('input_i', 'measured_I'), truePeak: read('input_tp', 'measured_TP'),
      lra: read('input_lra', 'measured_LRA'), threshold: read('input_thresh', 'measured_thresh'), offset: read('target_offset', 'target_offset') };
  }
  throw new Error('Không đọc được JSON loudnorm');
}
function options(context: AudioContext, inputPaths: string[], outputPath?: string) {
  return { ...context, inputPaths, outputPath, timeoutMs: context.timeoutMs ?? 120000 };
}
async function analyze(input: string, context: AudioContext, target: number): Promise<LoudnormMeasurement> {
  finite(target, 'LUFS', -70, -5);
  const result = await runMediaFiles('ffmpeg', paths => ['-i', paths[0], '-vn', '-af',
    `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], options(context, [input]));
  return parseLoudnorm(result.stderrTail);
}
export async function measure_loudness(input: string, context: AudioContext): Promise<Loudness> { return analyze(input, context, -14); }
export async function normalize(input: string, output: string, context: AudioContext, targetLufs = -14): Promise<Loudness> {
  assertSafeOutputPath(output, { ...context, inputPaths: [input] });
  const m = await analyze(input, context, targetLufs);
  await runMediaFiles('ffmpeg', (paths, destination) => ['-i', paths[0], '-vn', '-af',
    `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:measured_I=${m.integratedLufs}:measured_TP=${m.truePeak}:measured_LRA=${m.lra}:measured_thresh=${m.threshold}:offset=${m.offset}:linear=true`,
    '-ar', '48000', '-c:a', 'pcm_s24le', '-f', 'wav', destination!], options(context, [input], output));
  const measured = await measure_loudness(output, context);
  if (Math.abs(measured.integratedLufs - targetLufs) > 1) throw new Error(`Độ to ${measured.integratedLufs} LUFS lệch quá 1 LU so với ${targetLufs}`);
  return measured;
}
export interface AudioTrack { file: string; gainDb?: number; startSec?: number }
export interface DuckingConfig { threshold: number; ratio: number; attack: number; release: number; musicUnderDialogueDb: number }
export const defaultDucking: Readonly<DuckingConfig> = { threshold: 0.02, ratio: 8, attack: 20, release: 250, musicUnderDialogueDb: -15 };
export interface MixInput {
  original?: AudioTrack; dialogue?: AudioTrack[]; music?: { id: string; gainDb?: number };
  durationSec: number; ducking?: Partial<DuckingConfig>; targetLufs?: number;
}
/** Ducking attenuation varies with the key; musicUnderDialogueDb sets the additional music bed gain. */
export function buildMixGraph(original: AudioTrack | undefined, dialogue: AudioTrack[], music: AudioTrack | undefined,
  durationSec: number, config: Partial<DuckingConfig> = {}): string {
  finite(durationSec, 'Thời lượng', 0.001);
  const d = { ...defaultDucking, ...config };
  finite(d.threshold, 'Ngưỡng', 0.000976563, 1); finite(d.ratio, 'Tỷ lệ', 1, 20);
  finite(d.attack, 'Attack', 0.01, 2000); finite(d.release, 'Release', 0.01, 9000);
  finite(d.musicUnderDialogueDb, 'Mức nhạc', -60, 0);
  const graph: string[] = []; const outputs: string[] = []; let index = 0;
  const track = (t: AudioTrack) => {
    const label = `t${index}`;
    graph.push(`[${index++}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${finite(t.gainDb ?? 0, 'Gain')}dB,adelay=${finite(t.startSec ?? 0, 'Vị trí', 0) * 1000}:all=1,apad,atrim=duration=${durationSec}[${label}]`);
    return `[${label}]`;
  };
  if (original) outputs.push(track(original));
  if (dialogue.length) {
    const voices = dialogue.map(track);
    graph.push(`${voices.join('')}amix=inputs=${voices.length}:normalize=0:duration=longest[voice]`);
    if (music) { graph.push('[voice]asplit=2[spoken][key]'); outputs.push('[spoken]'); }
    else outputs.push('[voice]');
  }
  if (music) {
    const bed = track(music);
    if (dialogue.length) {
      graph.push(`${bed}volume=${d.musicUnderDialogueDb}dB[bed]`);
      graph.push(`[bed][key]sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}:attack=${d.attack}:release=${d.release}[ducked]`);
      outputs.push('[ducked]');
    } else outputs.push(bed);
  }
  if (!outputs.length) graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${durationSec}[out]`);
  else graph.push(`${outputs.join('')}amix=inputs=${outputs.length}:normalize=0:duration=longest,atrim=duration=${durationSec}[out]`);
  return graph.join(';');
}
export async function mix(db: DatabaseSync, projectId: string, input: MixInput, output: string, context: AudioContext): Promise<{ path: string; musicId?: string; loudness: Loudness | null }> {
  const project = getProject(db, projectId);
  if (!project || project.directory !== context.projectDir) throw new Error('Dự án âm thanh không hợp lệ');
  let music: AudioTrack | undefined;
  if (input.music) {
    const record = getMusicTrack(db, input.music.id);
    if (!record || record.projectId !== projectId || !record.hasLicense || !record.licenseSource.trim()) throw new Error('Nhạc chưa có giấy phép hợp lệ trong dự án');
    music = { file: resolveInside(project.directory, record.file), gainDb: input.music.gainDb };
  }
  const dialogue = input.dialogue ?? [];
  const tracks = [...(input.original ? [input.original] : []), ...dialogue, ...(music ? [music] : [])];
  const graph = buildMixGraph(input.original, dialogue, music, input.durationSec, input.ducking);
  const paths = tracks.map(t => t.file);
  assertSafeOutputPath(output, { ...context, inputPaths: paths });
  const temporary = join(context.projectDir, 'exports', `mix-${randomUUID()}.wav`);
  try {
    await runMediaFiles('ffmpeg', (files, destination) => [...files.flatMap(file => ['-i', file]), '-filter_complex', graph,
      '-map', '[out]', '-c:a', 'pcm_f32le', '-f', 'wav', destination!], options(context, paths, tracks.length ? temporary : output));
    // Silence has no finite integrated LUFS and cannot be normalized to a target.
    const loudness = tracks.length ? await normalize(temporary, output, context, input.targetLufs ?? -14) : null;
    return { path: output, musicId: input.music?.id, loudness };
  } finally { await unlink(temporary).catch(() => {}); }
}
