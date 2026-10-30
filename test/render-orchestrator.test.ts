import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createChain, addScene } from '../src/repo/chains.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { buildRenderPlan, getRenderPlan } from '../src/render/plans.ts';
import { createTake } from '../src/repo/renders.ts';
import { enqueueJob } from '../src/flow/queue.ts';
import { runRenderPlan, getReviewScene, setOwnerOverride, resolveSelection, exportSelections,
  initializeRenderReviews, createLlmTakeReviewer } from '../src/render/orchestrator.ts';
import type { FlowJobDriver } from '../src/flow/jobDriver.ts';
import type { ReviewScene } from '../src/render/orchestrator.ts';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db); initializeRenderReviews(db);
  db.exec(`INSERT INTO projects(id,name,aspect,directory,created_at) VALUES ('p','Project','16:9','projects/p','now')`);
  db.prepare('UPDATE projects SET directory=? WHERE id=?').run(join(process.env.VIDFLOW_HOME!, 'projects', 'p'), 'p');
  for (const size of [3, 2]) {
    const chain = createChain(db, { projectId: 'p', name: String(size) });
    for (let i = 0; i < size; i++) addScene(db, chain.id,
      createScene(db, { projectId: 'p', prompt: `Scene ${size}/${i}`, durationUsed: 8 }).id);
  }
  for (let i = 0; i < 2; i++) {
    const account = createAccount(db, { label: `Account ${i}` });
    addEntry(db, { accountId: String(account.id), amount: 1000, reason: 'fixture' });
  }
  return { db, plan: buildRenderPlan(db, 'p') };
}

test('two account Flow fake overlaps chains and settles five scenes sequentially with two takes', async t => {
  const { db, plan } = fixture(t);
  const frame = join(process.env.VIDFLOW_HOME!, 'projects/p/frames/exit.png');
  mkdirSync(join(process.env.VIDFLOW_HOME!, 'projects/p/frames'), { recursive: true });
  writeFileSync(frame, 'injected frame');
  let tick = 0, active = 0, peak = 0;
  const accountActive = new Set<string>();
  const jobs: { chain: string; scene: string; start: number; end: number; account: string }[] = [];
  const driver: FlowJobDriver = { async run(job, account) {
    assert.ok(!accountActive.has(account.id)); accountActive.add(account.id);
    active++; peak = Math.max(peak, active);
    const payload = JSON.parse(job.payload);
    const record = { chain: payload.chainId, scene: payload.sceneId, start: ++tick, end: 0, account: account.id };
    jobs.push(record);
    await setImmediate();
    record.end = ++tick; active--; accountActive.delete(account.id);
    return { kind: 'success', media: [{ path: `projects/p/renders/${job.id}.mp4`, kind: 'video', bytes: 1 }] };
  } };
  const frames: string[] = [];
  await runRenderPlan({ db, planId: plan.id, driver, clock: () => new Date(tick),
    duration: async () => 8,
    reviewer: { async review(scene, takes) {
      const suggestion = { takeId: takes[1].id, inPoint: 1, outPoint: 7, reason: 'fake best' };
      // Override is set while review is pending, before the suggestion is saved.
      setOwnerOverride(db, plan.steps.find(s => s.sceneId === scene.sceneId)!.id, { outPoint: 6 });
      return suggestion;
    } },
    exitFrame: async (scene, selection) => {
      assert.deepEqual(selection, resolveSelection(scene)); assert.equal(selection.outPoint, 6);
      frames.push(scene.sceneId); return join(process.env.VIDFLOW_HOME!, 'projects/p/frames/exit.png');
    },
  });
  assert.equal(peak, 2); assert.equal(active, 0); assert.equal(jobs.length, 10);
  assert.ok(jobs.some(a => jobs.some(b => a.chain !== b.chain && a.start < b.end && b.start < a.end)));
  for (const chain of new Set(plan.steps.map(s => s.chainId))) {
    const steps = plan.steps.filter(s => s.chainId === chain);
    assert.equal(new Set(jobs.filter(j => j.chain === chain).map(j => j.account)).size, 1);
    for (let i = 1; i < steps.length; i++) {
      const prev = jobs.filter(j => j.scene === steps[i - 1].sceneId);
      const curr = jobs.filter(j => j.scene === steps[i].sceneId);
      assert.ok(Math.max(...prev.map(j => j.end)) < Math.min(...curr.map(j => j.start)));
    }
  }
  assert.equal(frames.length, 3);
  const savedFrames = db.prepare('SELECT * FROM scene_start_frames').all();
  assert.equal(savedFrames.length, 3);
  assert.ok(savedFrames.every(row => row.effective_time_sec === null && typeof row.sha256 === 'string'));
  assert.ok(getRenderPlan(db, plan.id)!.steps.every(s => s.status === 'done'));
  assert.equal(exportSelections(db, plan.id).length, 5);
  for (const step of plan.steps) {
    const state = getReviewScene(db, step.id);
    assert.equal(state.takes.length, 2);
    for (const take of state.takes) assert.ok(Date.parse(take.startedAt) < Date.parse(take.finishedAt));
    assert.deepEqual(resolveSelection(state), { takeId: state.takes[1].id, inPoint: 1, outPoint: 6 });
    assert.equal(state.suggestion!.outPoint, 7);
  }
  const first = plan.steps[0]; setOwnerOverride(db, first.id, { inPoint: 2, outPoint: 5 });
  assert.equal(exportSelections(db, plan.id)[0].inPoint, 2);
});

test('owner fields override suggestions independently and invalid selections are rejected', t => {
  const { db, plan } = fixture(t); const step = plan.steps[0];
  const job = enqueueJob(db, {}, { projectId: 'p' });
  db.prepare('UPDATE render_jobs SET scene_id=? WHERE id=?').run(step.sceneId, job.id);
  const takes = [0, 1].map(i => createTake(db, { sceneId: step.sceneId, renderJobId: String(job.id), file: `take${i}`, durationSec: 8 }));
  const suggestion = { takeId: takes[0].id, inPoint: 1, outPoint: 7, reason: 'AI' };
  // Owner choice survives a review write; later updates also win.
  setOwnerOverride(db, step.id, { takeId: takes[1].id });
  db.prepare('UPDATE render_reviews SET suggestion=? WHERE step_id=?').run(JSON.stringify(suggestion), step.id);
  for (const override of [{ takeId: takes[1].id }, { inPoint: 2, outPoint: 6 },
    { takeId: takes[1].id, inPoint: 3, outPoint: 5 }]) {
    setOwnerOverride(db, step.id, override);
    assert.deepEqual(resolveSelection(getReviewScene(db, step.id)), {
      takeId: override.takeId ?? suggestion.takeId, inPoint: override.inPoint ?? 1, outPoint: override.outPoint ?? 7,
    });
  }
  const before = getReviewScene(db, step.id);
  for (const bad of [{ takeId: 'unknown' }, { inPoint: 7, outPoint: 2 }, { inPoint: -1 }, { outPoint: 9 }, { inPoint: NaN }])
    assert.throws(() => setOwnerOverride(db, step.id, bad), /belong|0 <=/);
  assert.deepEqual(getReviewScene(db, step.id), before);
});

test('production reviewer calls the existing LLM interface and validates its suggestion', async () => {
  const scene: ReviewScene = { sceneId: 's', takes: [{ id: 't', file: 'sample', duration: 8, startedAt: '', finishedAt: '' }] };
  let calls = 0;
  const reviewer = createLlmTakeReviewer({ async complete(request) {
    calls++; assert.ok(request.prompt.includes('sample'));
    return { text: JSON.stringify({ takeId: 't', inPoint: 1, outPoint: 7, reason: 'best' }) };
  } });
  assert.equal((await reviewer.review(scene, scene.takes)).takeId, 't'); assert.equal(calls, 1);
});
