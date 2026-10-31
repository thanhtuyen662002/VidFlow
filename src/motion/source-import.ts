import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { dataDirectory, projectDirectory, resolveInside } from '../paths.ts';
import { getProject } from '../repo/projects.ts';
import { probe } from '../media/probe.ts';
import { detectSceneCuts } from '../media/scene-detection.ts';
import { runMediaFiles } from '../media/runner.ts';

export class RightsNotConfirmedError extends Error {
  constructor() { super('Source video usage rights must be confirmed'); this.name = 'RightsNotConfirmedError'; }
}
export interface SourceVideo {
  id: string; project_id: string; original_path: string; stored_path: string; sha256: string;
  size_bytes: number; duration_sec: number; fps: number; width: number; height: number;
  has_audio: number; audio_path: string | null; rights_confirmed: 1; rights_confirmed_at: string;
  scene_threshold: number; max_segment_sec: number; min_scene_sec: number; owner_cuts: string | null; created_at: string;
}
export interface SourceSegment {
  id: string; source_video_id: string; idx: number; scene_index: number;
  start_sec: number; end_sec: number; start_frame: number; end_frame: number; frame_count: number;
  origin: 'auto' | 'split' | 'owner'; created_at: string; updated_at: string;
}
export interface SegmentOptions { sceneThreshold?: number; maxSegmentSec?: number; minSceneSec?: number }
export function getSourceVideo(db: DatabaseSync, id: string): SourceVideo {
  const video = db.prepare('SELECT * FROM source_videos WHERE id=?').get(id) as unknown as SourceVideo | undefined;
  if (!video) throw new Error('Source video not found');
  return video;
}
export function listSegments(db: DatabaseSync, id: string): SourceSegment[] {
  return db.prepare('SELECT id,source_video_id,idx,scene_index,start_sec,end_sec,start_frame,end_frame,frame_count,origin,created_at,updated_at FROM source_segments WHERE source_video_id=? ORDER BY idx').all(id).map(row => ({ ...row })) as unknown as SourceSegment[];
}
function options(video?: SourceVideo, input: SegmentOptions = {}) {
  const sceneThreshold = input.sceneThreshold ?? video?.scene_threshold ?? 0.3;
  const maxSegmentSec = input.maxSegmentSec ?? video?.max_segment_sec ?? 8;
  const minSceneSec = input.minSceneSec ?? video?.min_scene_sec ?? 0.5;
  if (!Number.isFinite(sceneThreshold) || sceneThreshold < 0 || sceneThreshold > 1 ||
      !Number.isFinite(maxSegmentSec) || maxSegmentSec <= 0 || !Number.isFinite(minSceneSec) || minSceneSec < 0) throw new RangeError('Invalid segmentation options');
  return { sceneThreshold, maxSegmentSec, minSceneSec };
}
function cutsToFrames(video: SourceVideo, cuts: number[]): number[] {
  const total = Math.round(video.duration_sec * video.fps);
  return [...new Set(cuts.map(cut => {
    if (!Number.isFinite(cut) || cut <= 0 || cut >= video.duration_sec) throw new RangeError('Cut must be inside video duration');
    return Math.round(cut * video.fps);
  }))].filter(frame => frame > 0 && frame < total).sort((a,b) => a-b);
}
function replaceSegments(db: DatabaseSync, video: SourceVideo, frames: number[], config: ReturnType<typeof options>, owner: boolean, saveOwner = false): SourceSegment[] {
  const total = Math.round(video.duration_sec * video.fps);
  const maxFrames = Math.floor(config.maxSegmentSec * video.fps + 1e-9);
  if (total < 1 || maxFrames < 1) throw new RangeError('Segment limit must allow at least one frame');
  const boundaries = [0, ...frames, total];
  const rows: SourceSegment[] = [];
  const now = new Date().toISOString();
  for (let scene = 0; scene < boundaries.length-1; scene++) {
    const start = boundaries[scene], length = boundaries[scene+1]-start;
    const count = Math.ceil(length/maxFrames);
    for (let part = 0; part < count; part++) {
      const a = start + Math.floor(length*part/count), b = start + Math.floor(length*(part+1)/count);
      rows.push({ id: randomUUID(), source_video_id: video.id, idx: rows.length, scene_index: scene,
        start_sec: a/video.fps, end_sec: b/video.fps, start_frame: a, end_frame: b, frame_count: b-a,
        origin: part > 0 ? 'split' : owner ? 'owner' : 'auto', created_at: now, updated_at: now });
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM source_segments WHERE source_video_id=?').run(video.id);
    const insert = db.prepare('INSERT INTO source_segments (id,source_video_id,idx,scene_index,start_sec,end_sec,start_frame,end_frame,frame_count,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of rows) insert.run(row.id,row.source_video_id,row.idx,row.scene_index,row.start_sec,row.end_sec,row.start_frame,row.end_frame,row.frame_count,row.origin,row.created_at,row.updated_at);
    db.prepare('UPDATE source_videos SET scene_threshold=?,max_segment_sec=?,min_scene_sec=? WHERE id=?').run(config.sceneThreshold,config.maxSegmentSec,config.minSceneSec,video.id);
    if (saveOwner) db.prepare('UPDATE source_videos SET owner_cuts=? WHERE id=?').run(JSON.stringify(frames.map(frame => frame/video.fps)),video.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return rows;
}
export async function segmentSourceVideo(db: DatabaseSync, id: string, input: SegmentOptions = {}): Promise<SourceSegment[]> {
  // Reload after detection so an owner edit made while ffmpeg runs wins.
  let video = getSourceVideo(db,id);
  const config = options(video,input);
  let cuts = video.owner_cuts === null ? await detectSceneCuts(resolveInside(projectDirectory(video.project_id),video.stored_path),config.sceneThreshold) : [];
  video = getSourceVideo(db,id);
  if (video.owner_cuts !== null) cuts = JSON.parse(video.owner_cuts);
  else {
    let previous = 0;
    cuts = cuts.filter(cut => {
      if (cut-previous < config.minSceneSec || video.duration_sec-cut < config.minSceneSec) return false;
      previous = cut; return true;
    });
  }
  return replaceSegments(db,video,cutsToFrames(video,cuts),config,video.owner_cuts !== null);
}
export function setOwnerCutPoints(db: DatabaseSync, id: string, cuts: number[]): SourceSegment[] {
  const video = getSourceVideo(db,id);
  return replaceSegments(db,video,cutsToFrames(video,cuts),options(video),true,true);
}
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function importSourceVideo(db: DatabaseSync, input: SegmentOptions & { projectId: string; filePath: string; rightsConfirmed?: boolean }): Promise<SourceVideo> {
  if (input.rightsConfirmed !== true) throw new RightsNotConfirmedError();
  const config = options(undefined,input);
  if (!getProject(db,input.projectId)) throw new Error('Project not found');
  const directory = projectDirectory(input.projectId);
  // Imports obey the same project containment rule as all other input assets.
  const original = resolveInside(directory,input.filePath);
  const info = await probe(original);
  if (info.durationSec <= 0 || info.fps <= 0) throw new Error('Source must have positive duration and fps');
  const sha256 = await hash(original);
  const existing = db.prepare('SELECT * FROM source_videos WHERE project_id=? AND sha256=?').get(input.projectId,sha256) as unknown as SourceVideo | undefined;
  if (existing) return existing;
  const id = randomUUID(), now = new Date().toISOString();
  const sources = resolveInside(directory,'sources');
  await mkdir(sources,{ recursive: true });
  let storedPath: string, stored: string;
  for (;;) {
    storedPath = `sources/${sha256}-${randomUUID()}.video`;
    stored = resolveInside(directory,storedPath);
    try { await copyFile(original,stored,constants.COPYFILE_EXCL); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  let audioPath: string | null = null;
  try {
    if (await hash(stored) !== sha256) throw new Error('Source changed during import');
    if (info.hasAudio) {
      audioPath = `exports/${id}-source-audio.mka`;
      await runMediaFiles('ffmpeg',(inputs,output) => ['-i',inputs[0],'-vn','-c:a','copy',output!],{
        dataDir: dataDirectory(),projectDir: directory,inputPaths: [stored],outputPath: resolveInside(directory,audioPath),timeoutMs: 600000,
      });
    }
    const video: SourceVideo = { id,project_id: input.projectId,original_path: input.filePath,stored_path: storedPath,sha256,
      size_bytes: (await stat(stored)).size,duration_sec: info.durationSec,fps: info.fps,width: info.width,height: info.height,
      has_audio: Number(info.hasAudio),audio_path: audioPath,rights_confirmed: 1,rights_confirmed_at: now,
      scene_threshold: config.sceneThreshold,max_segment_sec: config.maxSegmentSec,min_scene_sec: config.minSceneSec,owner_cuts: null,created_at: now };
    db.prepare(`INSERT INTO source_videos (${Object.keys(video).join(',')}) VALUES (${Object.keys(video).map(() => '?').join(',')})`).run(...Object.values(video));
    try { await segmentSourceVideo(db,id); }
    catch (error) { db.prepare('DELETE FROM source_videos WHERE id=?').run(id); throw error; }
    return video;
  } catch (error) {
    await unlink(stored).catch(() => {});
    if (audioPath) await unlink(resolveInside(directory,audioPath)).catch(() => {});
    throw error;
  }
}
