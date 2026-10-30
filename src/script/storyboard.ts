import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { split } from './split.ts';
import { getScriptVariant } from '../repo/scripts.ts';
import { buildRenderPlan, getRenderPlan } from '../render/plans.ts';
import type { RenderPlan } from '../render/plans.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { resolveInside } from '../paths.ts';
import { getProject } from '../repo/projects.ts';
import { segmentVideoFilter } from '../media/concat-segments.ts';


export class StoryboardGateError extends Error {}
export type Storyboard = { id: string; projectId: string; variantId: string; planId: string; inputHash: string;
  status: 'draft' | 'approved'; createdAt: string; approvedAt: string | null; shots: RenderPlan['steps'] };
export function initializeStoryboards(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS service_storyboards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    data TEXT NOT NULL)`);
}
export function getStoryboard(db: DatabaseSync, id: string): Storyboard | undefined {
  const row = db.prepare('SELECT data FROM service_storyboards WHERE id=?').get(id);
  return row ? JSON.parse(String(row.data)) : undefined;
}
function save(db: DatabaseSync, board: Storyboard): Storyboard {
  db.prepare('INSERT OR REPLACE INTO service_storyboards VALUES (?,?,?)').run(board.id, board.projectId, JSON.stringify(board));
  return board;
}
/** Regeneration always creates a fresh draft, never inherits owner approval. */
export function generateStoryboard(db: DatabaseSync, variantId: string, clock = () => new Date()): Storyboard {
  const variant = getScriptVariant(db, variantId);
  if (!variant || variant.status !== 'approved' || !variant.isActive) throw new StoryboardGateError('Approved active script required');
  if (!db.prepare('SELECT id FROM scenes WHERE script_variant_id=? LIMIT 1').get(variantId)) split(db, variantId);
  const plan = buildRenderPlan(db, variant.projectId);
  return save(db, { id: randomUUID(), projectId: variant.projectId, variantId, planId: plan.id,
    inputHash: plan.inputHash, shots: plan.steps, status: 'draft', createdAt: clock().toISOString(), approvedAt: null });
}
/** Pure, injectable execution plan: no subprocess, and no original image is overwritten. */
export function storyboardPreviewPlan(db: DatabaseSync, board: Storyboard, images: { sceneId: string; path: string; duration: number }[]) {
  const root = getProject(db, board.projectId)!.directory;
  if (images.length !== board.shots.length || board.shots.some(s => images.filter(i => i.sceneId === s.sceneId).length !== 1))
    throw new StoryboardGateError('One preview image required per shot');
  const args = ['-n'];
  const filters: string[] = [];
  board.shots.forEach((shot, index) => {
    const image = images.find(i => i.sceneId === shot.sceneId)!;
    if (!Number.isFinite(image.duration) || image.duration <= 0) throw new StoryboardGateError('Invalid preview duration');
    args.push('-loop', '1', '-t', String(image.duration), '-i', assertInsideDataDir(image.path, root));
    filters.push(segmentVideoFilter(index, 0, image.duration, 30, 1280, 720));
  });
  const path = resolveInside(root, `exports/storyboard-${randomUUID()}.mp4`);
  filters.push(board.shots.map((_, i) => `[v${i}]`).join('') + `concat=n=${board.shots.length}:v=1:a=0[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', path);
  return { path, args, timeoutMs: 300000 };
}
export function assertStoryboardCurrent(db: DatabaseSync, board: Storyboard): void {
  const variant = getScriptVariant(db, board.variantId);
  const latest = db.prepare('SELECT id FROM service_storyboards WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(board.projectId);
  if (latest?.id !== board.id || variant?.status !== 'approved' || !variant.isActive || buildRenderPlan(db, board.projectId).inputHash !== board.inputHash)
    throw new StoryboardGateError('Storyboard is stale; regenerate and approve');
}
export function approveStoryboard(db: DatabaseSync, board: Storyboard, clock = () => new Date()): Storyboard {
  assertStoryboardCurrent(db, board);
  return save(db, { ...board, status: 'approved', approvedAt: clock().toISOString() });
}
export function approvedStoryboardPlan(db: DatabaseSync, board: Storyboard): RenderPlan {
  if (board.status !== 'approved') throw new StoryboardGateError('Storyboard approval required');
  assertStoryboardCurrent(db, board);
  return getRenderPlan(db, board.planId)!;
}

