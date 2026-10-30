import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createScene, getScene, updateScene } from '../src/repo/scenes.ts';
import { createChain, addScene } from '../src/repo/chains.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { buildRenderPlan, estimateStepCredits } from '../src/render/plans.ts';
import { runRenderPlan } from '../src/render/orchestrator.ts';
import { requestSceneRework, decideRework } from '../src/render/rework.ts';
import { projectCommittedCredits } from '../src/render/budget.ts';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, budget: number | null = null) {
  const db = temporaryDatabase(t); migrate(db);
  db.prepare('INSERT INTO projects(id,name,aspect,budget,directory,created_at) VALUES (?,?,?,?,?,?)')
    .run('p','Project','16:9',budget,join(process.env.VIDFLOW_HOME!, 'projects/p'),'now');
  const chain = createChain(db, { projectId: 'p' });
  const scenes = Array.from({ length: 4 }, (_, i) => {
    const scene = createScene(db, { projectId: 'p', prompt: `Scene ${i}`, durationUsed: 8,
      transition: i ? 'continue' : 'cut', status: 'rendered' });
    addScene(db, chain.id, scene.id); return scene;
  });
  const account = createAccount(db, { label: 'fake' });
  addEntry(db, { accountId: String(account.id), amount: 1000, reason: 'fixture' });
  const plan = buildRenderPlan(db, 'p');
  const calls: string[] = [];
  const run = () => runRenderPlan({ db, planId: plan.id, takesPerScene: 1,
    driver: { async run(job) {
      const payload = JSON.parse(job.payload); calls.push(payload.sceneId);
      return { kind: 'success', media: [{ kind: 'video', path: `projects/p/renders/${job.id}.mp4`, bytes: 1 }] };
    } }, duration: async () => 8,
    reviewer: { async review(_scene, takes) { return { takeId: takes.at(-1)!.id, inPoint: 0, outPoint: 7, reason: 'fake' }; } },
  });
  return { db, scenes, plan, calls, run };
}

test('scene edit keeps CRUD status and waits for approval; accepted scope alone renders', async t => {
  const { db, scenes, plan, calls, run } = fixture(t);
  // Initial takes provide completed plan state without requiring real media/Flow.
  db.prepare("UPDATE scenes SET transition='cut' WHERE project_id='p'").run();
  await run();
  scenes.forEach((s, i) => updateScene(db, s.id, { transition: i ? 'continue' : 'cut' }));
  const beforeJobs = Number(db.prepare('SELECT COUNT(*) n FROM render_jobs').get()!.n);
  const statuses = scenes.map(s => getScene(db, s.id)!.status);
  const request = requestSceneRework(db, plan.id, scenes[1].id, { prompt: 'Edited' }, 1);
  assert.deepEqual(request.sceneIds, scenes.slice(1).map(s => s.id));
  assert.equal(request.estimatedCredits, scenes.slice(1).reduce((sum,s) => sum + estimateStepCredits(s),0));
  assert.ok(request.estimatedCredits > 0);
  assert.deepEqual(scenes.map(s => getScene(db,s.id)!.status), statuses);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_jobs').get()!.n, beforeJobs);
  decideRework(db, request.id, true);
  // Frame extraction is tested by M6.3. This test isolates dispatch scope.
  scenes.forEach(s => updateScene(db,s.id,{ transition: 'cut' }));
  calls.length = 0;
  await run();
  assert.deepEqual(calls, request.sceneIds);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_jobs').get()!.n, beforeJobs + 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM takes').get()!.n, beforeJobs + 3);
});

test('pending and rejected requests enqueue nothing', t => {
  const { db, scenes, plan, calls } = fixture(t);
  const request = requestSceneRework(db,plan.id,scenes[1].id,{ action: 'Edited' });
  assert.equal(request.state,'awaiting_owner_approval');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_jobs').get()!.n,0);
  decideRework(db,request.id,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_jobs').get()!.n,0);
  assert.deepEqual(calls,[]);
  assert.ok(scenes.every(s => getScene(db,s.id)!.status === 'rendered'));
});

for (const budget of [10, 80]) test(`dispatch budget ${budget}`, async t => {
  const { db, scenes, calls, run } = fixture(t,budget);
  scenes.forEach(s => updateScene(db,s.id,{ transition: 'cut' }));
  await run();
  assert.equal(calls.length, budget === 10 ? 0 : 4);
  if (budget === 10) assert.equal(db.prepare('SELECT status FROM projects').get()!.status,'cho_duyet_ngan_sach');
  assert.ok(projectCommittedCredits(db,'p') <= budget);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE project_id=?').get('p')!.n,0);
});
