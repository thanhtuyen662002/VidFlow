import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { latestVersion, migrate } from '../src/migrations.ts';
import { createScene, updateScene } from '../src/repo/scenes.ts';
import { createChain, addScene } from '../src/repo/chains.ts';
import { setBible } from '../src/repo/bibles.ts';
import { buildRenderPlan, getRenderPlan, estimatePlanCredits, estimateStepCredits, transitionStep } from '../src/render/plans.ts';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t);
  migrate(db);
  db.exec(`INSERT INTO projects(id,name,aspect,directory,created_at) VALUES ('p','Project','16:9','projects/p','now')`);
  setBible(db, 'p', { style: 'Cinematic' });
  const chains = [createChain(db, { projectId: 'p', name: 'A' }), createChain(db, { projectId: 'p', name: 'B' })];
  const scenes = Array.from({ length: 5 }, (_, index) => createScene(db, {
    projectId: 'p', prompt: `Scene ${index}`, durationUsed: index + 5,
  }));
  // Membership order deliberately differs from Scene.index.
  for (const i of [2, 0, 1]) addScene(db, chains[0].id, scenes[i].id);
  for (const i of [4, 3]) addScene(db, chains[1].id, scenes[i].id);
  return { db, scenes, chains };
}

test('five steps preserve membership order and depend only on their own chain', t => {
  const { db, chains, scenes } = fixture(t);
  const plan = buildRenderPlan(db, 'p');
  assert.equal(plan.steps.length, 5);
  for (const [chain, indices] of [[chains[0], [2, 0, 1]], [chains[1], [4, 3]]] as const) {
    const steps = plan.steps.filter(step => step.chainId === chain.id);
    assert.deepEqual(steps.map(step => step.sceneId), indices.map(i => scenes[i].id));
    steps.forEach((step, index) => {
      assert.equal(step.dependsOnStepId, index ? steps[index - 1].id : null);
      assert.equal(step.status, index ? 'pending' : 'ready');
      assert.equal(step.chainIndex, index);
      assert.ok(step.compiledPrompt.startsWith('Cinematic\nScene '));
    });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM render_plan_events').get()!.n, 6);
});

test('plan credits equal the exact sum of pure per-scene estimates', t => {
  const { db, scenes } = fixture(t);
  const plan = buildRenderPlan(db, 'p');
  assert.equal(plan.estimatedCredits, plan.steps.reduce((sum, step) => sum + step.estimatedCredits, 0));
  assert.equal(plan.estimatedCredits, scenes.reduce((sum, scene) => sum + estimateStepCredits(scene), 0));
  assert.equal(estimatePlanCredits(db, plan.id), plan.estimatedCredits);
  assert.throws(() => estimateStepCredits({ durationUsed: -1 }));
});

test('same ordered compiled inputs reuse the unchanged plan and events; edits create a new hash', t => {
  const { db, scenes } = fixture(t);
  const first = buildRenderPlan(db, 'p');
  transitionStep(db, first.steps.find(step => step.status === 'ready')!.id, 'running');
  const before = getRenderPlan(db, first.id);
  const counts = () => ['render_plans', 'render_plan_steps', 'render_plan_events']
    .map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const originalCounts = counts();
  assert.deepEqual(buildRenderPlan(db, 'p'), before);
  assert.deepEqual(counts(), originalCounts);
  updateScene(db, scenes[0].id, { prompt: 'Changed scene' });
  const changed = buildRenderPlan(db, 'p');
  assert.notEqual(changed.id, first.id);
  assert.notEqual(changed.inputHash, first.inputHash);
});

test('transitions are durable and invalid transitions leave rows and events unchanged', t => {
  const { db } = fixture(t);
  const plan = buildRenderPlan(db, 'p');
  const first = plan.steps.find(step => step.status === 'ready')!;
  const next = plan.steps.find(step => step.dependsOnStepId === first.id)!;
  const events = () => db.prepare('SELECT * FROM render_plan_events ORDER BY id').all();
  const initial = events();
  assert.throws(() => transitionStep(db, next.id, 'ready'), /Dependency/);
  assert.deepEqual(events(), initial);
  transitionStep(db, first.id, 'running');
  transitionStep(db, first.id, 'done');
  const last = events().at(-1)!;
  assert.equal(last.from_status, 'running');
  assert.equal(last.to_status, 'done');
  assert.equal(last.step_id, first.id);
  const reopened = new DatabaseSync(join(process.env.VIDFLOW_HOME!, 'vidflow.db'));
  try { assert.equal(getRenderPlan(reopened, plan.id)!.steps.find(step => step.id === first.id)!.status, 'done'); }
  finally { reopened.close(); }
  const beforeInvalid = events();
  assert.throws(() => transitionStep(db, first.id, 'running'), /Invalid transition/);
  assert.deepEqual(events(), beforeInvalid);
  transitionStep(db, next.id, 'ready');
  transitionStep(db, next.id, 'running');
  transitionStep(db, next.id, 'failed');
  transitionStep(db, next.id, 'ready');
});

test('migration v9 is recorded once on a fresh database', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, latestVersion);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations WHERE version=9').get()!.n, 1);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations WHERE version=9').get()!.n, 1);
});

test('unassigned scenes are independent singletons, and compilation failure rolls back creation', t => {
  const { db } = fixture(t);
  const single = createScene(db, { projectId: 'p', prompt: 'Standalone' });
  const plan = buildRenderPlan(db, 'p');
  const step = plan.steps.find(step => step.sceneId === single.id)!;
  assert.equal(step.dependsOnStepId, null);
  assert.equal(step.status, 'ready');
  updateScene(db, single.id, { prompt: '@Unknown' });
  const before = db.prepare('SELECT * FROM render_plan_events').all();
  assert.throws(() => buildRenderPlan(db, 'p'), /not registered/);
  assert.deepEqual(db.prepare('SELECT * FROM render_plan_events').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM render_plans').get()!.n, 1);
});

test('legacy Scene.chainId membership uses scene order and an event failure rolls back status', t => {
  const { db, chains } = fixture(t);
  db.exec('DELETE FROM chain_scenes');
  const first = createScene(db, { projectId: 'p', chainId: chains[0].id, prompt: 'First' });
  const second = createScene(db, { projectId: 'p', chainId: chains[0].id, prompt: 'Second' });
  const plan = buildRenderPlan(db, 'p');
  const steps = plan.steps.filter(step => step.chainId === chains[0].id);
  assert.deepEqual(steps.map(step => step.sceneId), [first.id, second.id]);
  assert.equal(steps[1].dependsOnStepId, steps[0].id);
  db.exec(`CREATE TRIGGER reject_render_event BEFORE INSERT ON render_plan_events
    BEGIN SELECT RAISE(ABORT, 'Event write failed'); END`);
  assert.throws(() => transitionStep(db, steps[0].id, 'running'), /Event write failed/);
  assert.deepEqual(getRenderPlan(db, plan.id), plan);
});
