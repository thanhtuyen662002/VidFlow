import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.ts';
import { createProjectDirectories } from '../src/paths.ts';
import { createAccount, getAccount } from '../src/flow/accounts.ts';
import { enqueueJob } from '../src/flow/queue.ts';
import { editVideo, generateFrameImage } from '../src/flow/driver.ts';
import type { ActionEntry } from '../src/flow/driver.ts';
import { motionSelectors, motionSelectorNames } from '../src/flow/selectors.ts';
import { runSelftest, playwrightPageAdapter } from '../src/flow/selftest.ts';
import { startFakeFlow, FAKE_FLOW_PRICES } from '../src/flow/mock/index.ts';
import { runFfmpeg, runFfprobe } from '../src/media/runner.ts';
import { resolveFfmpeg, resolveFfprobe } from '../src/media/discovery.ts';
import { browserAvailable, BROWSER_SKIP_REASON, launchHeadless } from './support/browser.ts';

test('motion selftest reports omitted, empty, and broken selectors by group', async () => {
  const selectors = motionSelectors('mock');
  assert.equal((await runSelftest({ countSelector: async () => 1 }, 'mock', selectors)).ok, true);
  delete selectors['videoEdit.video'];
  selectors['frameImage.prompt'] = { selector: '' };
  selectors['videoEdit.submit'] = { selector: '#broken' };
  const report = await runSelftest({ countSelector: async s => s === '#broken' ? 0 : 1 }, 'mock', selectors);
  for (const name of ['videoEdit.video', 'frameImage.prompt']) assert.equal(report.results.find(r => r.name === name)?.status, 'chua_dien');
  assert.equal(report.results.find(r => r.name === 'videoEdit.submit')?.status, 'hong');
  assert.ok(Object.values(motionSelectors('real')).every(entry => !entry.selector && entry.note?.includes('Owner')));
});

for (const scenario of ['generate', 'verify-edit', 'verify-frame', 'verify-after'] as const) {
  test(`Flow motion: ${scenario}`, { skip: !browserAvailable && BROWSER_SKIP_REASON }, async t => {
    try { resolveFfmpeg(); } catch { t.skip('ffmpeg not found in PATH or VIDFLOW_FFMPEG'); return; }
    const home = mkdtempSync(join(tmpdir(), 'vidflow-motion-'));
    const previous = process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME = home;
    let cleanupDb: ReturnType<typeof openDatabase> | undefined;
    let cleanupSession: Awaited<ReturnType<typeof launchHeadless>> | undefined;
    let cleanupFake: Awaited<ReturnType<typeof startFakeFlow>> | undefined;
    t.after(async () => {
      try { await cleanupSession?.close(); await cleanupFake?.close(); cleanupDb?.close(); }
      finally {
        if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });
    const db = cleanupDb = openDatabase();
    const session = cleanupSession = await launchHeadless();
    const fake = cleanupFake = await startFakeFlow({ delayMs: 20 });
    await session.page.goto(fake.url + '/login');
    await session.page.locator('[data-testid="login-email"]').fill('fake');
    await Promise.all([session.page.waitForURL('**/project'), session.page.locator('[data-testid="login-submit"]').click()]);
    const selectors = { ...motionSelectors('mock'),
      creditCounter: { selector: '[data-testid="credit-balance"]' }, errorBanner: { selector: '[data-testid="error-banner"]' },
      'verify-challenge': { selector: '[data-testid="verify-challenge"]' } };
    await session.page.goto(fake.url + '/selftest');
    const report = await runSelftest(playwrightPageAdapter(session.page), 'mock', selectors);
    assert.equal(report.ok, true, JSON.stringify(report.results.filter(r => r.status !== 'dat')));
    assert.ok(motionSelectorNames.every(name => report.results.some(r => r.name === name)));
    const projectId = randomUUID(); const root = createProjectDirectories(projectId);
    const sourceVideo = join(root, 'assets', 'source.mp4'); const image = join(root, 'refs', 'reference.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-c:v', 'mpeg4', sourceVideo], { timeoutMs: 15000 });
    await runFfmpeg(['-i', sourceVideo, '-frames:v', '1', image], { timeoutMs: 15000 });
    const accountId = createAccount(db, { label: 'Motion test' }).id as string;
    const entries: ActionEntry[] = [];
    const ctx = { db, browser: session.context, url: fake.url + '/project', timeoutMs: 20000, selectors, record: (entry: ActionEntry) => entries.push(entry) };
    const job = { id: enqueueJob(db, {}).id as string, projectId, accountId, prompt: 'private token=SECRET cookie=PRIVATE', outputDir: join(root, 'renders'), sourceVideo, variants: 3,
      references: { character: [image], setting: [image], style: [image], first_frame: [image], last_frame: [image] } };
    if (scenario !== 'generate') {
      fake.setScenario(scenario === 'verify-after' ? { onGenerate: () => fake.setScenario({ verification: true }) } : { verification: true });
      const result = scenario === 'verify-frame' ? await generateFrameImage({ ...job, frameKind: 'first_frame' }, ctx) : await editVideo(job, ctx);
      assert.equal(result.kind, 'verification_required'); assert.equal(getAccount(db, accountId)?.status, 'needs_owner');
      assert.equal(fake.state.submitAttempts, scenario === 'verify-after' ? 1 : 0);
      const detection = entries.findIndex(entry => entry.target === 'verification-detected'); assert.ok(detection >= 0);
      assert.equal(entries.slice(detection + 1).some(entry => ['fill', 'click', 'upload'].includes(entry.action)), false);
    } else {
      const result = await editVideo(job, ctx); assert.equal(result.kind, 'completed', JSON.stringify(result));
      if (result.kind !== 'completed') return;
      assert.equal(result.files.length, 3); assert.equal(readdirSync(job.outputDir).length, 3);
      assert.equal(result.creditsCharged, FAKE_FLOW_PRICES.videoEdit * 3);
      assert.equal(result.accountId, accountId); assert.ok(result.durationMs >= 0);
      assert.equal(fake.state.uploadedFiles.length, 6);
      assert.equal(fake.state.jobs[0].prompt, job.prompt);
      assert.deepEqual(readFileSync(fake.state.uploadedFiles[0]), readFileSync(sourceVideo));
      for (const uploaded of fake.state.uploadedFiles.slice(1)) assert.deepEqual(readFileSync(uploaded), readFileSync(image));
      assert.equal((await editVideo(job, ctx)).kind, 'failed'); assert.equal(fake.state.submitAttempts, 1);
      for (const file of result.files) {
        assert.equal(readFileSync(file).toString('ascii', 4, 8), 'ftyp');
        let probe = false; try { resolveFfprobe(); probe = true; } catch { t.diagnostic('ffprobe not found; checking MP4 signature only'); }
        if (probe) assert.match((await runFfprobe(['-v', 'error', '-show_streams', file], { timeoutMs: 15000 })).stdout, /codec_type=video/);
      }
      for (const frameKind of ['first_frame', 'last_frame'] as const) {
        // Deliberately retain sourceVideo and variants from the video job: frame mode
        // must still use only its own controls and produce exactly one image.
        const actionStart = entries.length;
        const frame = await generateFrameImage({ ...job, id: enqueueJob(db, {}).id as string, frameKind }, ctx);
        assert.equal(frame.kind, 'completed', JSON.stringify({ result: frame, actions: entries.slice(actionStart) }));
        if (frame.kind === 'completed') {
          assert.equal(frame.files.length, 1);
          const frameActions = entries.slice(actionStart);
          assert.ok(frameActions.some(entry => entry.target === 'frameImage.kind'));
          assert.equal(frameActions.some(entry => entry.target === 'frameImage.video' || entry.target === 'frameImage.variants'), false);
          assert.equal(readFileSync(frame.files[0]).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          assert.equal(frame.creditsCharged, FAKE_FLOW_PRICES.frameImage);
          assert.equal(fake.state.jobs.at(-1)?.frameKind, frameKind);
        }
      }
      assert.equal(fake.state.credits, 100 - 3 * FAKE_FLOW_PRICES.videoEdit - 2 * FAKE_FLOW_PRICES.frameImage);
    }
    assert.doesNotMatch(JSON.stringify(entries), /SECRET|PRIVATE|private token|fake_session/);
  });
}
