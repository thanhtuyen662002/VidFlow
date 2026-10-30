import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { extractFrame, cropLogoImage, probe } from '../media/index.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { dataDirectory } from '../paths.ts';
import { transaction } from '../repo/records.ts';
import { getReviewScene, resolveSelection, setOwnerOverride } from './orchestrator.ts';
import type { ReviewScene, TakeSelection } from './orchestrator.ts';

export async function resolveExitFrameTime(mediaPath: string, outPoint: number): Promise<number> {
  const info = await probe(mediaPath);
  if (outPoint < info.durationSec - 0.001) return outPoint;
  const frameDuration = Number.isFinite(info.fps) && info.fps > 0 ? 1 / info.fps : 1 / 30;
  return Math.round(Math.max(0, info.durationSec - frameDuration) * 1000) / 1000;
}

function rootForStep(db: DatabaseSync, stepId: string): string {
  const row = db.prepare(`SELECT p.directory FROM projects p JOIN render_plans rp ON rp.project_id=p.id
    JOIN render_plan_steps s ON s.plan_id=rp.id WHERE s.id=?`).get(stepId);
  if (!row) throw new Error('Render step not found');
  return assertInsideDataDir(String(row.directory), dataDirectory());
}

export function markNextFrameDirty(db: DatabaseSync, stepId: string, selected: TakeSelection): void {
  for (const next of nextContinueSteps(db, stepId)) {
    const previous = db.prepare('SELECT * FROM scene_start_frames WHERE step_id=? ORDER BY rowid DESC LIMIT 1').get(next.id);
    if (previous?.source_take_id === selected.takeId && previous.out_point === selected.outPoint) continue;
    db.prepare(`WITH RECURSIVE affected(id) AS (SELECT ? UNION ALL
      SELECT s.id FROM render_plan_steps s JOIN affected a ON s.depends_on_step_id=a.id
      JOIN scenes sc ON sc.id=s.scene_id WHERE sc.transition='continue')
      UPDATE render_plan_steps SET needs_rerender=1 WHERE id IN (SELECT id FROM affected)`).run(next.id);
  }
}

function nextContinueSteps(db: DatabaseSync, stepId: string) {
  return db.prepare(`SELECT s.id FROM render_plan_steps s JOIN scenes sc ON sc.id=s.scene_id
    WHERE s.depends_on_step_id=? AND sc.transition='continue'`).all(stepId);
}

async function prepareFrame(db: DatabaseSync, stepId: string, scene: ReviewScene, selected: TakeSelection) {
  const root = rootForStep(db, stepId);
  const take = scene.takes.find(t => t.id === selected.takeId)!;
  const media = assertInsideDataDir(assertInsideDataDir(take.file, dataDirectory()), root);
  const effectiveTime = await resolveExitFrameTime(media, selected.outPoint);
  const raw = await extractFrame(root, media, effectiveTime, { fileName: `${randomUUID()}.png` });
  const cropped = await cropLogoImage(root, raw.path, { fileName: `${randomUUID()}.png` });
  return { path: cropped.path, sha256: createHash('sha256').update(await readFile(cropped.path)).digest('hex'), effectiveTime };
}

export function saveStartFrame(db: DatabaseSync, stepId: string, selected: TakeSelection,
  frame: { path: string; sha256: string; effectiveTime: number | null }): void {
  db.prepare(`INSERT INTO scene_start_frames(id,step_id,source_take_id,out_point,file,sha256,created_at,effective_time_sec)
    VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), stepId, selected.takeId, selected.outPoint,
      frame.path, frame.sha256, new Date().toISOString(), frame.effectiveTime);
}

export async function buildStartFrame(db: DatabaseSync, stepId: string): Promise<string> {
  const step = db.prepare('SELECT depends_on_step_id FROM render_plan_steps WHERE id=?').get(stepId);
  if (!step?.depends_on_step_id) throw new Error('Render step has no previous scene');
  const sourceId = String(step.depends_on_step_id);
  const scene = getReviewScene(db, sourceId);
  const selected = resolveSelection(scene);
  const frame = await prepareFrame(db, stepId, scene, selected);
  transaction(db, () => { markNextFrameDirty(db, sourceId, selected); saveStartFrame(db, stepId, selected, frame); });
  return frame.path;
}

export async function setOwnerOverrideAndRefresh(db: DatabaseSync, stepId: string,
  override: Partial<TakeSelection>): Promise<void> {
  const scene = getReviewScene(db, stepId);
  for (const key of Object.keys(override)) if (!['takeId', 'inPoint', 'outPoint'].includes(key)) throw new Error('Unknown override field');
  const proposed = { ...scene, override };
  const selected = resolveSelection(proposed);
  const next = nextContinueSteps(db, stepId);
  const frames = [];
  for (const step of next) frames.push({ stepId: String(step.id), frame: await prepareFrame(db, String(step.id), proposed, selected) });
  transaction(db, () => {
    setOwnerOverride(db, stepId, override);
    db.prepare('INSERT INTO render_override_history VALUES (?,?,?,?)')
      .run(randomUUID(), stepId, JSON.stringify(override), new Date().toISOString());
    markNextFrameDirty(db, stepId, selected);
    for (const item of frames) saveStartFrame(db, item.stepId, selected, item.frame);
  });
}

export async function updateSelectionAndRefresh(db: DatabaseSync, stepId: string, selected: TakeSelection): Promise<void> {
  await setOwnerOverrideAndRefresh(db, stepId, selected);
}
