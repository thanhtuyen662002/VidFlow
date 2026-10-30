import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db.ts';
import { createAccount, getAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { enqueueJob, getJob, claimNextJob, rejectJob } from '../src/flow/queue.ts';
import { createScheduler } from '../src/flow/scheduler.ts';
import type { FlowJobDriver, FlowJobResult } from '../src/flow/jobDriver.ts';
import { runFlowWorkerCommand } from '../src/flow/workerCli.ts';
import { createPageDriver } from '../src/flow/pageDriver.ts';
import { loadSelectors } from '../src/flow/selectors.ts';
import { startFakeFlow } from '../src/flow/mock/index.ts';
import { createProject } from '../src/repo/projects.ts';
import { createProjectDirectories } from '../src/paths.ts';
import { createLogger } from '../src/logger.ts';
import { redactString } from '../src/redact.ts';
import { browserAvailable, BROWSER_SKIP_REASON, launchHeadless } from './support/browser.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(process.cwd(), 'test', '.worker-'));
  const previous = process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME = home;
  const db = openDatabase();
  t.after(() => { db.close(); if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const account = (label: string) => { const row = createAccount(db, { label }); addEntry(db, { accountId: String(row.id), amount: 100, reason: 'Test credit' }); return String(row.id); };
  const logs: string[] = [];
  const io = { stdout: { write: (text: string) => logs.push(text) }, stderr: { write: (text: string) => logs.push(text) } };
  return { home, db, account, logs, io };
}

test('a: exhausted A returns job without attempt, B succeeds', async t => {
  const f = fixture(t), a = f.account('A'), b = f.account('B');
  const job = enqueueJob(f.db, {}), calls: string[] = [];
  // Pin deterministic selection regardless of random UUID tie breaking.
  f.db.prepare('UPDATE flow_accounts SET created_at=? WHERE id=?').run('2000', a);
  const driver: FlowJobDriver = { async run(_job, account) { calls.push(account.id); return account.id === a ? { kind: 'out_of_credit' } : { kind: 'success', media: [] }; } };
  const worker = createScheduler({ queue: f.db, accounts: f.db, driver });
  await worker.runOnce(); assert.equal(getJob(f.db, String(job.id))!.attempts, 0);
  await worker.runUntilIdle(); assert.deepEqual(calls, [a, b]);
  assert.equal(getAccount(f.db, a)!.status, 'out_of_credit'); assert.equal(getJob(f.db, String(job.id))!.status, 'done');
});

test('b: refusal stores reason and is submitted once', async t => {
  const f = fixture(t); f.account('A'); const job = enqueueJob(f.db, {}); let calls = 0;
  const worker = createScheduler({ queue: f.db, accounts: f.db, driver: { async run() { calls++; return { kind: 'refused', reason: 'Prompt rejected by policy' }; } } });
  await worker.runUntilIdle(); await worker.runUntilIdle(); assert.equal(calls, 1);
  assert.equal(getJob(f.db, String(job.id))!.status, 'rejected'); assert.equal(getJob(f.db, String(job.id))!.error, 'Prompt rejected by policy');
});

test('c: verification releases every assigned job and excludes A until reset', async t => {
  const f = fixture(t), a = f.account('A'); const ids = [enqueueJob(f.db, {}).id, enqueueJob(f.db, {}).id];
  f.db.prepare("UPDATE render_jobs SET account_id=? WHERE payload IS NOT NULL").run(a);
  let calls = 0;
  const worker = createScheduler({ queue: f.db, accounts: f.db, logger: event => f.logs.push(JSON.stringify(event)), driver: { async run() { calls++; return { kind: 'verification_required' }; } } });
  await worker.runUntilIdle(); assert.equal(calls, 1); assert.equal(getAccount(f.db, a)!.status, 'needs_owner');
  for (const id of ids) { const job = getJob(f.db, String(id))!; assert.equal(job.status, 'queued'); assert.equal(job.account_id, null); }
  assert.match(f.logs.join(''), /owner_action_required/);
  assert.equal(await worker.runOnce(), 'no_account'); assert.equal(calls, 1);
});

test('bounded transient errors and no eligible account leave no running job', async t => {
  const f = fixture(t), job = enqueueJob(f.db, {}); let calls = 0;
  const worker = createScheduler({ queue: f.db, accounts: f.db, driver: { async run() { calls++; throw new Error('token=private'); } } });
  assert.equal(await worker.runOnce(), 'no_account'); assert.equal(getJob(f.db, String(job.id))!.attempts, 0);
  f.account('A'); await worker.runUntilIdle(); assert.equal(calls, 3); assert.equal(getJob(f.db, String(job.id))!.status, 'failed');
});

test('e: CLI parses account, queue, run, force retry and rejects invalid arguments', async t => {
  const f = fixture(t), a = f.account('A'), job = enqueueJob(f.db, {}), id = String(job.id);
  const command = (args: string[]) => runFlowWorkerCommand(args, f.io, { db: f.db, driver: { async run() { return { kind: 'success', media: [] }; } } });
  for (const args of [['account', 'list'], ['account', 'show', a], ['account', 'mark', a, 'needs_owner'], ['account', 'reset', a], ['queue', 'list', '--state', 'queued'], ['queue', 'show', id]]) assert.equal(await command(args), 0);
  assert.match(f.logs.join(''), /cần chủ sở hữu/);
  claimNextJob(f.db, 'test', { accountId: a }); rejectJob(f.db, id, 'test', 'Policy');
  assert.equal(await command(['queue', 'retry', id]), 1); assert.equal(getJob(f.db, id)!.status, 'rejected');
  assert.equal(await command(['queue', 'retry', id, '--force']), 0);
  assert.equal(await command(['queue', 'cancel', id]), 0); assert.equal(getJob(f.db, id)!.error, 'Đã hủy');
  assert.equal(await command(['queue', 'retry', id]), 0); assert.equal(await command(['run', '--once']), 0); assert.equal(getJob(f.db, id)!.status, 'done');
  for (const args of [['account', 'add'], ['account', 'import'], ['account', 'list', 'extra'], ['account', 'mark', a, 'bogus'], ['queue', 'list', '--state', 'bogus'], ['queue', 'retry'], ['run', '--force']]) assert.equal(await command(args), 1);
});

const secrets = ['secretcookie123', 'secret-token-456', 'ya29.fakeToken789', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fakeSignature'];
const seeded = `SID=${secrets[0]} token=${secrets[1]} Authorization: Bearer ${secrets[2]}\n${secrets[3]}\nOAuth ${secrets[1]}`;
function scan(directory: string, captured: string[]) {
  const texts = [...captured];
  function walk(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else texts.push(readFileSync(file, 'utf8')); } }
  walk(directory);
  for (const text of texts) for (const secret of secrets) assert.ok(!text.includes(secret), 'secret leaked in logs/evidence');
}

test('d: all scheduler outcomes and CLI logs redact seeded cookie, OAuth and JWT secrets', async t => {
  const f = fixture(t), a = f.account(seeded), logger = createLogger();
  const evidence = join(f.home, 'evidence'); mkdirSync(evidence);
  writeFileSync(join(evidence, 'note.txt'), redactString(seeded));
  for (const result of [{ kind: 'out_of_credit' }, { kind: 'refused', reason: seeded }, { kind: 'verification_required' }] as FlowJobResult[]) {
    f.db.prepare("UPDATE flow_accounts SET status='ready' WHERE id=?").run(a);
    enqueueJob(f.db, {});
    const worker = createScheduler({ queue: f.db, accounts: f.db, logger: event => { logger.info(event); f.logs.push(JSON.stringify(event)); }, driver: { async run() { return result; } } });
    await worker.runOnce();
  }
  await runFlowWorkerCommand(['account', 'list'], f.io, { db: f.db });
  await runFlowWorkerCommand(['queue', 'list'], f.io, { db: f.db });
  scan(join(f.home, 'logs'), f.logs); scan(evidence, f.logs);
});

for (const scenario of ['out_of_credit', 'refused', 'verification'] as const) {
  test(`page mock a–d: ${scenario}`, { skip: !browserAvailable && BROWSER_SKIP_REASON }, async t => {
    const f = fixture(t), a = f.account(seeded), b = scenario === 'out_of_credit' ? f.account('B') : undefined;
    f.db.prepare('UPDATE flow_accounts SET created_at=? WHERE id=?').run('2000', a);
    const mockA = await startFakeFlow({ credits: scenario === 'out_of_credit' ? 0 : 100, rejectPrompt: scenario === 'refused', verification: scenario === 'verification', delayMs: 20 });
    t.after(() => mockA.close());
    const mockB = b ? await startFakeFlow({ delayMs: 20 }) : undefined; if (mockB) t.after(() => mockB.close());
    const project = createProject(f.db, 'Worker', '16:9', null), root = createProjectDirectories(project.id);
    const first = enqueueJob(f.db, { prompt: seeded, outputDir: join(root, 'renders') }, { projectId: project.id });
    const second = scenario === 'verification' ? enqueueJob(f.db, { prompt: 'Another', outputDir: join(root, 'renders') }, { projectId: project.id }) : undefined;
    if (second) f.db.prepare('UPDATE render_jobs SET account_id=? WHERE id IN (?,?)').run(a, first.id, second.id);
    const calls: string[] = [], logger = createLogger();
    const driver = createPageDriver(async accountId => {
      calls.push(accountId);
      const session = await launchHeadless();
      try {
        const url = accountId === a ? mockA.url : mockB!.url;
        await session.page.goto(url + '/login');
        await session.page.locator(loadSelectors()['login-email'].selector).fill('fake@example.test');
        await Promise.all([session.page.waitForURL('**/project'), session.page.locator(loadSelectors()['login-submit'].selector).click()]);
        await session.context.addCookies([{ name: 'SID', value: secrets[0], url }]);
        // Context.close does not close the owning browser; register browser cleanup separately.
        t.after(() => session.close());
        return { db: f.db, browser: session.context, url: url + '/project', selectors: loadSelectors(), timeoutMs: 10000, record: entry => { logger.info(entry); f.logs.push(JSON.stringify(entry)); }, evidenceRunId: String(first.id) };
      } catch (error) { await session.close(); throw error; }
    });
    const scheduler = createScheduler({ queue: f.db, accounts: f.db, driver, timeoutMs: 10000, logger: event => { logger.info(event); f.logs.push(JSON.stringify(event)); } });
    await scheduler.runUntilIdle(); await scheduler.runUntilIdle();
    const row = getJob(f.db, String(first.id))!;
    if (scenario === 'out_of_credit') { assert.deepEqual(calls, [a, b]); assert.equal(row.status, 'done'); assert.equal(getAccount(f.db, a)!.status, 'out_of_credit'); assert.ok(JSON.parse(String(row.output_media))[0].bytes > 0); }
    else if (scenario === 'refused') { assert.deepEqual(calls, [a]); assert.equal(row.status, 'rejected'); assert.equal(row.error, 'Prompt rejected by policy'); }
    else { assert.deepEqual(calls, [a]); assert.equal(getAccount(f.db, a)!.status, 'needs_owner'); for (const id of [first.id, second!.id]) { const pending = getJob(f.db, String(id))!; assert.equal(pending.status, 'queued'); assert.equal(pending.account_id, null); } assert.match(f.logs.join(''), /owner_action_required/); }
    scan(join(f.home, 'logs'), f.logs);
    // Evidence is optional, but scan every file when the driver generated it.
    const { existsSync } = await import('node:fs');
    if (existsSync(join(f.home, 'evidence'))) scan(join(f.home, 'evidence'), f.logs);
  });
}

test('page boundary maps outcomes and strips secrets without loading a browser', async t => {
  const f = fixture(t), a = f.account('A');
  const project = createProject(f.db, 'Boundary', '16:9', null), root = createProjectDirectories(project.id);
  const job = enqueueJob(f.db, { prompt: seeded, outputDir: join(root, 'renders') }, { projectId: project.id });
  const { statSync } = await import('node:fs');
  const { createPageDriver } = await import('../src/flow/pageDriver.ts');
  let closed = 0;
  const driver = createPageDriver(async () => ({
    db: f.db, browser: {} as import('../src/flow/driver.ts').FlowDriverContext['browser'], url: 'http://mock.invalid', timeoutMs: 500,
    page: {
      async guard() {}, async goto() {}, async fill() {}, async click() {}, async upload() {},
      async credits() { return 100; }, async download() { throw new Error('unexpected download'); },
      async text(name) { return name === 'errorBanner' ? 'Prompt rejected by policy token=secret-token-456' : ''; },
    },
  }), async () => { closed++; });
  const result = await driver.run(job as unknown as import('../src/flow/jobDriver.ts').WorkerJob, { id: a, status: 'ready' }, { timeoutMs: 500 });
  assert.equal(result.kind, 'refused'); assert.equal(closed, 1);
  if (result.kind === 'refused') { assert.match(result.reason, /Prompt rejected/); assert.ok(!result.reason.includes(secrets[1])); }
  assert.ok(statSync(root).isDirectory());
});

test('verification releases another running worker', async t => {
  const f = fixture(t), a = f.account('A');
  const first = enqueueJob(f.db, {}), second = enqueueJob(f.db, {});
  const scheduler = createScheduler({ queue: f.db, accounts: f.db, driver: { async run() {
    const assigned = claimNextJob(f.db, 'another-worker', { accountId: a }); assert.ok(assigned);
    return { kind: 'verification_required' };
  } } });
  await scheduler.runOnce();
  for (const id of [first.id, second.id]) { const row = getJob(f.db, String(id))!; assert.equal(row.status, 'queued'); assert.equal(row.account_id, null); assert.equal(row.worker_id, null); }
  assert.equal(await scheduler.runOnce(), 'no_account');
});
