import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDatabase } from './helpers.ts';
import { openDatabase } from '../src/db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { enqueueJob, claimNextJob } from '../src/flow/queue.ts';
import { recoverInterruptedJobs } from '../src/render/recovery.ts';
import { run } from '../src/cli.ts';
import { buildRenderPlan } from '../src/render/plans.ts';
import { requestSceneRework } from '../src/render/rework.ts';
import { createTake } from '../src/repo/renders.ts';
import { detectFfmpeg } from './helpers/media.ts';
import { runRenderPlan } from '../src/render/orchestrator.ts';
import { createFakeJobDriver } from '../src/flow/mock/jobDriver.ts';
import type { TestContext } from 'node:test';

function seed(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Resume', '16:9', null);
  for (let i = 0; i < 2; i++) createScene(db, { projectId: project.id, index: i, prompt: 'Test', transition: 'cut', durationUsed: 1 });
  const account = createAccount(db, { label: 'Fake' });
  addEntry(db, { accountId: String(account.id), amount: 1000, reason: 'fixture' });
  return { db, project, plan: buildRenderPlan(db, project.id) };
}
async function cli(args: string[]) {
  let stdout = '', stderr = '';
  const code = await run(['render', ...args], { stdout: { write(s: string) { stdout += s; } }, stderr: { write(s: string) { stderr += s; } } });
  return { code, stdout, stderr };
}
test('recovery registers complete output, clears partials, preserves attempts and is idempotent', async t => {
  const { db, project, plan } = seed(t);
  const jobs = plan.steps.map((step, i) => {
    const outputDir = join(project.directory, 'renders', String(i)); mkdirSync(outputDir, { recursive: true });
    const row = enqueueJob(db, { outputDir }, { projectId: project.id });
    db.prepare('UPDATE render_jobs SET scene_id=? WHERE id=?').run(step.sceneId, row.id);
    claimNextJob(db, 'worker');
    return { id: String(row.id), file: join(outputDir, `${row.id}_0.mp4`) };
  });
  writeFileSync(jobs[0].file, 'complete'); writeFileSync(jobs[1].file + '.partial', 'partial');
  await recoverInterruptedJobs(db, async () => 2); await recoverInterruptedJobs(db, async () => { throw new Error('must not probe twice'); });
  assert.equal(db.prepare('SELECT status FROM render_jobs WHERE id=?').get(jobs[0].id)!.status, 'done');
  assert.equal(db.prepare('SELECT status FROM render_jobs WHERE id=?').get(jobs[1].id)!.status, 'queued');
  assert.equal(db.prepare('SELECT count(*) AS n FROM takes').get()!.n, 1);
  assert.ok(!existsSync(jobs[1].file + '.partial'));
  assert.ok(db.prepare('SELECT attempts FROM render_jobs').all().every(j => j.attempts === 1));
});

test('render CLI plans, budgets and validates missing IDs without dispatching over budget', async t => {
  const { db, project, plan } = seed(t);
  assert.equal((await cli(['plan', project.id])).code, 0);
  assert.equal((await cli(['budget', project.id, '0'])).code, 0);
  const previous = process.env.VIDFLOW_FLOW_DRIVER; process.env.VIDFLOW_FLOW_DRIVER = 'fake';
  t.after(() => { if (previous === undefined) delete process.env.VIDFLOW_FLOW_DRIVER; else process.env.VIDFLOW_FLOW_DRIVER = previous; });
  assert.equal((await cli(['run', plan.id])).code, 0);
  const status = JSON.parse((await cli(['status', plan.id, '--json'])).stdout);
  assert.equal(status.jobs.length, 0); assert.equal(status.budget, 0);
  for (const args of [['pick-take', 'missing', 'missing'], ['set-inout', 'missing', '0', '10'], ['accept-redo', 'missing'], ['status', 'missing'], ['run'], ['budget', project.id, '-1']])
    assert.notEqual((await cli(args)).code, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n, 0);
  // Selection and approvals need no external media tools for independent cuts.
  const step = plan.steps[0];
  const row = enqueueJob(db, {}, { projectId: project.id });
  db.prepare('UPDATE render_jobs SET scene_id=? WHERE id=?').run(step.sceneId, row.id);
  const take = createTake(db, { sceneId: step.sceneId, renderJobId: String(row.id), file: join(project.directory, 'renders', 'fixture.mp4'), durationSec: 2 });
  assert.equal((await cli(['pick-take', step.id, take.id])).code, 0);
  assert.equal((await cli(['set-inout', take.id, '0.25', '1.5'])).code, 0);
  assert.notEqual((await cli(['set-inout', take.id, '0', '3'])).code, 0);
  const override = JSON.parse(String(db.prepare('SELECT owner_override FROM render_reviews WHERE step_id=?').get(step.id)!.owner_override));
  assert.equal(override.inPoint, 0.25); assert.equal(override.outPoint, 1.5);
  db.prepare("UPDATE render_plan_steps SET status='done' WHERE plan_id=?").run(plan.id);
  const redo = requestSceneRework(db, plan.id, step.sceneId, { prompt: 'Updated' });
  assert.equal((await cli(['accept-redo', redo.id])).code, 0);
  assert.notEqual((await cli(['accept-redo', redo.id])).code, 0);
  assert.equal(db.prepare('SELECT state FROM render_rework_requests WHERE id=?').get(redo.id)!.state, 'accepted');
});

test('resume reuses completed slots and persisted take count after a clean stop', async t => {
  const { db, plan } = seed(t);
  const abort = new AbortController();
  const requested: string[] = [];
  const driver = { async run(job: { id: string; payload: string }) {
    const payload = JSON.parse(job.payload); requested.push(job.id);
    mkdirSync(payload.outputDir, { recursive: true });
    const file = join(payload.outputDir, `${job.id}_${payload.takeIndex}.mp4`); writeFileSync(file, 'injected media');
    if (requested.length === 1) abort.abort();
    return { kind: 'success' as const, media: [{ path: file, kind: 'video' as const, bytes: 14 }] };
  } };
  const options = { db, planId: plan.id, driver, duration: async () => 2,
    reviewer: { async review(_scene: unknown, takes: { id: string; duration: number }[]) { return { takeId: takes[0].id, inPoint: 0, outPoint: takes[0].duration, reason: 'test' }; } } };
  await runRenderPlan({ ...options, takesPerScene: 3, signal: abort.signal });
  assert.equal(requested.length, 1);
  await runRenderPlan(options);
  await runRenderPlan(options);
  assert.equal(requested.length, 6); assert.equal(new Set(requested).size, 6);
  assert.equal(db.prepare('SELECT count(*) AS n FROM takes').get()!.n, 6);
  assert.ok(db.prepare('SELECT status FROM render_plan_steps').all().every(s => s.status === 'done'));
});

test('M5 fake adapter persists every generation request and publishes complete files', async t => {
  const { db, plan } = seed(t);
  const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
  process.env.TEMP = process.env.VIDFLOW_HOME; process.env.TMP = process.env.VIDFLOW_HOME;
  t.after(() => {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  });
  await runRenderPlan({ db, planId: plan.id, driver: createFakeJobDriver(db), duration: async () => 2,
    reviewer: { async review(_scene, takes) { return { takeId: takes[0].id, inPoint: 0, outPoint: 2, reason: 'fake' }; } } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM takes').get()!.n, 4);
  for (const take of db.prepare('SELECT file FROM takes').all()) {
    assert.ok(existsSync(String(take.file))); assert.ok(!existsSync(String(take.file) + '.partial'));
  }
});

const media = detectFfmpeg();
test('failed pinned slots retry the same job, recheck budget and preserve completed requests', async t => {
  const { db, project, plan } = seed(t);
  const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
  process.env.TEMP = process.env.VIDFLOW_HOME; process.env.TMP = process.env.VIDFLOW_HOME;
  t.after(() => {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  });
  let fail = true;
  const driver = createFakeJobDriver(db, { failGeneration: (_id, index) => fail && index === 1 });
  const options = { db, planId: plan.id, driver, duration: async () => 2,
    reviewer: { async review(_scene: unknown, takes: { id: string }[]) {
      return { takeId: takes[0].id, inPoint: 0, outPoint: 2, reason: 'test' };
    } } };
  await assert.rejects(runRenderPlan(options));
  const failed = db.prepare("SELECT * FROM render_jobs WHERE status='failed'").get()!;
  const done = db.prepare("SELECT id FROM render_jobs WHERE status='done'").get()!;
  assert.equal(db.prepare('SELECT status FROM render_plan_steps WHERE id=?').get(plan.steps[0].id)!.status, 'failed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(done.id)!.n, 1);
  fail = false;
  db.prepare('UPDATE projects SET budget=0 WHERE id=?').run(project.id);
  const before = db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n;
  await runRenderPlan(options);
  assert.equal(db.prepare('SELECT status FROM projects WHERE id=?').get(project.id)!.status, 'cho_duyet_ngan_sach');
  assert.equal(db.prepare('SELECT status FROM render_jobs WHERE id=?').get(failed.id)!.status, 'queued');
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n, before);
  assert.equal(db.prepare('SELECT attempts FROM render_jobs WHERE id=?').get(failed.id)!.attempts, 1);
  db.prepare('UPDATE projects SET budget=NULL WHERE id=?').run(project.id);
  await runRenderPlan(options);
  const retried = db.prepare('SELECT * FROM render_jobs WHERE id=?').get(failed.id)!;
  assert.equal(retried.status, 'done'); assert.equal(retried.attempts, 2);
  assert.ok(String(retried.claimed_at) > String(failed.claimed_at));
  assert.ok(String(retried.updated_at) >= String(retried.claimed_at));
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(done.id)!.n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(failed.id)!.n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM render_job_slots').get()!.n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM render_jobs').get()!.n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM takes').get()!.n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM render_credit_reservations').get()!.n, 4);
  assert.ok(db.prepare('SELECT status,generation FROM render_plan_steps').all().every(s => s.status === 'done' && s.generation === 0));
});

test('rejected pinned slot requires owner approval without another generate request', async t => {
  const { db, plan } = seed(t);
  const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
  process.env.TEMP = process.env.VIDFLOW_HOME; process.env.TMP = process.env.VIDFLOW_HOME;
  t.after(() => {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  });
  const driver = createFakeJobDriver(db, { failGeneration: () => true });
  const options = { db, planId: plan.id, driver, duration: async () => 2,
    reviewer: { async review() { throw new Error('must not review'); } } };
  await assert.rejects(runRenderPlan(options));
  db.prepare("UPDATE render_jobs SET status='rejected'").run();
  const before = db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n;
  await assert.rejects(runRenderPlan(options), new RegExp(`Take 1.*${plan.steps[0].id}.*render accept-redo`));
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n, before);
  assert.equal(db.prepare('SELECT status FROM render_plan_steps WHERE id=?').get(plan.steps[0].id)!.status, 'failed');
});

test('invalid duration retries a charged slot without overwriting its original or duplicating credit', async t => {
  const { db, plan } = seed(t);
  const previousTemp = process.env.TEMP, previousTmp = process.env.TMP;
  process.env.TEMP = process.env.VIDFLOW_HOME; process.env.TMP = process.env.VIDFLOW_HOME;
  t.after(() => {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  });
  let invalid = true;
  const options = { db, planId: plan.id, driver: createFakeJobDriver(db), duration: async () => invalid ? 0 : 2,
    reviewer: { async review(_scene: unknown, takes: { id: string }[]) {
      return { takeId: takes[0].id, inPoint: 0, outPoint: 2, reason: 'test' };
    } } };
  await assert.rejects(runRenderPlan(options), /Invalid take duration/);
  const failed = db.prepare("SELECT * FROM render_jobs WHERE status='failed'").get()!;
  const payload = JSON.parse(String(failed.payload));
  const original = join(payload.outputDir, `${failed.id}_${payload.takeIndex}.mp4`);
  assert.ok(existsSync(original));
  invalid = false;
  await runRenderPlan(options);
  assert.ok(existsSync(original));
  const take = db.prepare('SELECT file FROM takes WHERE render_job_id=?').get(failed.id)!;
  assert.notEqual(take.file, original);
  assert.equal(db.prepare('SELECT count(*) AS n FROM credit_ledger WHERE job_id=?').get(failed.id)!.n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(failed.id)!.n, 2);
});

test('real CLI process hard kill resumes slots without duplicate takes or completed requests', { skip: !media.available && media.reason, timeout: 180000 }, async t => {
  const { db, project, plan } = seed(t);
  db.close();
  function inspect<T>(read: (connection: DatabaseSync) => T): T {
    const connection = openDatabase();
    try { return read(connection); }
    finally { connection.close(); }
  }
  const env = { ...process.env, VIDFLOW_FLOW_DRIVER: 'fake', VIDFLOW_FAKE_DELAY_MS: '800' };
  const stopChildren: (() => Promise<void>)[] = [];
  function child(args: string[]) {
    const cp = spawn(process.execPath, [resolve('src/cli.ts'), 'render', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; cp.stdout.on('data', b => { out += b; }); cp.stderr.on('data', b => { err += b; });
    const done = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      cp.once('error', reject); cp.once('close', code => resolve({ code, out, err }));
    });
    stopChildren.push(async () => {
      if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL');
      await done.catch(() => {});
    });
    return { cp, done };
  }
  try {
    const first = child(['run', plan.id]); let spawnError: Error | undefined;
    void first.done.catch(error => { spawnError = error; });
    const deadline = Date.now() + 60000;
    let snapshot: ReturnType<typeof readProgress> | undefined;
    function readProgress(connection: DatabaseSync) {
      return connection.prepare('SELECT * FROM render_jobs').all();
    }
    while (Date.now() < deadline) {
      if (spawnError) { if ((spawnError as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox blocks child processes: spawn EPERM'); return; } throw spawnError; }
      try {
        const rows = inspect(readProgress);
        if (rows.some(j => j.status === 'done') && rows.some(j => j.status === 'running')) { snapshot = rows; break; }
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
      }
      await delay(25);
    }
    assert.ok(snapshot, 'CLI must reach a completed slot and an in-flight slot before hard kill');
    const completed = snapshot.filter(j => j.status === 'done').map(j => j.id);
    assert.ok(completed.length > 0);
    const inFlight = snapshot.filter(j => j.status === 'running'); assert.equal(inFlight.length, 1);
    if (process.platform === 'win32') await new Promise<void>((resolve, reject) => execFile('taskkill', ['/PID', String(first.cp.pid), '/T', '/F'], { timeout: 10000 }, error => error ? reject(error) : resolve()));
    else first.cp.kill('SIGKILL');
    await first.done;
    const fileExists = inFlight.filter(j => { const p = JSON.parse(String(j.payload)); return existsSync(join(p.outputDir, `${j.id}_${p.takeIndex}.mp4`)); }).length;
    const { requestsBefore, runningRequested } = inspect(connection => ({
      requestsBefore: Number(connection.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n),
      runningRequested: Number(connection.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(inFlight[0].id)!.n),
    }));
    const result = await child(['run', plan.id]).done; assert.equal(result.code, 0, result.err);
    const takes = inspect(connection => {
      assert.equal(connection.prepare('SELECT count(*) AS n FROM takes').get()!.n, 4);
      assert.equal(connection.prepare("SELECT count(*) AS n FROM render_jobs WHERE status='done'").get()!.n, 4);
      assert.equal(Number(connection.prepare('SELECT count(*) AS n FROM flow_fake_requests').get()!.n), 4 + (fileExists ? 0 : runningRequested));
      assert.ok(requestsBefore >= completed.length);
      for (const id of completed) assert.equal(connection.prepare('SELECT count(*) AS n FROM flow_fake_requests WHERE job_id=?').get(id)!.n, 1);
      return connection.prepare('SELECT * FROM takes').all();
    });
    const take = takes[0];
    const step = plan.steps.find(s => s.sceneId === take.scene_id)!;
    for (const args of [['status', plan.id, '--json'], ['pick-take', step.id, String(take.id)], ['set-inout', String(take.id), '0', '0.5'], ['budget', project.id, '1000']])
      assert.equal((await child(args).done).code, 0);
    assert.notEqual((await child(['set-inout', String(take.id), '0', '999']).done).code, 0);
    const redo = inspect(connection => requestSceneRework(connection, plan.id, step.sceneId, { prompt: 'Changed' }));
    assert.equal((await child(['accept-redo', redo.id]).done).code, 0);
    assert.notEqual((await child(['accept-redo', redo.id]).done).code, 0);
  } finally {
    for (const stop of stopChildren) await stop();
  }
});
