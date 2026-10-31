import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BibleService, lookupBibleEntry, validatePromptRefs } from '../prompt/bible.ts';
import { parsePrompt } from '../prompt/parse-refs.ts';
import { extractFrame } from '../media/extract-frame.ts';
import { projectDirectory, resolveInside } from '../paths.ts';
import { generateValidated } from '../script/llm/generate.ts';
import type { JsonSchema } from '../script/llm/schema.ts';
import type { LlmClient } from '../script/llm/types.ts';
import { getSourceVideo, listSegments } from './source-import.ts';

export class UnknownReferenceError extends Error {
  constructor(ref: string) { super(`${ref} chưa được đăng ký`); this.name = 'UnknownReferenceError'; }
}
export class FaceConsentRequiredError extends Error {
  constructor() { super('Giữ gương mặt người thật cần có đồng ý'); this.name = 'FaceConsentRequiredError'; }
}
export interface SubjectDescription {
  subject_key: string; kind: 'person' | 'hand' | 'object' | 'scene'; description: string;
  motion_description: string; composition: string; has_human_face: boolean;
}
export interface MotionAnalysis { subjects: SubjectDescription[]; motion: string; rhythm: string; composition: string }
export interface MotionSubject extends Omit<SubjectDescription, 'has_human_face'> {
  id: string; source_video_id: string; segment_id: string; has_human_face: number;
  ai_suggestion: string; analyzed_at: string; created_at: string; updated_at: string;
}
export interface MotionMapping {
  id: string; subject_id: string; target_type: 'character' | 'scene' | 'keep' | 'drop' | 'faceless';
  target_ref: string | null; target_id: string | null; source: 'ai' | 'owner'; created_at: string; updated_at: string;
}
const text: JsonSchema = { type: 'string', minLength: 1 };
export const MOTION_ANALYSIS_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['subjects','motion','rhythm','composition'],
  properties: { motion: text, rhythm: text, composition: text, subjects: { type: 'array', maxItems: 100,
    items: { type: 'object', additionalProperties: false,
      required: ['subject_key','kind','description','motion_description','composition','has_human_face'],
      properties: { subject_key: text, kind: { type: 'string', enum: ['person','hand','object','scene'] },
        description: text, motion_description: text, composition: text, has_human_face: { type: 'boolean' } } } } },
};
function subject(db: DatabaseSync, id: string): MotionSubject {
  const row = db.prepare('SELECT * FROM motion_subjects WHERE id=?').get(id);
  if (!row) throw new Error('Motion subject not found');
  return row as unknown as MotionSubject;
}
export function listSubjects(db: DatabaseSync, videoId: string): MotionSubject[] {
  return db.prepare('SELECT * FROM motion_subjects WHERE source_video_id=? ORDER BY segment_id,subject_key').all(videoId) as unknown as MotionSubject[];
}
export function getEffectiveMapping(db: DatabaseSync, subjectId: string): MotionMapping | undefined {
  return db.prepare('SELECT * FROM motion_mappings WHERE subject_id=?').get(subjectId) as unknown as MotionMapping | undefined;
}
function resolveTarget(db: DatabaseSync, row: MotionSubject, input: string) {
  const aliases: Record<string,string> = { 'giữ': 'keep', 'giữ nguyên': 'keep', 'bỏ': 'drop', 'không lộ mặt': 'faceless' };
  const target = aliases[input] ?? input;
  const video = getSourceVideo(db,row.source_video_id);
  if (['keep','drop','faceless'].includes(target)) {
    if (target === 'keep' && row.has_human_face && !db.prepare('SELECT face_consent FROM source_videos WHERE id=?').get(video.id)!.face_consent) throw new FaceConsentRequiredError();
    return { target_type: target as 'keep' | 'drop' | 'faceless', target_ref: null, target_id: null };
  }
  const tokens = parsePrompt(target);
  if (tokens.length !== 1 || tokens[0].kind !== 'ref' || tokens[0].end !== target.length) throw new Error('Mapping requires @Name, keep, drop or faceless');
  if (validatePromptRefs(db,video.project_id,target).length) throw new UnknownReferenceError(target);
  const ref = lookupBibleEntry(new BibleService(db).list(video.project_id),tokens[0].name);
  if (!ref) throw new UnknownReferenceError(target);
  if (ref.kind !== 'character' && ref.kind !== 'location') throw new Error('Motion mapping requires a character or location reference');
  return { target_type: ref.kind === 'character' ? 'character' as const : 'scene' as const, target_ref: target, target_id: ref.id };
}
export function setMapping(db: DatabaseSync, subjectId: string, target: string): MotionMapping {
  const resolved = resolveTarget(db,subject(db,subjectId),target);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO motion_mappings VALUES (?,?,?,?,?,'owner',?,?) ON CONFLICT(subject_id) DO UPDATE SET
    target_type=excluded.target_type,target_ref=excluded.target_ref,target_id=excluded.target_id,source='owner',updated_at=excluded.updated_at`)
    .run(randomUUID(),subjectId,resolved.target_type,resolved.target_ref,resolved.target_id,now,now);
  return getEffectiveMapping(db,subjectId)!;
}
/** Call before any preview/render job or other credit-consuming operation. */
export function validateMappings(db: DatabaseSync, sourceVideoId: string): void {
  getSourceVideo(db,sourceVideoId);
  for (const row of listSubjects(db,sourceVideoId)) {
    const mapping = getEffectiveMapping(db,row.id);
    if (!mapping) throw new Error(`Missing mapping: ${row.subject_key}`);
    const resolved = resolveTarget(db,row,mapping.target_ref ?? mapping.target_type);
    if (resolved.target_type !== mapping.target_type || resolved.target_id !== mapping.target_id) throw new Error(`Stale mapping: ${mapping.target_ref}`);
  }
}
export interface AnalyzeSubjectsOptions { llm: LlmClient; frameCount?: number; frameExtractor?: typeof extractFrame; signal?: AbortSignal }
export async function analyzeSubjects(db: DatabaseSync, sourceVideoId: string, options: AnalyzeSubjectsOptions): Promise<MotionSubject[]> {
  const video = getSourceVideo(db,sourceVideoId);
  validateMappings(db,sourceVideoId);
  const count = options.frameCount ?? 3;
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new RangeError('frameCount must be 1..20');
  for (const segment of listSegments(db,sourceVideoId)) {
    const directory = projectDirectory(video.project_id);
    const frames = [];
    for (let i = 0; i < count; i++) {
      options.signal?.throwIfAborted();
      const end = Math.max(segment.start_sec, segment.end_sec - 1/video.fps);
      const time = count === 1 ? (segment.start_sec + end)/2 : segment.start_sec + (end-segment.start_sec)*i/(count-1);
      frames.push(await (options.frameExtractor ?? extractFrame)(directory,resolveInside(directory,video.stored_path),time,{ fileName: `${randomUUID()}.png` }));
    }
    const { value } = await generateValidated<MotionAnalysis>({ llm: options.llm, schema: MOTION_ANALYSIS_SCHEMA, signal: options.signal,
      system: 'Analyze motion sample images. Return JSON only. Keep subject_key stable with earlier subjects. Describe actions, camera, background, lighting and appearance.',
      prompt: JSON.stringify({ task: 'motion_subjects', frames, previous: listSubjects(db,sourceVideoId), schema: MOTION_ANALYSIS_SCHEMA }), timeoutMs: 120000 });
    if (new Set(value.subjects.map(s => s.subject_key)).size !== value.subjects.length) throw new Error('Invalid motion analysis: duplicate subject_key');
    const now = new Date().toISOString();
    db.exec('SAVEPOINT motion_analysis');
    try {
      for (const s of value.subjects) {
        // Conservative default: visible faces are hidden until the owner chooses otherwise.
        const target = s.has_human_face ? 'faceless' : 'keep';
        db.prepare(`INSERT INTO motion_subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id,subject_key) DO UPDATE SET
          kind=excluded.kind,description=excluded.description,motion_description=excluded.motion_description,composition=excluded.composition,
          has_human_face=excluded.has_human_face,ai_suggestion=excluded.ai_suggestion,analyzed_at=excluded.analyzed_at,updated_at=excluded.updated_at`)
          .run(randomUUID(),video.id,segment.id,s.subject_key,s.kind,s.description,s.motion_description,s.composition,Number(s.has_human_face),JSON.stringify({ ...s,target }),now,now,now);
        const row = db.prepare('SELECT id FROM motion_subjects WHERE segment_id=? AND subject_key=?').get(segment.id,s.subject_key)!;
        db.prepare(`INSERT INTO motion_mappings VALUES (?,?,?,NULL,NULL,'ai',?,?) ON CONFLICT(subject_id) DO UPDATE SET
          target_type=excluded.target_type,target_ref=NULL,target_id=NULL,updated_at=excluded.updated_at WHERE motion_mappings.source='ai'`)
          .run(randomUUID(),row.id,target,now,now);
      }
      db.prepare('UPDATE source_segments SET motion_analysis=? WHERE id=?').run(JSON.stringify(value),segment.id);
      db.exec('RELEASE motion_analysis');
    } catch (error) { db.exec('ROLLBACK TO motion_analysis'); db.exec('RELEASE motion_analysis'); throw error; }
  }
  return listSubjects(db,sourceVideoId);
}
