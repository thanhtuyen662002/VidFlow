import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { enqueueJob, listJobs } from '../src/flow/queue.ts';
import { createScheduler } from '../src/flow/scheduler.ts';
import type { FlowJobDriver } from '../src/flow/jobDriver.ts';
import type { FlowDriverContext, VideoEditJob, FrameImageJob } from '../src/flow/driver.ts';
import { setOwnerCutPoints, listSegments } from '../src/motion/source-import.ts';
import { analyzeSubjects } from '../src/motion/subjects.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { MotionStyleService } from '../src/motion/style-service.ts';
import { motionMedia } from '../src/motion/render-media.ts';
import { runFfmpeg } from '../src/media/runner.ts';
import { resolveFfmpeg, resolveFfprobe } from '../src/media/discovery.ts';
import { startFakeFlow, FAKE_FLOW_AI_WATERMARK } from '../src/flow/mock/index.ts';
import { motionSelectors } from '../src/flow/selectors.ts';
import { browserAvailable, BROWSER_SKIP_REASON, launchHeadless } from './support/browser.ts';
import { enqueueMotionJobs, createMotionDispatcher, getMotionState, selectVariant,
  approveMotionBudget, approveMotionRerender, completeVisualPreview } from '../src/motion/render.ts';

const never: FlowJobDriver = { async run() { throw new Error('Unexpected generic video dispatch'); } };
async function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Motion render', '16:9', null);
  const root = project.directory;
  db.prepare(`INSERT INTO source_videos(id,project_id,original_path,stored_path,sha256,size_bytes,duration_sec,fps,width,height,
    has_audio,rights_confirmed,rights_confirmed_at,scene_threshold,max_segment_sec,min_scene_sec,created_at)
    VALUES ('video',?,'source.mp4','assets/source.mp4','hash',1,6,25,160,120,0,1,'now',0.3,2,0.5,'now')`).run(project.id);
  // Two consecutive segments, then a different scene.
  setOwnerCutPoints(db, 'video', [4]);
  await analyzeSubjects(db, 'video', { llm: new MockLlm(),
    frameExtractor: async () => ({ path: 'stub.png', timeSec: 0, width: 160, height: 120 }) });
  const style = new MotionStyleService(db);
  style.createStylePreview('video', 'cartoon_faceless');
  const accountId = String(createAccount(db, { label: 'Fake account' }).id);
  addEntry(db, { accountId, amount: 10000, reason: 'Fixture' });
  const log: { kind: string; segment: string; start?: string }[] = [];
  let fail = false;
  const file = async (contents: string, ext = 'png', derived = false) => {
    const directory = derived ? join(root, 'frames', 'motion', 'fixture') : join(root, 'renders', 'fixture');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${randomUUID()}.${ext}`); await writeFile(path, contents); return path;
  };
  const media = {
    frame: async (source: string, time: number | 'last') => file(`AI-WATERMARK|${source}|${time}|FLOW-LOGO`, 'png', true),
    crop: async (source: string) => file((await readFile(source, 'utf8')).replace(/\|FLOW-LOGO$/, ''), 'png', true),
    comparison: async (a: string, b: string) => file(`${await readFile(a)}\n${await readFile(b)}`, 'png', true),
    clip: async (_source: string, start: number, end: number) => file(`clip ${start}-${end}`, 'mp4', true),
  };
  const result = async (job: VideoEditJob | FrameImageJob) => {
    const child = db.prepare('SELECT payload FROM render_jobs WHERE id=?').get(job.id)!;
    const payload = JSON.parse(String(child.payload));
    const parent = payload.parentId ? db.prepare('SELECT payload FROM render_jobs WHERE id=?').get(payload.parentId) : undefined;
    const segment = parent ? JSON.parse(String(parent.payload)).sourceSegmentId : 'preview';
    const kind = 'frameKind' in job ? job.frameKind : 'video';
    log.push({ kind, segment, start: job.references?.first_frame?.[0] });
    if (fail && kind === 'video') { fail = false; throw new Error('Simulated process interruption'); }
    const count = 'variants' in job ? job.variants : 1;
    return { kind: 'completed' as const, files: await Promise.all(Array.from({ length: count }, (_, i) =>
      file(`AI-WATERMARK|${segment}|${kind}|${i}|FLOW-LOGO`, kind === 'video' ? 'mp4' : 'png'))),
      creditsBefore: 1000, creditsAfter: 999, creditsCharged: 1, durationMs: 1, accountId };
  };
  const context = () => ({ db } as FlowDriverContext);
  const options = { db, style, context, media, edit: result, image: result, driver: never };
  return { db, project, root, style, log, options, accountId, segments: listSegments(db, 'video'),
    failNext: () => { fail = true; } };
}

test('unapproved enqueue is empty and the generic worker cannot dispatch an injected motion job', async t => {
  const f = await fixture(t);
  assert.throws(() => enqueueMotionJobs(f.db, 'video'), /STYLE_NOT_APPROVED/);
  assert.equal(listJobs(f.db).length, 0);
  enqueueJob(f.db, { kind: 'motion', sourceVideoId: 'video' }, { projectId: f.project.id });
  const worker = createScheduler({ queue: f.db, accounts: f.db, driver: never });
  assert.equal(await worker.runOnce(), 'idle'); assert.equal(f.log.length, 0);
  assert.equal(await createMotionDispatcher(f.options).runOnce(), 'idle');
  f.style.approveStyle('video', 'owner'); enqueueMotionJobs(f.db, 'video');
  f.db.prepare("UPDATE motion_style_approvals SET status='pending' WHERE source_video_id='video'").run();
  assert.equal(await createMotionDispatcher(f.options).runOnce(), 'idle'); assert.equal(f.log.length, 0);
});

test('every segment selects a variant, hashes chain inputs and never chains across scenes', async t => {
  const f = await fixture(t); f.style.approveStyle('video', 'owner');
  enqueueMotionJobs(f.db, 'video'); enqueueMotionJobs(f.db, 'video');
  assert.equal(listJobs(f.db).length, 3);
  await createMotionDispatcher(f.options).runUntilIdle();
  const states = f.segments.map(s => getMotionState(f.db, s.id)!);
  for (const state of states) { assert.equal(state.status, 'done'); assert.ok(state.selectedVariantId); }
  assert.equal(states[0].chainOutFrameSha256, states[1].chainInFrameSha256);
  assert.equal(f.log.find(l => l.segment === f.segments[1].id)!.start, states[0].chainOutFrame);
  const bytes = await readFile(states[0].chainOutFrame!);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), states[1].chainInFrameSha256);
  assert.match(bytes.toString(), /^AI-WATERMARK/); assert.doesNotMatch(bytes.toString(), /FLOW-LOGO/);
  assert.equal(states[2].chainInFrameSha256, undefined);
});

test('insufficient budget pauses without any Flow call and approval resumes', async t => {
  const f = await fixture(t); f.style.approveStyle('video', 'owner');
  f.db.prepare('UPDATE projects SET budget=1 WHERE id=?').run(f.project.id);
  enqueueMotionJobs(f.db, 'video'); const worker = createMotionDispatcher(f.options);
  assert.equal(await worker.runUntilIdle(), 'idle'); assert.equal(f.log.length, 0);
  assert.equal(getMotionState(f.db, f.segments[0].id)!.status, 'awaiting_budget_approval');
  assert.equal(f.db.prepare('SELECT status FROM projects WHERE id=?').get(f.project.id)!.status, 'awaiting_budget_approval');
  approveMotionBudget(f.db, f.project.id, 1000); await worker.runUntilIdle();
  assert.ok(f.segments.every(s => getMotionState(f.db, s.id)!.status === 'done'));
});

test('fallback records first image, last image, video, with durable finished substeps', async t => {
  const f = await fixture(t); f.style.approveStyle('video', 'owner');
  enqueueMotionJobs(f.db, 'video', { mode: 'frames_then_video' });
  await createMotionDispatcher(f.options).runUntilIdle();
  for (const s of f.segments) {
    assert.deepEqual(f.log.filter(l => l.segment === s.id).map(l => l.kind), ['first_frame', 'last_frame', 'video']);
    const state = getMotionState(f.db, s.id)!;
    assert.deepEqual(state.operations.map(o => o.step), ['first_frame', 'last_frame', 'video']);
    assert.ok(state.steps['crop-first_frame']); assert.ok(state.steps['crop-last_frame']);
  }
});

test('restart opens the same database and skips segment 1 and completed fallback images', async t => {
  const f = await fixture(t); f.style.approveStyle('video', 'owner');
  enqueueMotionJobs(f.db, 'video', { mode: 'frames_then_video' });
  const worker = createMotionDispatcher(f.options); await worker.runOnce();
  f.failNext(); await worker.runOnce();
  const firstCalls = f.log.filter(l => l.segment === f.segments[0].id).length;
  const second = getMotionState(f.db, f.segments[1].id)!;
  assert.ok(second.steps.first_frame); assert.ok(second.steps.last_frame); assert.equal(second.steps.video, undefined);
  // Simulate an abandoned claim at process death, then recover through the same M6 loop.
  f.db.prepare("UPDATE render_jobs SET status='running' WHERE source_segment_id=?").run(f.segments[1].id);
  const reopened = new DatabaseSync(join(process.env.VIDFLOW_HOME!, 'vidflow.db'));
  try {
    reopened.exec('PRAGMA foreign_keys=ON'); migrate(reopened);
    await createMotionDispatcher({ ...f.options, db: reopened, style: new MotionStyleService(reopened) }).runUntilIdle();
    assert.equal(f.log.filter(l => l.segment === f.segments[0].id).length, firstCalls);
    assert.equal(f.log.filter(l => l.segment === f.segments[1].id && l.kind === 'first_frame').length, 1);
    assert.ok(f.segments.every(s => getMotionState(reopened, s.id)!.status === 'done'));
  } finally { reopened.close(); }
});

test('owner selection persists and requires acknowledgment before using a new downstream frame', async t => {
  const f = await fixture(t); f.style.approveStyle('video', 'owner'); enqueueMotionJobs(f.db, 'video');
  await createMotionDispatcher(f.options).runUntilIdle();
  const state = getMotionState(f.db, f.segments[0].id)!;
  selectVariant(f.db, f.segments[0].id, state.variants[1].id);
  assert.equal(getMotionState(f.db, f.segments[0].id)!.selectedVariantId, state.variants[1].id);
  const next = getMotionState(f.db, f.segments[1].id)!;
  assert.equal(next.status, 'needs_rerender'); assert.equal(next.chainInFrameSha256, undefined);
  const count = f.log.length; await createMotionDispatcher(f.options).runUntilIdle(); assert.equal(f.log.length, count);
  approveMotionRerender(f.db, f.segments[1].id); await createMotionDispatcher(f.options).runUntilIdle();
  assert.equal(getMotionState(f.db, f.segments[1].id)!.status, 'done');
});

test('image-only visual preview is ready under frames/motion and records approval visibility without breaking text approval', async t => {
  const f = await fixture(t);
  const preview = await completeVisualPreview({ ...f.options, sourceVideoId: 'video', accountId: f.accountId });
  assert.equal(preview.status, 'ready'); assert.ok(preview.comparison.startsWith(join(f.root, 'frames', 'motion')));
  assert.equal(preview.sha256, createHash('sha256').update(await readFile(preview.comparison)).digest('hex'));
  assert.ok(f.log.every(l => l.kind !== 'video'));
  assert.equal(f.style.approveStyle('video', 'owner').approvedWithVisualPreview, true);
  const count = f.log.length;
  await completeVisualPreview({ ...f.options, sourceVideoId: 'video', accountId: f.accountId });
  assert.equal(f.log.length, count);
  f.style.createStylePreview('video', 'cartoon_faceless');
  assert.equal(f.style.approveStyle('video', 'owner').approvedWithVisualPreview, false);
});

test('preview resumes after a derived-image failure without another paid image operation', async t => {
  const f = await fixture(t);
  let interrupted = true;
  const media = { ...f.options.media, async crop(file: string) {
    if (interrupted) { interrupted = false; throw new Error('Interrupted after download'); }
    return f.options.media.crop(file);
  } };
  const options = { ...f.options, media, sourceVideoId: 'video', accountId: f.accountId };
  await assert.rejects(completeVisualPreview(options), /Interrupted after download/);
  assert.equal(f.log.length, 1);
  const result = await completeVisualPreview(options);
  assert.equal(result.status, 'ready'); assert.equal(f.log.length, 1);
});

test('real M10.1 fake page: preview, fallback ordering, chain hash and unchanged AI pixels',
  { skip: !browserAvailable && BROWSER_SKIP_REASON }, async t => {
  try { resolveFfmpeg(); resolveFfprobe(); } catch { t.skip('ffmpeg/ffprobe unavailable'); return; }
  const f = await fixture(t);
  const session = await launchHeadless();
  const fake = await startFakeFlow({ credits: 10000, delayMs: 10 });
  try {
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(f.root, 'assets/source.mp4')], { timeoutMs: 30000 });
    await session.page.goto(fake.url + '/login');
    await session.page.locator('[data-testid="login-email"]').fill('fake');
    await Promise.all([session.page.waitForURL('**/project'), session.page.locator('[data-testid="login-submit"]').click()]);
    const selectors = { ...motionSelectors('mock'), creditCounter: { selector: '[data-testid="credit-balance"]' },
      errorBanner: { selector: '[data-testid="error-banner"]' }, 'verify-challenge': { selector: '[data-testid="verify-challenge"]' } };
    const context = () => ({ db: f.db, browser: session.context, url: fake.url + '/project', timeoutMs: 30000, selectors });
    const options = { db: f.db, style: f.style, context, driver: never };
    const preview = await completeVisualPreview({ ...options, sourceVideoId: 'video', accountId: f.accountId });
    assert.equal(preview.status, 'ready'); assert.equal(fake.state.jobs.length, 1);
    assert.equal(fake.state.jobs[0].mode, 'frameImage');
    f.style.approveStyle('video', 'owner');
    enqueueMotionJobs(f.db, 'video', { mode: 'frames_then_video' });
    await createMotionDispatcher(options).runUntilIdle();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(fake.state.jobs.slice(1 + i * 3, 4 + i * 3).map(j => j.mode === 'videoEdit' ? 'video' : j.frameKind),
        ['first_frame', 'last_frame', 'video']);
      assert.ok(getMotionState(f.db, f.segments[i].id)!.selectedVariantId);
    }
    const a = getMotionState(f.db, f.segments[0].id)!, b = getMotionState(f.db, f.segments[1].id)!;
    const videoJob = fake.state.jobs[6];
    const uploaded = Buffer.from(videoJob.references!.first_frame[0], 'base64');
    assert.equal(createHash('sha256').update(uploaded).digest('hex'), a.chainOutFrameSha256);
    assert.equal(b.chainInFrameSha256, a.chainOutFrameSha256);
    // Compare decoded RGB in the AI marker rectangle before/after the real crop.
    const selected = a.variants.find(v => v.id === a.selectedVariantId)!;
    const original = await motionMedia(f.root).frame(selected.file, 'last');
    const marker = FAKE_FLOW_AI_WATERMARK;
    const raw: Buffer[] = [];
    for (const file of [original, a.chainOutFrame!]) {
      const output = join(f.root, 'frames', 'motion', `${randomUUID()}.rgb`);
      await runFfmpeg(['-i', file, '-vf', `crop=${marker.width}:${marker.height}:${marker.x}:${marker.y}:exact=1`,
        '-pix_fmt', 'rgb24', '-frames:v', '1', '-f', 'rawvideo', output], { timeoutMs: 15000 });
      raw.push(await readFile(output));
    }
    assert.deepEqual(raw[0], raw[1]);
  } finally { await session.close(); await fake.close(); }
});
