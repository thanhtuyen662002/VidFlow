import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { enqueueJob, getJob } from '../flow/queue.ts';
import { createScheduler } from '../flow/scheduler.ts';
import { editVideo, generateFrameImage } from '../flow/driver.ts';
import type { FlowDriverContext, VideoEditJob, FrameImageJob, MotionResult } from '../flow/driver.ts';
import type { FlowJobDriver, WorkerJob } from '../flow/jobDriver.ts';
import { transaction } from '../repo/records.ts';
import { canDispatch, projectCommittedCredits } from '../render/budget.ts';
import { projectDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { MotionStyleService } from './style-service.ts';
import { getSourceVideo, listSegments } from './source-import.ts';
import { motionMedia } from './render-media.ts';

export type MotionMode = 'video_edit' | 'frames_then_video';
export const motionStatusLabels = { awaiting_budget_approval: 'chờ duyệt ngân sách',
  needs_rerender: 'cần duyệt render lại', pending: 'đang chờ', rendering: 'đang render', done: 'hoàn tất' };
type Command = { segmentId: string; prompt: string; references: { image: string; kind: string }[] };
export interface MotionPayload {
  kind: 'motion'; sourceSegmentId: string; sourceVideoId: string; projectId: string;
  sceneId: number; segmentOrder: number; compiledCommand: Command; compiledCommandReference: string;
  approvalHash: string; mode: MotionMode; variants: number; estimatedCredits: number;
}
export interface MotionState {
  status: 'pending' | 'rendering' | 'done' | 'awaiting_budget_approval' | 'needs_rerender';
  steps: Record<string, string[]>; operations: { step: string; jobId: string }[];
  variants: { id: string; file: string; aiGenerated: true }[]; selectedVariantId?: string;
  chainInFrame?: string; chainInFrameSha256?: string; chainOutFrame?: string; chainOutFrameSha256?: string;
  generation: number;
  ownerVariantId?: string;
  reviews?: Record<string, { score?: number; face_detected?: boolean; error?: string }>;
  reviewKey?: string;
  reviewFailure?: string;
  assembly?: { key: string; stretched?: string; joined?: string; muxed?: string; exported?: string };
}
const fresh = (): MotionState => ({ status: 'pending', steps: {}, operations: [], variants: [], generation: 0 });
export function getMotionState(db: DatabaseSync, segmentId: string): MotionState | undefined {
  const row = db.prepare('SELECT motion_state FROM render_jobs WHERE source_segment_id=?').get(segmentId);
  return row?.motion_state ? JSON.parse(String(row.motion_state)) : undefined;
}
function save(db: DatabaseSync, id: string, state: MotionState) {
  db.prepare('UPDATE render_jobs SET motion_state=? WHERE id=?').run(JSON.stringify(state), id);
}
async function hash(file: string) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

export function enqueueMotionJobs(db: DatabaseSync, sourceVideoId: string, options: {
  style?: MotionStyleService; mode?: MotionMode; fallbackImageCredits?: number;
} = {}) {
  const style = options.style ?? new MotionStyleService(db);
  const approval = style.getStyleApproval(sourceVideoId);
  if (approval?.status !== 'approved') throw new Error('STYLE_NOT_APPROVED');
  const summary = JSON.parse(approval.summary), video = getSourceVideo(db, sourceVideoId);
  const segments = listSegments(db, sourceVideoId);
  const totalSeconds = segments.reduce((sum, s) => sum + s.end_sec - s.start_sec, 0);
  const mode = options.mode ?? 'video_edit';
  if (!['video_edit', 'frames_then_video'].includes(mode)) throw new Error('Invalid motion mode');
  const imageCost = options.fallbackImageCredits ?? 4;
  if (!Number.isSafeInteger(imageCost) || imageCost < 0) throw new Error('Invalid image cost');
  return transaction(db, () => segments.map(segment => {
    const previous = db.prepare('SELECT * FROM render_jobs WHERE source_segment_id=?').get(segment.id);
    if (previous) return previous;
    const command = (summary.prompts as Command[]).find(c => c.segmentId === segment.id);
    if (!command) throw new Error(`Missing compiled command: ${segment.id}`);
    const payload: MotionPayload = { kind: 'motion', sourceSegmentId: segment.id, sourceVideoId,
      projectId: video.project_id, sceneId: segment.scene_index, segmentOrder: segment.idx,
      compiledCommand: command, compiledCommandReference: `${sourceVideoId}:${approval.input_hash}:${segment.id}`,
      approvalHash: approval.input_hash, mode, variants: summary.variants,
      estimatedCredits: (summary.segmentEstimates?.find((e: { segmentId: string }) => e.segmentId === segment.id)?.credits
        ?? Math.ceil(Number(approval.credit_estimate) * (segment.end_sec - segment.start_sec) / totalSeconds))
        + (mode === 'frames_then_video' ? imageCost * 2 : 0) };
    const row = enqueueJob(db, payload, { projectId: video.project_id, priority: -segment.idx });
    db.prepare("UPDATE render_jobs SET type='motion',source_segment_id=?,motion_state=?,prompt=? WHERE id=?")
      .run(segment.id, JSON.stringify(fresh()), command.prompt, row.id);
    return getJob(db, String(row.id))!;
  }));
}

export function selectVariant(db: DatabaseSync, segmentId: string, variantId: string) {
  transaction(db, () => {
    const row = db.prepare('SELECT * FROM render_jobs WHERE source_segment_id=?').get(segmentId);
    if (!row) throw new Error('Motion segment not queued');
    if (row.status === 'running') throw new Error('Stop the worker before changing a running segment selection');
    const state = getMotionState(db, segmentId)!;
    if (!state.variants.some(v => v.id === variantId)) throw new Error('Variant must belong to segment');
    state.ownerVariantId = variantId;
    if (state.reviewFailure) { state.status = 'done'; delete state.reviewFailure; }
    if (state.selectedVariantId === variantId) { save(db, String(row.id), state); return; }
    state.selectedVariantId = variantId;
    delete state.chainOutFrame; delete state.chainOutFrameSha256;
    delete state.steps.exitFrame;
    save(db, String(row.id), state);
    const payload: MotionPayload = JSON.parse(String(row.payload));
    const successors = db.prepare(`SELECT * FROM render_jobs WHERE source_segment_id IS NOT NULL
      AND json_extract(payload,'$.sourceVideoId')=? AND json_extract(payload,'$.sceneId')=?
      AND json_extract(payload,'$.segmentOrder')>? ORDER BY json_extract(payload,'$.segmentOrder')`)
      .all(payload.sourceVideoId, payload.sceneId, payload.segmentOrder);
    for (const next of successors) {
      if (next.status === 'running') throw new Error('Stop the worker before changing an upstream selection');
      const dirty: MotionState = JSON.parse(String(next.motion_state));
      delete dirty.chainInFrame; delete dirty.chainInFrameSha256;
      dirty.status = 'needs_rerender';
      save(db, String(next.id), dirty);
    }
  });
}
/** Owner explicitly acknowledges the invalidated chain before paid re-rendering. */
export function approveMotionRerender(db: DatabaseSync, segmentId: string) {
  const row = db.prepare('SELECT * FROM render_jobs WHERE source_segment_id=?').get(segmentId);
  const state = getMotionState(db, segmentId);
  if (!row || state?.status !== 'needs_rerender') throw new Error('No motion re-render pending');
  const next = fresh(); next.generation = state.generation + 1;
  next.variants = state.variants;
  save(db, String(row.id), next);
  db.prepare("UPDATE render_jobs SET status='queued',attempts=0,worker_id=NULL,account_id=NULL WHERE id=?").run(row.id);
  db.prepare('DELETE FROM render_credit_reservations WHERE job_id=?').run(row.id);
}
export function approveMotionBudget(db: DatabaseSync, projectId: string, budget: number) {
  if (!Number.isSafeInteger(budget) || budget < projectCommittedCredits(db, projectId)) throw new Error('Invalid approved budget');
  db.prepare("UPDATE projects SET budget=?,status='rendering' WHERE id=?").run(budget, projectId);
  for (const row of db.prepare('SELECT id,motion_state FROM render_jobs WHERE project_id=? AND source_segment_id IS NOT NULL').all(projectId)) {
    const state: MotionState = JSON.parse(String(row.motion_state));
    if (state.status === 'awaiting_budget_approval') { state.status = 'pending'; save(db, String(row.id), state); }
  }
}

export interface MotionDependencies {
  db: DatabaseSync; style?: MotionStyleService;
  context: (accountId: string) => FlowDriverContext;
  media?: ReturnType<typeof motionMedia>;
  edit?: (job: VideoEditJob, context: FlowDriverContext) => Promise<MotionResult>;
  image?: (job: FrameImageJob, context: FlowDriverContext) => Promise<MotionResult>;
}
export function motionCoordinator(options: MotionDependencies) {
  const { db } = options, style = options.style ?? new MotionStyleService(db);
  const approved = (p: MotionPayload) => {
    const approval = style.getStyleApproval(p.sourceVideoId);
    return approval?.status === 'approved' && approval.input_hash === p.approvalHash;
  };
  function canRun(job: WorkerJob) {
    const p: MotionPayload = JSON.parse(job.payload);
    if (typeof p.sourceSegmentId !== 'string' || typeof p.sourceVideoId !== 'string') return false;
    if (db.prepare('SELECT source_segment_id FROM render_jobs WHERE id=?').get(job.id)?.source_segment_id !== p.sourceSegmentId) return false;
    const state = getMotionState(db, p.sourceSegmentId)!;
    if (!approved(p) || !state || state.status === 'needs_rerender') return false;
    const previous = listSegments(db, p.sourceVideoId).filter(s => s.scene_index === p.sceneId && s.idx < p.segmentOrder).at(-1);
    if (previous) { const prior = getMotionState(db, previous.id); if (prior?.status !== 'done' || !prior.selectedVariantId) return false; }
    // Repair reservation checkpoints if the process stopped just after M10.1's
    // atomic charge/output commit and before the parent's state write.
    for (const row of db.prepare(`SELECT j.id,j.payload,j.motion_state FROM render_jobs j
      JOIN render_credit_reservations r ON r.job_id=j.id WHERE j.project_id=? AND j.source_segment_id IS NOT NULL`).all(p.projectId)) {
      const progress: MotionState = JSON.parse(String(row.motion_state));
      const spent = progress.operations.reduce((sum, op) => sum + Number(db.prepare(
        'SELECT COALESCE(SUM(MAX(0,-amount)),0) AS cost FROM credit_ledger WHERE job_id=?').get(op.jobId)!.cost), 0);
      db.prepare('UPDATE render_credit_reservations SET credits=? WHERE job_id=?')
        .run(Math.max(0, JSON.parse(String(row.payload)).estimatedCredits - spent), row.id);
    }
    const remaining = db.prepare(`SELECT payload FROM render_jobs WHERE project_id=? AND source_segment_id IS NOT NULL
      AND status!='done' AND NOT EXISTS(SELECT 1 FROM render_credit_reservations r WHERE r.job_id=render_jobs.id)`).all(p.projectId)
      .reduce((sum, r) => sum + JSON.parse(String(r.payload)).estimatedCredits, 0);
    if (!canDispatch(db, p.projectId, remaining)) {
      state.status = 'awaiting_budget_approval'; save(db, job.id, state);
      db.prepare("UPDATE projects SET status='awaiting_budget_approval' WHERE id=?").run(p.projectId);
      return false;
    }
    return true;
  }
  const driver: FlowJobDriver = { async run(job, account) {
    const p: MotionPayload = JSON.parse(job.payload);
    if (!approved(p)) return { kind: 'refused', reason: 'STYLE_NOT_APPROVED' };
    const state = getMotionState(db, p.sourceSegmentId)!;
    if (state.status === 'needs_rerender') return { kind: 'refused', reason: 'CHAIN_REQUIRES_OWNER_APPROVAL' };
    const root = projectDirectory(p.projectId), media = options.media ?? motionMedia(root);
    const persist = () => save(db, job.id, state);
    const safe = (file: string) => assertInsideDataDir(file, resolveInside(root, 'renders'));
    const derived = (file: string) => assertInsideDataDir(file, resolveInside(root, 'frames/motion'));
    async function local(key: string, work: () => Promise<string>) {
      if (!state.steps[key]) { state.steps[key] = [derived(await work())]; persist(); }
      return state.steps[key][0];
    }
    const outputDir = resolveInside(root, `renders/motion/${p.sourceSegmentId}`);
    await mkdir(outputDir, { recursive: true });
    db.prepare('INSERT OR IGNORE INTO render_credit_reservations(job_id,project_id,credits) VALUES (?,?,?)')
      .run(job.id, p.projectId, p.estimatedCredits);
    state.status = 'rendering'; persist();
    const segment = listSegments(db, p.sourceVideoId).find(s => s.id === p.sourceSegmentId)!;
    const source = getSourceVideo(db, p.sourceVideoId);
    const references: VideoEditJob['references'] = {};
    for (const ref of p.compiledCommand.references) {
      const role = ref.kind === 'location' ? 'setting' : ref.kind === 'style' ? 'style' : 'character';
      (references[role] ??= []).push(assertInsideDataDir(isAbsolute(ref.image) ? ref.image : resolveInside(root, ref.image), root));
    }
    const previous = listSegments(db, p.sourceVideoId).filter(s => s.scene_index === p.sceneId && s.idx < p.segmentOrder).at(-1);
    if (previous) {
      const prior = getMotionState(db, previous.id)!;
      if (prior.status !== 'done' || !prior.selectedVariantId) throw new Error('Previous segment is unfinished');
      const selected = prior.variants.find(v => v.id === prior.selectedVariantId)!;
      if (!prior.chainOutFrame) {
        prior.chainOutFrame = derived(await media.crop(await media.frame(selected.file, 'last')));
        prior.chainOutFrameSha256 = await hash(prior.chainOutFrame);
        const row = db.prepare('SELECT id FROM render_jobs WHERE source_segment_id=?').get(previous.id)!;
        save(db, String(row.id), prior);
      }
      state.chainInFrame = prior.chainOutFrame; state.chainInFrameSha256 = prior.chainOutFrameSha256; persist();
      references.first_frame = [state.chainInFrame];
    }
    const clip = await local('sourceClip', () => media.clip(resolveInside(root, source.stored_path), segment.start_sec, segment.end_sec));
    async function flow(key: string, frameKind?: 'first_frame' | 'last_frame') {
      if (state.steps[key]) return state.steps[key];
      let operation = state.operations.find(o => o.step === key);
      if (!operation) {
        transaction(db, () => {
          const child = enqueueJob(db, { internalMotionStep: true, parentId: job.id, generation: state.generation,
            step: key, kind: frameKind ? 'image' : 'video' }, { projectId: p.projectId });
          operation = { step: key, jobId: String(child.id) }; state.operations.push(operation); persist();
        });
      }
      const child = getJob(db, operation!.jobId)!;
      let files: string[];
      if (child.output_media) files = JSON.parse(String(child.output_media));
      else {
        if (!approved(p)) throw new Error('STYLE_NOT_APPROVED');
        const base = { id: operation!.jobId, projectId: p.projectId, accountId: account.id, prompt: p.compiledCommand.prompt,
          outputDir: resolveInside(outputDir, randomUUID()), references };
        const result = frameKind
          ? await (options.image ?? generateFrameImage)({ ...base, frameKind }, options.context(account.id))
          : await (options.edit ?? editVideo)({ ...base, sourceVideo: clip, variants: p.variants }, options.context(account.id));
        if (result.kind !== 'completed') {
          if (result.kind === 'verification_required' || result.kind === 'out_of_credits') return result;
          throw new Error(`Flow operation ${result.kind}`);
        }
        files = result.files.map(safe);
        db.prepare("UPDATE render_jobs SET output_media=?,status='done' WHERE id=?").run(JSON.stringify(files), operation!.jobId);
      }
      state.steps[key] = files; persist();
      // Child operations carry actual charges; the parent's reservation covers
      // only the unspent estimate so the shared M6 budget never counts twice.
      const spent = state.operations.reduce((sum, op) => sum + Number(db.prepare(
        'SELECT COALESCE(SUM(MAX(0,-amount)),0) AS cost FROM credit_ledger WHERE job_id=?').get(op.jobId)!.cost), 0);
      db.prepare('UPDATE render_credit_reservations SET credits=? WHERE job_id=?').run(Math.max(0, p.estimatedCredits - spent), job.id);
      return files;
    }
    if (p.mode === 'frames_then_video') {
      for (const kind of ['first_frame', 'last_frame'] as const) {
        // Original segment keyframes provide composition and motion endpoints.
        const sourceFrame = await local(`source-${kind}`, () => media.frame(clip, kind === 'first_frame' ? 0 : 'last'));
        references.style = [...(references.style ?? []), sourceFrame];
        const result = await flow(kind, kind);
        references.style.pop();
        if (!Array.isArray(result)) return { kind: result.kind === 'verification_required' ? 'verification_required' : 'out_of_credit' };
        const cropped = await local(`crop-${kind}`, () => media.crop(result[0]));
        if (kind === 'last_frame' || !state.chainInFrame) references[kind] = [cropped];
      }
    }
    const result = await flow('video');
    if (!Array.isArray(result)) return { kind: result.kind === 'verification_required' ? 'verification_required' : 'out_of_credit' };
    const variants = result.map((file, i) => ({ id: `${job.id}-${state.generation}-${i}`, file, aiGenerated: true as const }));
    for (const variant of variants) if (!state.variants.some(v => v.id === variant.id)) state.variants.push(variant);
    state.selectedVariantId ??= variants[0]?.id;
    if (!state.selectedVariantId) throw new Error('Flow returned no variant');
    state.status = 'done'; persist();
    return { kind: 'success', media: await Promise.all(state.variants.map(async v => ({ path: v.file, kind: 'video' as const, bytes: (await stat(v.file)).size }))) };
  } };
  return { canDispatch: canRun, driver };
}

/** Uses the existing M5/M6 worker loop, claim logic, account selection and retries. */
export function createMotionDispatcher(options: MotionDependencies & { driver: FlowJobDriver; timeoutMs?: number }) {
  // Restart recovery is explicit: call only after the old process has stopped.
  options.db.prepare(`UPDATE render_jobs SET status='queued',worker_id=NULL,account_id=NULL
    WHERE source_segment_id IS NOT NULL AND status='running'`).run();
  return createScheduler({ queue: options.db, accounts: options.db, driver: options.driver,
    timeoutMs: options.timeoutMs, motion: motionCoordinator(options) });
}

/** Image preview is allowed before approval and never enqueues a video job. */
export async function completeVisualPreview(options: MotionDependencies & { sourceVideoId: string; accountId: string }) {
  const { db, sourceVideoId } = options;
  const style = options.style ?? new MotionStyleService(db);
  const approval = style.getStyleApproval(sourceVideoId);
  if (!approval || approval.credit_estimate === null) throw new Error('Create style preview first');
  const summary = JSON.parse(approval.summary);
  if (summary.visualPreview?.status === 'ready') return summary.visualPreview;
  const source = getSourceVideo(db, sourceVideoId), root = projectDirectory(source.project_id);
  const media = options.media ?? motionMedia(root), segment = listSegments(db, sourceVideoId)[0];
  const command: Command = summary.prompts.find((c: Command) => c.segmentId === segment.id);
  const child = db.prepare(`SELECT * FROM render_jobs WHERE json_extract(payload,'$.preview')=?
    AND json_extract(payload,'$.inputHash')=? ORDER BY created_at LIMIT 1`).get(sourceVideoId, approval.input_hash)
    ?? enqueueJob(db, { internalMotionStep: true, kind: 'image', preview: sourceVideoId, inputHash: approval.input_hash,
      steps: {} }, { projectId: source.project_id });
  const progress = JSON.parse(String(child.payload));
  const safe = (file: string) => assertInsideDataDir(file, resolveInside(root, 'renders'));
  const derived = (file: string) => assertInsideDataDir(file, resolveInside(root, 'frames/motion'));
  async function step(key: string, work: () => Promise<string>) {
    if (!progress.steps[key]) {
      progress.steps[key] = derived(await work());
      db.prepare('UPDATE render_jobs SET payload=? WHERE id=?').run(JSON.stringify(progress), child.id);
    }
    return progress.steps[key] as string;
  }
  const original = await step('original', () => media.frame(resolveInside(root, source.stored_path), segment.start_sec));
  const references: VideoEditJob['references'] = { first_frame: [original] };
  for (const ref of command.references) {
    const role = ref.kind === 'location' ? 'setting' : ref.kind === 'style' ? 'style' : 'character';
    (references[role] ??= []).push(assertInsideDataDir(isAbsolute(ref.image) ? ref.image : resolveInside(root, ref.image), root));
  }
  let files: string[] = child.output_media ? JSON.parse(String(child.output_media)) : [];
  if (!files.length) {
    const result = await (options.image ?? generateFrameImage)({ id: String(child.id), projectId: source.project_id,
      accountId: options.accountId, prompt: command.prompt, outputDir: resolveInside(root, `renders/motion/preview/${randomUUID()}`),
      frameKind: 'first_frame', references }, options.context(options.accountId));
    if (result.kind !== 'completed') throw new Error(`Visual preview ${result.kind}`);
    files = result.files.map(safe);
    db.prepare('UPDATE render_jobs SET output_media=? WHERE id=?').run(JSON.stringify(files), child.id);
  }
  const transformed = await step('transformed', () => media.crop(files[0]));
  const comparison = await step('comparison', () => media.comparison(original, transformed));
  const preview = { status: 'ready', original, transformed, comparison, sha256: await hash(comparison),
    originalSha256: await hash(original), transformedSha256: await hash(transformed), aiGenerated: true,
    disclosure: 'This content is AI-generated.' };
  if (style.getStyleApproval(sourceVideoId)?.input_hash !== approval.input_hash) throw new Error('Style changed during preview');
  summary.visualPreview = preview;
  db.prepare('UPDATE motion_style_approvals SET summary=? WHERE source_video_id=?').run(JSON.stringify(summary), sourceVideoId);
  db.prepare("UPDATE render_jobs SET status='done' WHERE id=?").run(child.id);
  return preview;
}
