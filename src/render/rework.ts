import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Scene } from '../types.ts';
import { getScene, listScenes, updateScene } from '../repo/scenes.ts';
import { computeRedoScope } from '../prompt/scene-chains.ts';
import { estimateStepCredits, getRenderPlan } from './plans.ts';
import { getBible } from '../repo/bibles.ts';
import { BibleService } from '../prompt/bible.ts';
import { compileScene } from '../prompt/compiler.ts';
import { transaction } from '../repo/records.ts';

export function getReworkRequest(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM render_rework_requests WHERE id=?').get(id);
  if (!row) throw new Error('Rework request not found');
  return { id: String(row.id), planId: String(row.plan_id), sceneIds: JSON.parse(String(row.scene_ids)) as string[],
    estimatedCredits: Number(row.estimated_credits), takesPerScene: Number(row.takes_per_scene), state: String(row.state) };
}

/** Editing saves data only. Approval is a separate, explicit operation. */
export function requestSceneRework(db: DatabaseSync, planId: string, sceneId: string,
  patch: Partial<Pick<Scene, 'title' | 'prompt' | 'beat' | 'durationUsed' | 'moment' | 'camera' | 'action' | 'dialogue' | 'sfx' | 'charactersPresent' | 'location' | 'mode'>>,
  takesPerScene = 2) {
  const plan = getRenderPlan(db, planId);
  const before = getScene(db, sceneId);
  if (!plan || !before || !plan.steps.some(s => s.sceneId === sceneId)) throw new Error('Scene not in render plan');
  if (!Number.isSafeInteger(takesPerScene) || takesPerScene < 1) throw new Error('Invalid take count');
  updateScene(db, sceneId, patch);
  return transaction(db, () => {
    const scenes = listScenes(db, before.projectId, before.scriptVariantId);
    const chain = plan.steps.find(s => s.sceneId === sceneId)!.chainId;
    const sceneIds = computeRedoScope(scenes, sceneId).filter(id => plan.steps.some(s => s.sceneId === id && s.chainId === chain));
    const estimatedCredits = sceneIds.reduce((sum, id) => sum + estimateStepCredits(getScene(db, id)!) * takesPerScene, 0);
    const id = randomUUID();
    db.prepare(`INSERT INTO render_rework_requests
      (id,project_id,plan_id,scene_ids,estimated_credits,takes_per_scene,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, before.projectId, planId, JSON.stringify(sceneIds), estimatedCredits, takesPerScene, new Date().toISOString());
    return getReworkRequest(db, id);
  });
}

/** The accepted plan is consumed by runRenderPlan; only the approved steps are dirty. */
export function decideRework(db: DatabaseSync, id: string, accept: boolean) {
  const request = getReworkRequest(db, id);
  if (request.state !== 'awaiting_owner_approval') throw new Error('Rework already decided');
  if (accept) {
    const plan = getRenderPlan(db, request.planId)!;
    if (plan.steps.some(s => s.status !== 'done')) throw new Error('Rework requires a completed plan');
    const currentEstimate = request.sceneIds.reduce((sum, sceneId) => sum + estimateStepCredits(getScene(db, sceneId)!) * request.takesPerScene, 0);
    if (currentEstimate !== request.estimatedCredits) throw new Error('Rework estimate changed; request approval again');
    const bible = { style: '', lighting: '', palette: '', lens: '', safe_area: '', avoid: '',
      ...getBible(db, plan.projectId), entries: new BibleService(db).list(plan.projectId) };
    const compiled = request.sceneIds.map(sceneId => {
      const scene = getScene(db, sceneId)!;
      return { sceneId, prompt: compileScene(scene, bible, { maxReferenceImages: 3 }).prompt, credits: estimateStepCredits(scene) };
    });
    transaction(db, () => {
      for (const sceneId of request.sceneIds) {
        const step = compiled.find(s => s.sceneId === sceneId)!;
        db.prepare("UPDATE scenes SET status='can_lam_lai' WHERE id=?").run(sceneId);
        db.prepare('UPDATE render_plan_steps SET compiled_prompt=?,estimated_credits=?,needs_rerender=1 WHERE plan_id=? AND scene_id=?')
          .run(step.prompt, step.credits, plan.id, sceneId);
      }
      db.prepare("UPDATE render_rework_requests SET state='accepted' WHERE id=?").run(id);
    });
  } else db.prepare("UPDATE render_rework_requests SET state='rejected' WHERE id=?").run(id);
  return getReworkRequest(db, id);
}
