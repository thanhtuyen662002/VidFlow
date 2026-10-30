import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Scene } from '../types.ts';
import { transaction } from '../repo/records.ts';
import { getScene } from '../repo/scenes.ts';
import { getBible } from '../repo/bibles.ts';
import { BibleService } from '../prompt/bible.ts';
import { compileScene } from '../prompt/compiler.ts';

export type RenderStepStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';
export type RenderPlanStep = {
  id: string; planId: string; sceneId: string; chainId: string; chainIndex: number;
  dependsOnStepId: string | null; compiledPrompt: string; estimatedCredits: number;
  status: RenderStepStatus; updatedAt: string;
};
export type RenderPlan = {
  id: string; projectId: string; inputHash: string; status: 'ready';
  estimatedCredits: number; createdAt: string; updatedAt: string; steps: RenderPlanStep[];
};

// Planning allowance for one fast-model generation per started 8-second unit.
// M5 measures actual charges after generation; this is an estimate, not a tariff.
export const FAST_RENDER_CREDITS_PER_8_SECONDS = 20;
export function estimateStepCredits(scene: Pick<Scene, 'durationUsed'>): number {
  if (!Number.isFinite(scene.durationUsed) || scene.durationUsed < 0) throw new Error('Invalid scene duration');
  const cost = Math.max(1, Math.ceil(scene.durationUsed / 8)) * FAST_RENDER_CREDITS_PER_8_SECONDS;
  if (!Number.isSafeInteger(cost)) throw new Error('Credit estimate exceeds safe integer range');
  return cost;
}

const stepSelect = `SELECT id, plan_id AS planId, scene_id AS sceneId, chain_id AS chainId,
 chain_index AS chainIndex, depends_on_step_id AS dependsOnStepId, compiled_prompt AS compiledPrompt,
 estimated_credits AS estimatedCredits, status, updated_at AS updatedAt FROM render_plan_steps`;

export function getRenderPlan(db: DatabaseSync, planId: string): RenderPlan | undefined {
  const row = db.prepare(`SELECT id, project_id AS projectId, input_hash AS inputHash, status,
    estimated_credits AS estimatedCredits, created_at AS createdAt, updated_at AS updatedAt
    FROM render_plans WHERE id=?`).get(planId);
  if (!row) return undefined;
  const steps = db.prepare(`${stepSelect} WHERE plan_id=? ORDER BY chain_id, chain_index`).all(planId);
  return { ...row, steps } as RenderPlan;
}

export function estimatePlanCredits(db: DatabaseSync, planId: string): number {
  if (!db.prepare('SELECT id FROM render_plans WHERE id=?').get(planId)) throw new Error('Render plan not found');
  return db.prepare('SELECT COALESCE(SUM(estimated_credits),0) AS total FROM render_plan_steps WHERE plan_id=?')
    .get(planId)!.total as number;
}

function event(db: DatabaseSync, planId: string, stepId: string | null,
  from: string | null, to: string, at: string): void {
  db.prepare('INSERT INTO render_plan_events(plan_id,step_id,from_status,to_status,at) VALUES (?,?,?,?,?)')
    .run(planId, stepId, from, to, at);
}

export function buildRenderPlan(db: DatabaseSync, projectId: string,
  opts: { maxReferenceImages?: number } = {}): RenderPlan {
  return transaction(db, () => {
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) throw new Error('Project not found');
    const bible = { style: '', lighting: '', palette: '', lens: '', safe_area: '', avoid: '',
      ...getBible(db, projectId), entries: new BibleService(db).list(projectId) };
    // listScenes defaults to the null variant. Read IDs directly to include M4 variant scenes too.
    const scenes = db.prepare('SELECT id FROM scenes WHERE project_id=? ORDER BY "index",id').all(projectId)
      .map(row => getScene(db, row.id as string)!);
    const groups = new Map<string, { scene: Scene; position: number }[]>();
    for (const scene of scenes) {
      const memberships = db.prepare(`SELECT cs.chain_id, cs.position FROM chain_scenes cs
        JOIN chains c ON c.id=cs.chain_id WHERE cs.scene_id=? AND c.project_id=?`).all(scene.id, projectId);
      if (memberships.length > 1) throw new Error('Scene belongs to multiple chains');
      const membership = memberships[0];
      const chainId = (membership?.chain_id as string | undefined) ?? scene.chainId;
      if (chainId && !db.prepare('SELECT id FROM chains WHERE id=? AND project_id=?').get(chainId, projectId)) {
        throw new Error('Chain must belong to project');
      }
      const key = chainId ?? `scene:${scene.id}`;
      const group = groups.get(key) ?? [];
      group.push({ scene, position: membership ? Number(membership.position) : scene.index });
      groups.set(key, group);
    }
    const input = [...groups.keys()].sort().map(chainId => ({ chainId,
      scenes: groups.get(chainId)!.sort((a, b) => a.position - b.position
        || (a.scene.id < b.scene.id ? -1 : a.scene.id > b.scene.id ? 1 : 0))
        .map(({ scene }) => ({ sceneId: scene.id,
          compiledPrompt: compileScene(scene, bible, { maxReferenceImages: opts.maxReferenceImages ?? 3 }).prompt,
          estimatedCredits: estimateStepCredits(scene) })),
    }));
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = db.prepare('SELECT id FROM render_plans WHERE project_id=? AND input_hash=?').get(projectId, inputHash);
    if (existing) return getRenderPlan(db, existing.id as string)!;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO render_plans VALUES (?,?,?,'ready',0,?,?)`).run(id, projectId, inputHash, now, now);
    event(db, id, null, null, 'ready', now);
    for (const chain of input) {
      let previous: string | null = null;
      chain.scenes.forEach((scene, index) => {
        const stepId = randomUUID();
        const status = previous === null ? 'ready' : 'pending';
        db.prepare('INSERT INTO render_plan_steps VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(stepId, id, scene.sceneId, chain.chainId, index, previous, scene.compiledPrompt,
            scene.estimatedCredits, status, now);
        event(db, id, stepId, null, status, now);
        previous = stepId;
      });
    }
    const total = estimatePlanCredits(db, id);
    if (!Number.isSafeInteger(total)) throw new Error('Credit estimate exceeds safe integer range');
    db.prepare('UPDATE render_plans SET estimated_credits=? WHERE id=?').run(total, id);
    return getRenderPlan(db, id)!;
  });
}

export function transitionStep(db: DatabaseSync, stepId: string, toStatus: RenderStepStatus): RenderPlanStep {
  return transaction(db, () => {
    const step = db.prepare(`${stepSelect} WHERE id=?`).get(stepId) as RenderPlanStep | undefined;
    if (!step) throw new Error('Render step not found');
    const allowed: Record<RenderStepStatus, readonly RenderStepStatus[]> = {
      pending: ['ready', 'skipped'], ready: ['running', 'skipped'],
      running: ['done', 'failed'], failed: ['ready', 'skipped'], done: [], skipped: [],
    };
    if (!allowed[step.status]?.includes(toStatus)) throw new Error(`Invalid transition ${step.status} -> ${toStatus}`);
    if (step.dependsOnStepId && db.prepare('SELECT status FROM render_plan_steps WHERE id=?')
      .get(step.dependsOnStepId)?.status !== 'done') throw new Error('Dependency is not done');
    const now = new Date().toISOString();
    db.prepare('UPDATE render_plan_steps SET status=?,updated_at=? WHERE id=?').run(toStatus, now, stepId);
    db.prepare('UPDATE render_plans SET updated_at=? WHERE id=?').run(now, step.planId);
    event(db, step.planId, stepId, step.status, toStatus, now);
    return db.prepare(`${stepSelect} WHERE id=?`).get(stepId) as RenderPlanStep;
  });
}
