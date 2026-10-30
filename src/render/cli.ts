import { parseArgs } from 'node:util';
import { openDatabase } from '../db.ts';
import { findProject } from '../repo/projects.ts';
import { buildRenderPlan, getRenderPlan } from './plans.ts';
import { runRenderPlan, initializeRenderReviews, getReviewScene, createLlmTakeReviewer } from './orchestrator.ts';
import { projectCommittedCredits } from './budget.ts';
import { decideRework } from './rework.ts';
import { probe } from '../media/probe.ts';
import { createPageDriver } from '../flow/pageDriver.ts';
import { launchFlowContext } from '../flow/driver.ts';
import { configuredLlm } from '../script/config.ts';
import { redactString } from '../redact.ts';
import { createFakeJobDriver } from '../flow/mock/jobDriver.ts';
import { setOwnerOverrideAndRefresh } from './frameChain.ts';

const help = `Render: lập kế hoạch và tiếp tục hàng đợi
  render plan <project>
  render run <plan> (Ctrl+C để dừng sau lượt hiện tại)
  render status <plan> [--json]
  render pick-take <step> <take>
  render set-inout <take> <in> <out>
  render budget <project> [credits|unlimited]
  render accept-redo <request>
`;
type IO = { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } };
export async function runRenderCommand(args: string[], io: IO = process): Promise<number> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const { positionals: p, values } = parseArgs({ args, allowPositionals: true,
      options: { json: { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help || !p.length) { io.stdout.write(help); return 0; }
    const sizes: Record<string, number[]> = { plan: [2], run: [2], status: [2], 'pick-take': [3], 'set-inout': [4], budget: [2,3], 'accept-redo': [2] };
    if (!sizes[p[0]]?.includes(p.length) || (values.json && p[0] !== 'status')) throw new Error('Đối số render không hợp lệ.\n' + help);
    db = openDatabase(); initializeRenderReviews(db);
    const output = (v: unknown) => io.stdout.write(JSON.stringify(v) + '\n');
    const project = () => { const row = findProject(db!, p[1]); if (!row) throw new Error('Không tìm thấy dự án'); return row; };
    if (p[0] === 'plan') output(buildRenderPlan(db, project().id));
    else if (p[0] === 'budget') {
      const row = project();
      if (p[2] !== undefined) {
        const n = p[2] === 'unlimited' ? null : Number(p[2]);
        if (n !== null && (!Number.isSafeInteger(n) || n < 0)) throw new Error('Ngân sách phải là số nguyên không âm');
        db.prepare('UPDATE projects SET budget=? WHERE id=?').run(n, row.id);
      }
      output({ budget: findProject(db, row.id)!.budget, committed: projectCommittedCredits(db, row.id) });
    } else if (p[0] === 'accept-redo') output(decideRework(db, p[1], true));
    else if (p[0] === 'pick-take' || p[0] === 'set-inout') {
      const step = p[0] === 'pick-take' ? p[1] : db.prepare(`SELECT s.id FROM render_plan_steps s JOIN takes t ON t.scene_id=s.scene_id WHERE t.id=? ORDER BY s.updated_at DESC LIMIT 1`).get(p[1])?.id;
      if (!step) throw new Error('Không tìm thấy take');
      const before = getReviewScene(db, String(step));
      await setOwnerOverrideAndRefresh(db, String(step), { ...before.override, ...(p[0] === 'pick-take' ? { takeId: p[2], inPoint: 0, outPoint: before.takes.find(t => t.id === p[2])?.duration } : { takeId: p[1], inPoint: Number(p[2]), outPoint: Number(p[3]) }) });
      output(getReviewScene(db, String(step)));
    } else {
      const plan = getRenderPlan(db, p[1]); if (!plan) throw new Error('Không tìm thấy kế hoạch render');
      if (p[0] === 'status') output({ plan, jobs: db.prepare('SELECT * FROM render_jobs WHERE project_id=?').all(plan.projectId),
        takes: db.prepare('SELECT t.* FROM takes t JOIN render_jobs j ON j.id=t.render_job_id WHERE j.project_id=?').all(plan.projectId),
        budget: findProject(db, plan.projectId)!.budget, committed: projectCommittedCredits(db, plan.projectId) });
      else {
        const store = db;
        const fake = process.env.VIDFLOW_FLOW_DRIVER === 'fake';
        const driver = fake ? createFakeJobDriver(db) : createPageDriver(async accountId => ({ db: store, browser: await launchFlowContext(accountId), url: 'https://labs.google/fx/tools/flow', timeoutMs: 30000 }));
        const abort = new AbortController(); const stop = () => abort.abort(); process.on('SIGINT', stop);
        try { await runRenderPlan({ db, planId: plan.id, driver, reviewer: fake ? { async review(_scene, takes) { return { takeId: takes[0].id, inPoint: 0, outPoint: takes[0].duration, reason: 'M5 fake' }; } } : createLlmTakeReviewer(configuredLlm()), signal: abort.signal,
          duration: async file => (await probe(file)).durationSec }); }
        finally { process.off('SIGINT', stop); }
        output(getRenderPlan(db, plan.id));
      }
    }
    return 0;
  } catch (error) { io.stderr.write(redactString('vidflow: ' + (error instanceof Error ? error.message : String(error))) + '\n'); return 1; }
  finally { db?.close(); }
}
