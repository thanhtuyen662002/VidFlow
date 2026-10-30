import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { dataDirectory } from '../paths.ts';
import { assertInsideDataDir, assertSafeOutputPath } from '../media/paths.ts';
import type { Timeline } from './timeline.ts';

type Material = { id: string; path: string; duration: number };
type Timerange = { start: number; duration: number };
type Segment = { id: string; material_id: string; source_timerange: Timerange; target_timerange: Timerange; volume: number };
export interface CapcutOptions { projectDir: string; aspect: '16:9' | '9:16' }
export interface CapcutDraft {
  content: { id: string; canvas_config: { width: number; height: number; ratio: string }; duration: number;
    materials: { videos: Material[]; audios: Material[] }; tracks: { id: string; type: 'video' | 'audio'; segments: Segment[] }[] };
  meta: { draft_id: string; draft_name: string; draft_duration: number };
}
function micros(seconds: number): number {
  const value = Math.round(seconds * 1_000_000);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(value)) throw new Error('Invalid draft time');
  return value;
}
/** Pure builder: references media without reading or changing it. */
export function buildCapcutDraft(timeline: Timeline, options: CapcutOptions): CapcutDraft {
  if (!['16:9', '9:16'].includes(options.aspect)) throw new Error('Invalid draft aspect');
  const materials: CapcutDraft['content']['materials'] = { videos: [], audios: [] };
  let duration = 0;
  const tracks: CapcutDraft['content']['tracks'] = [];
  for (const [ti, track] of timeline.tracks.entries()) {
    if (track.kind === 'subtitle') continue;
    const type = track.kind === 'video' ? 'video' : 'audio';
    let position = 0;
    const segments = track.clips.map((clip, ci) => {
      const start = micros(clip.inPoint), length = micros(clip.outPoint - clip.inPoint);
      if (length <= 0) throw new Error('Invalid draft clip in/out');
      // Video is assembled contiguously; audio keeps its explicit placement (including gaps).
      const target = type === 'video' ? position : micros(clip.timelineStart);
      const id = `material-${ti}-${ci}`;
      const path = resolve(options.projectDir, clip.sourcePath);
      const offset = relative(resolve(options.projectDir), path);
      if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error('Draft media escapes project');
      materials[type === 'video' ? 'videos' : 'audios'].push({ id, path, duration: micros(clip.outPoint) });
      position += length;
      duration = Math.max(duration, target + length);
      return { id: `segment-${ti}-${ci}`, material_id: id, source_timerange: { start, duration: length },
        target_timerange: { start: target, duration: length }, volume: type === 'video' || track.muted ? 0 : 1 };
    });
    tracks.push({ id: `track-${ti}`, type, segments });
  }
  const [width, height] = options.aspect === '16:9' ? [1920, 1080] : [1080, 1920];
  return { content: { id: timeline.id, canvas_config: { width, height, ratio: options.aspect }, duration, materials, tracks },
    meta: { draft_id: timeline.id, draft_name: `VidFlow ${timeline.id}`, draft_duration: duration } };
}

/** Publishes two complete JSON files together; reserves a fresh directory on every call. */
export async function writeCapcutDraft(draft: CapcutDraft, outDir: string, options: Pick<CapcutOptions, 'projectDir'>): Promise<string> {
  const inputs = [...draft.content.materials.videos, ...draft.content.materials.audios].map(m => m.path);
  inputs.forEach(path => assertInsideDataDir(path, options.projectDir));
  const context = { dataDir: dataDirectory(), projectDir: options.projectDir, inputPaths: inputs };
  assertSafeOutputPath(join(outDir, 'draft_content.json'), context);
  await mkdir(dirname(outDir), { recursive: true });
  // mkdtemp avoids collisions and never reuses an existing draft, even across concurrent exports.
  const destination = await mkdtemp(`${outDir}-`);
  const staging = join(destination, '.pending');
  try {
    await mkdir(staging);
    await writeFile(join(staging, 'draft_content.json'), JSON.stringify(draft.content, null, 2), { flag: 'wx' });
    await writeFile(join(staging, 'draft_meta_info.json'), JSON.stringify(draft.meta, null, 2), { flag: 'wx' });
    const published = join(destination, 'capcut_draft');
    await rename(staging, published);
    return published;
  } catch (error) {
    assertInsideDataDir(destination, dirname(outDir));
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
