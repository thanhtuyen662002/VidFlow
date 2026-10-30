import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.ts';
import { createAccount, getAccount } from '../src/flow/accounts.ts';
import { enqueueJob } from '../src/flow/queue.ts';
import { chargeJob, listEntries } from '../src/flow/credits.ts';
import { flowDriver } from '../src/flow/driver.ts';
import type { ActionEntry } from '../src/flow/driver.ts';
import { loadSelectors } from '../src/flow/selectors.ts';
import { createProjectDirectories, getRunEvidenceDir } from '../src/paths.ts';
import { browserAvailable, BROWSER_SKIP_REASON, launchHeadless } from './support/browser.ts';

for (const scenario of ['ok', 'rejected', 'no_credit', 'verification', 'verification_after', 'broken']) {
  test(`Flow driver: ${scenario}`, { skip: !browserAvailable && BROWSER_SKIP_REASON }, async t => {
    const home = mkdtempSync(join(process.cwd(), 'test', '.driver-home-'));
    const previous = process.env.VIDFLOW_HOME;
    process.env.VIDFLOW_HOME = home;
    const db = openDatabase();
    const session = await launchHeadless();
    const server = createServer((req, res) => {
      if (req.url === '/result.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename=result.mp4' });
        res.end('mock download');
      } else { res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(new URL('./fixtures/flow-mock/index.html', import.meta.url))); }
    });
    t.after(async () => {
      await session.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const accountId = createAccount(db, { label: 'Test' }).id as string;
    const id = enqueueJob(db, {}).id as string;
    const projectId = randomUUID();
    const project = createProjectDirectories(projectId);
    const image = join(project, 'refs', 'input.png'); writeFileSync(image, 'fixture');
    const job = { id, accountId, projectId, prompt: 'private prompt owner@example.com token=secret', images: [image], outputDir: join(project, 'renders') };
    const entries: ActionEntry[] = [];
    const selectors = loadSelectors();
    if (scenario === 'broken') selectors.promptInput = { selector: '#missing' };
    const ctx = { db, browser: session.context, url: `http://127.0.0.1:${address.port}/?scenario=${scenario}`, timeoutMs: scenario === 'broken' ? 200 : 5000,
      selectors, record: (entry: ActionEntry) => entries.push(entry), evidenceRunId: id };
    const result = await flowDriver.runJob(job, ctx);
    if (scenario === 'ok') {
      assert.equal(result.kind, 'completed');
      if (result.kind !== 'completed') return;
      assert.equal(result.creditsBefore, 100); assert.equal(result.creditsAfter, 90); assert.equal(result.creditsCharged, 10);
      assert.ok(existsSync(result.files[0])); assert.equal(readFileSync(result.files[0], 'utf8'), 'mock download');
      const again = await flowDriver.runJob({ ...job, takeIndex: 1 }, ctx);
      assert.deepEqual(again, { kind: 'failed', error: 'Job already charged; use the existing take', retryable: false });
      assert.equal(listEntries(db, accountId).length, 1); assert.equal(listEntries(db, accountId)[0].amount, -10);
    } else if (scenario === 'rejected') {
      assert.deepEqual(result, { kind: 'rejected', reason: 'Prompt rejected by policy: unsafe content' });
    } else if (scenario === 'no_credit') assert.equal(result.kind, 'out_of_credits');
    else if (scenario.startsWith('verification')) {
      assert.equal(result.kind, 'verification_required'); assert.equal(getAccount(db, accountId)!.status, 'needs_owner');
      const detection = entries.find(entry => entry.target === 'verification-detected'); assert.ok(detection);
      assert.equal(entries.filter(entry => entry.seq > detection.seq && ['goto', 'fill', 'click', 'upload'].includes(entry.action)).length, 0);
      if (scenario === 'verification') assert.equal(entries.some(entry => entry.action === 'fill'), false);
      else assert.ok(entries.some(entry => entry.action === 'click'));
      assert.equal(session.context.pages().length, 1);
    } else {
      assert.equal(result.kind, 'failed');
      const evidence = readFileSync(join(getRunEvidenceDir(id), 'note.txt'), 'utf8');
      assert.ok(!evidence.includes(job.prompt)); assert.ok(!evidence.includes('owner@example.com'));
    }
    if (scenario !== 'ok') assert.equal(listEntries(db, accountId).length, 0);
    const log = JSON.stringify(entries);
    for (const secret of [job.prompt, 'owner@example.com', image, 'token=secret']) assert.ok(!log.includes(secret));
    assert.deepEqual(entries.map(entry => entry.seq), entries.map((_, i) => i + 1));
  });
}

test('credit charge uses queue job ID once', t => {
  const home = mkdtempSync(join(process.cwd(), 'test', '.charge-home-'));
  const previous = process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME = home;
  const db = openDatabase();
  t.after(() => { db.close(); if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const accountId = createAccount(db, { label: 'Test' }).id as string;
  const jobId = enqueueJob(db, {}).id as string;
  chargeJob(db, accountId, jobId, 10); chargeJob(db, accountId, jobId, 10);
  assert.equal(listEntries(db, accountId).length, 1);
  assert.equal(listEntries(db, accountId)[0].amount, -10);
});
