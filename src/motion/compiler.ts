import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { CompilerBible, CompiledScene } from '../prompt/compiler.ts';
import { compileScene } from '../prompt/compiler.ts';
import { getSourceVideo, listSegments } from './source-import.ts';
import { getEffectiveMapping, listSubjects, validateMappings } from './subjects.ts';

/** File configuration can be edited without changing code; custom presets may be passed explicitly. */
export function loadMotionPresets(): Record<string,string> {
  const value: unknown = JSON.parse(readFileSync(new URL('./presets.json',import.meta.url),'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('Invalid motion presets');
  return value as Record<string,string>;
}
export function compileMotionSegment(db: DatabaseSync, segmentId: string, bible: CompilerBible,
  options: { preset: string; maxReferenceImages: number; presets?: Record<string,string> }): CompiledScene {
  const segment = db.prepare('SELECT source_video_id FROM source_segments WHERE id=?').get(segmentId);
  if (!segment) throw new Error('Source segment not found');
  const videoId = String(segment.source_video_id);
  getSourceVideo(db,videoId);
  validateMappings(db,videoId);
  const presets = options.presets ?? loadMotionPresets();
  if (!Object.hasOwn(presets,options.preset)) throw new Error(`Unknown motion preset: ${options.preset}`);
  const subjects = listSubjects(db,videoId).filter(s => s.segment_id === segmentId);
  const mappingText = subjects.map(s => {
    const m = getEffectiveMapping(db,s.id)!;
    return `${s.subject_key}: ${m.target_ref ?? m.target_type}; ${s.motion_description}; ${s.composition}`;
  }).join('\n');
  const current = listSegments(db,videoId).find(s => s.id === segmentId)!;
  const analysis = db.prepare('SELECT motion_analysis FROM source_segments WHERE id=?').get(segmentId)!.motion_analysis;
  return compileScene({ prompt: [presets[options.preset],mappingText,
    `Preserve motion, rhythm, composition, camera angle and duration (${current.end_sec-current.start_sec}s).`,
    analysis ? String(analysis) : ''].filter(Boolean).join('\n'), charactersPresent: [],location: '',camera: '',action: '' },bible,options);
}
