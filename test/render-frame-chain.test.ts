import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { detectFfmpeg, makeTestVideo } from './helpers/media.ts';
import { migrate, migrations } from '../src/migrations.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createChain, addScene } from '../src/repo/chains.ts';
import { createTake } from '../src/repo/renders.ts';
import { enqueueJob } from '../src/flow/queue.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { buildRenderPlan, getRenderPlan } from '../src/render/plans.ts';
import { buildStartFrame, setOwnerOverrideAndRefresh, updateSelectionAndRefresh } from '../src/render/frameChain.ts';
import { initializeRenderReviews, setOwnerOverride, runRenderPlan } from '../src/render/orchestrator.ts';
import { extractFrame, cropLogoImage, probe } from '../src/media/index.ts';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db); initializeRenderReviews(db);
  const root = join(process.env.VIDFLOW_HOME!, 'projects/p');
  mkdirSync(root, { recursive: true });
  db.prepare(`INSERT INTO projects(id,name,aspect,directory,created_at) VALUES ('p','Project','16:9',?,'now')`).run(root);
  const chain = createChain(db, { projectId: 'p' });
  for (let i = 0; i < 3; i++) addScene(db, chain.id, createScene(db, {
    projectId: 'p', prompt: `Scene ${i}`, transition: i ? 'continue' : 'cut', durationUsed: 1,
  }).id);
  const plan = buildRenderPlan(db, 'p');
  const latest = (id: string) => db.prepare('SELECT * FROM scene_start_frames WHERE step_id=? ORDER BY rowid DESC LIMIT 1').get(id)!;
  const dirty = (id: string) => db.prepare('SELECT needs_rerender FROM render_plan_steps WHERE id=?').get(id)!.needs_rerender;
  return { db, root, plan, latest, dirty };
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('full and rounded duration hashes match last cropped frame; real selection changes cascade and rerender', async t => {
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  const { db, root, plan, latest, dirty } = fixture(t);
  const media = await makeTestVideo(root);
  const info = await probe(media);
  const [a, b, c] = plan.steps;
  const job = enqueueJob(db, {}, { projectId: 'p' });
  db.prepare('UPDATE render_jobs SET scene_id=? WHERE id=?').run(a.sceneId, job.id);
  const take = createTake(db, { sceneId: a.sceneId, renderJobId: String(job.id), file: media, durationSec: info.durationSec });
  setOwnerOverride(db, a.id, { takeId: take.id });
  const sourceHash = hash(media);
  const first = await buildStartFrame(db, b.id);
  const raw = await extractFrame(root, media, info.durationSec - 1 / info.fps, { fileName: 'independent.png' });
  const cropped = await cropLogoImage(root, raw.path, { fileName: 'independent-cropped.png' });
  assert.equal(hash(first), hash(cropped.path));
  assert.equal(latest(b.id).sha256, hash(cropped.path));
  assert.equal(latest(b.id).out_point, info.durationSec);
  assert.equal(latest(b.id).effective_time_sec, 0.96);
  db.exec('UPDATE render_plan_steps SET needs_rerender=0');
  setOwnerOverride(db, a.id, { takeId: take.id });
  const second = await buildStartFrame(db, b.id);
  assert.notEqual(second, first); assert.equal(hash(second), hash(first));
  assert.equal(dirty(b.id), 0); assert.equal(dirty(c.id), 0);
  db.prepare('UPDATE takes SET duration_sec=? WHERE id=?').run(info.durationSec + 0.0005, take.id);
  setOwnerOverride(db, a.id, { takeId: take.id, outPoint: info.durationSec + 0.0005 });
  assert.equal(hash(await buildStartFrame(db, b.id)), hash(first));
  const beforeOverride = db.prepare('SELECT * FROM render_reviews WHERE step_id=?').get(a.id);
  const beforeFrames = db.prepare('SELECT COUNT(*) AS n FROM scene_start_frames').get()!.n;
  db.exec(`CREATE TRIGGER reject_frame BEFORE INSERT ON scene_start_frames
    BEGIN SELECT RAISE(ABORT, 'Frame write failed'); END`);
  await assert.rejects(setOwnerOverrideAndRefresh(db, a.id, { takeId: take.id, outPoint: 0.4 }), /Frame write failed/);
  assert.deepEqual(db.prepare('SELECT * FROM render_reviews WHERE step_id=?').get(a.id), beforeOverride);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scene_start_frames').get()!.n, beforeFrames);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM render_override_history').get()!.n, 0);
  db.exec('DROP TRIGGER reject_frame');
  db.exec("UPDATE render_plan_steps SET status='done',needs_rerender=0");
  await updateSelectionAndRefresh(db, a.id, { takeId: take.id, inPoint: 0, outPoint: 0.4 });
  assert.notEqual(latest(b.id).sha256, hash(first));
  assert.equal(dirty(a.id), 0); assert.equal(dirty(b.id), 1); assert.equal(dirty(c.id), 1);
  assert.equal(hash(first), hash(cropped.path)); assert.equal(hash(media), sourceHash);
  const account = createAccount(db, { label: 'fake' });
  addEntry(db, { accountId: String(account.id), amount: 100, reason: 'fixture' });
  db.prepare("UPDATE render_jobs SET status='done' WHERE id=?").run(job.id);
  let calls = 0;
  await runRenderPlan({ db, planId: plan.id, takesPerScene: 1, duration: async () => info.durationSec,
    driver: { async run() { calls++; return { kind: 'success', media: [{ path: media, kind: 'video', bytes: 1 }] }; } },
    reviewer: { async review(_scene, takes) { return { takeId: takes[0].id, inPoint: 0, outPoint: info.durationSec, reason: 'fake' }; } },
  });
  assert.equal(calls, 2);
  assert.ok(getRenderPlan(db, plan.id)!.steps.every(step => step.status === 'done'));
  assert.ok(db.prepare("SELECT id FROM render_plan_events WHERE step_id=? AND from_status='done' AND to_status='ready'").get(b.id));
  assert.equal(latest(c.id).out_point, info.durationSec);
  assert.equal(latest(c.id).sha256, hash(cropped.path));
});

test('failed frame build leaves override, history, dirty flags and frame rows unchanged', async t => {
  const { db, root, plan } = fixture(t);
  const [a] = plan.steps;
  const job = enqueueJob(db, {}, { projectId: 'p' });
  db.prepare('UPDATE render_jobs SET scene_id=? WHERE id=?').run(a.sceneId, job.id);
  const take = createTake(db, { sceneId: a.sceneId, renderJobId: String(job.id), file: join(root, 'missing.mp4'), durationSec: 1 });
  setOwnerOverride(db, a.id, { takeId: take.id });
  const snapshot = () => ['render_reviews', 'render_override_history', 'render_plan_steps', 'scene_start_frames']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  await assert.rejects(setOwnerOverrideAndRefresh(db, a.id, { takeId: take.id, outPoint: 0.5 }), { code: 'MEDIA_FILE_MISSING' });
  assert.deepEqual(snapshot(), before);
});

test('effective-time migration preserves valid history and removes legacy orphan history', t => {
  const db = temporaryDatabase(t); migrate(db, migrations.slice(0, 10));
  db.exec(`INSERT INTO render_plans VALUES ('p','project','hash','ready',0,'now','now');
    INSERT INTO render_plan_steps(id,plan_id,scene_id,chain_id,chain_index,compiled_prompt,estimated_credits,status,updated_at)
    VALUES ('s','p','scene','chain',0,'prompt',0,'done','now');
    INSERT INTO render_override_history VALUES ('valid','s','{}','now'),('orphan','missing','{}','now');`);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM render_override_history').get()!.n, 1);
  assert.equal(db.prepare('SELECT id FROM render_override_history').get()!.id, 'valid');
  assert.throws(() => db.prepare('INSERT INTO render_override_history VALUES (?,?,?,?)').run('bad', 'missing', '{}', 'now'), /FOREIGN KEY/);
  assert.ok(db.prepare('PRAGMA table_info(scene_start_frames)').all().some(column => column.name === 'effective_time_sec'));
});
