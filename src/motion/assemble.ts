import type { DatabaseSync } from 'node:sqlite';
import type { LlmClient } from '../script/llm/types.ts';
import { projectDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { probe } from '../media/probe.ts';
import { stretchVideo, joinTimedVideos, muxSourceAudio, discloseVideo } from '../edit/export.ts';
import { getMotionState } from './render.ts';
import type { MotionState } from './render.ts';
import { getSourceVideo, listSegments } from './source-import.ts';
import { motionMedia } from './render-media.ts';
import { configHash } from './preset-config.ts';

type Review = NonNullable<MotionState['reviews']>[string];
export function parseMotionReview(text: string): Review {
  const data = JSON.parse(text);
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
    Object.keys(data).some(k => !['score', 'face_detected', 'human_face'].includes(k)) ||
    typeof data.score !== 'number' || !Number.isFinite(data.score) || data.score < 0 || data.score > 100 ||
    (typeof data.face_detected !== 'boolean' && typeof data.human_face !== 'boolean') ||
    ('face_detected' in data && typeof data.face_detected !== 'boolean') ||
    ('human_face' in data && typeof data.human_face !== 'boolean') ||
    ('face_detected' in data && 'human_face' in data && data.face_detected !== data.human_face))
    throw new Error('Invalid motion review JSON: require score 0..100 and boolean face_detected');
  return { score: data.score, face_detected: data.face_detected ?? data.human_face };
}

export function chooseMotionVariant(state: MotionState, faceless: boolean): string {
  if (state.ownerVariantId) {
    if (!state.variants.some(v => v.id === state.ownerVariantId)) throw new Error('Owner candidate is missing');
    return state.ownerVariantId;
  }
  const candidates = state.variants.map((v, index) => ({ v, index, review: state.reviews?.[v.id] }))
    .filter(c => c.review && !c.review.error && c.review.score !== undefined && (!faceless || c.review.face_detected === false))
    .sort((a, b) => b.review!.score! - a.review!.score! || a.index - b.index);
  if (!candidates.length) throw new Error('Needs re-render or owner review: no valid candidate satisfies the face policy');
  return candidates[0].v.id;
}

function save(db: DatabaseSync, segmentId: string, state: MotionState) {
  db.prepare('UPDATE render_jobs SET motion_state=? WHERE source_segment_id=?').run(JSON.stringify(state), segmentId);
}
export interface ReviewMotionOptions {
  llm: LlmClient;
  media?: ReturnType<typeof motionMedia>;
}
export async function reviewMotion(db: DatabaseSync, sourceVideoId: string, options: ReviewMotionOptions) {
  const source = getSourceVideo(db, sourceVideoId), root = projectDirectory(source.project_id);
  const row = db.prepare(`SELECT p.config FROM motion_style_approvals a JOIN motion_presets p ON p.id=a.preset_id
    WHERE a.source_video_id=?`).get(sourceVideoId);
  if (!row) throw new Error('Motion preset is missing');
  const preset = JSON.parse(String(row.config));
  const media = options.media ?? motionMedia(root);
  for (const segment of listSegments(db, sourceVideoId)) {
    const state = getMotionState(db, segment.id);
    if (!state || state.status !== 'done') throw new Error(`Unfinished motion segment: ${segment.id}`);
    const reviewKey = configHash({ variants: state.variants, preset });
    if (state.reviewKey !== reviewKey) { state.reviews = {}; state.reviewKey = reviewKey; }
    state.reviews ??= {};
    for (const candidate of state.variants) {
      if (state.reviews[candidate.id]) continue;
      assertInsideDataDir(candidate.file, root);
      const comparisons = [];
      for (const fraction of [0, 1]) {
        const time = fraction === 1 ? 'last' : fraction * (segment.end_sec - segment.start_sec);
        const original = await media.frame(resolveInside(root, source.stored_path),
          segment.start_sec + fraction * Math.max(0, segment.end_sec - segment.start_sec - 1 / source.fps));
        comparisons.push(await media.comparison(original, await media.frame(candidate.file, time)));
      }
      try {
        const result = await options.llm.complete({ system: 'Review original and generated frames side by side. Return only JSON: {"score":number 0..100,"face_detected":boolean}. Evaluate motion, subject consistency, style, background, hand/face defects and visible human faces.',
          prompt: JSON.stringify({ task: 'motion_review', segment, candidate, preset, comparisons }), timeoutMs: 120000 });
        state.reviews[candidate.id] = parseMotionReview(result.text);
      } catch { state.reviews[candidate.id] = { error: 'Unreviewable: invalid or unavailable LLM response' }; }
      state.ownerVariantId = getMotionState(db, segment.id)?.ownerVariantId;
      save(db, segment.id, state);
    }
    // Reload so an owner choice made during the LLM request wins.
    const current = getMotionState(db, segment.id)!;
    state.ownerVariantId = current.ownerVariantId;
    try { state.selectedVariantId = chooseMotionVariant(state, preset.faceless === true); }
    catch (error) {
      state.status = 'needs_rerender'; state.reviewFailure = (error as Error).message;
      delete state.selectedVariantId; save(db, segment.id, state); throw error;
    }
    save(db, segment.id, state);
  }
}

async function valid(path: string | undefined, duration: number, fps: number, root: string) {
  if (!path) return false;
  assertInsideDataDir(path, resolveInside(root, 'exports'));
  try { const info = await probe(path); return Math.abs(info.durationSec - duration) <= 1 / fps + 1e-6 && Math.abs(info.fps - fps) < 1e-5; }
  catch { return false; }
}

/** Consumes M10.5 checkpoints only; never dispatches paid Flow work. */
export async function assembleMotion(db: DatabaseSync, sourceVideoId: string, options: ReviewMotionOptions & {
  keepOriginalAudio?: boolean;
  afterStretch?: (segmentId: string) => void | Promise<void>;
}) {
  await reviewMotion(db, sourceVideoId, options);
  const source = getSourceVideo(db, sourceVideoId), segments = listSegments(db, sourceVideoId);
  if (!segments.length) throw new Error('No source segments');
  let endFrame = 0;
  for (const segment of segments) {
    if (segment.start_frame !== endFrame || segment.end_frame - segment.start_frame !== segment.frame_count)
      throw new Error('Source segments must be contiguous in original order');
    endFrame = segment.end_frame;
  }
  if (Math.abs(endFrame / source.fps - source.duration_sec) > 1 / source.fps + 1e-6)
    throw new Error('Source segments do not cover the original duration');
  const root = projectDirectory(source.project_id), sourcePath = resolveInside(root, source.stored_path);
  const paths: string[] = [];
  for (const segment of segments) {
    const state = getMotionState(db, segment.id)!;
    const candidate = state.variants.find(v => v.id === state.selectedVariantId)!;
    const key = configHash({ candidate, segment, fps: source.fps });
    if (state.assembly?.key !== key) state.assembly = { key };
    if (!await valid(state.assembly.stretched, segment.frame_count / source.fps, source.fps, root)) {
      state.assembly.stretched = await stretchVideo(root, candidate.file, segment.frame_count, source.fps);
      save(db, segment.id, state);
      await options.afterStretch?.(segment.id);
    }
    paths.push(state.assembly.stretched!);
  }
  const first = getMotionState(db, segments[0].id)!;
  const key = configHash({ paths, audio: options.keepOriginalAudio === true, source: source.sha256 });
  // Global steps live alongside the first segment's per-step checkpoint.
  const step = `assembly:${key}`;
  const checkpoint = first.steps;
  if (!await valid(checkpoint[`${step}:joined`]?.[0], source.duration_sec, source.fps, root)) {
    checkpoint[`${step}:joined`] = [await joinTimedVideos(root, paths, source.fps, source.width, source.height)];
    save(db, segments[0].id, first);
  }
  if (!await valid(checkpoint[`${step}:muxed`]?.[0], source.duration_sec, source.fps, root)) {
    checkpoint[`${step}:muxed`] = [await muxSourceAudio(root, checkpoint[`${step}:joined`][0], sourcePath,
      options.keepOriginalAudio === true, source.duration_sec)];
    save(db, segments[0].id, first);
  }
  const output = checkpoint[`${step}:muxed`][0];
  if (output.toLowerCase() === sourcePath.toLowerCase() || output.toLowerCase() === resolveInside(root, source.original_path).toLowerCase()) throw new Error('Export would overwrite source');
  if (!await valid(output, source.duration_sec, source.fps, root)) throw new Error('Final duration differs from source by more than one frame');
  await discloseVideo(root, output);
  checkpoint[`${step}:exported`] = [output]; save(db, segments[0].id, first);
  return { path: output, disclosurePath: `${output}.ai-disclosure.json` };
}
