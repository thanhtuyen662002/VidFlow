import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db.ts';
import * as accounts from '../src/flow/accounts.ts';
import * as credits from '../src/flow/credits.ts';
import * as queue from '../src/flow/queue.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(process.cwd(), 'test', '.flow-home-'));
  const previous = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = home;
  const connections: ReturnType<typeof openDatabase>[] = [];
  const open = () => { const db = openDatabase(); connections.push(db); return db; };
  const close = (db: ReturnType<typeof openDatabase>) => { db.close(); connections.splice(connections.indexOf(db), 1); };
  t.after(() => {
    for (const db of connections) db.close();
    if (previous === undefined) delete process.env.VIDFLOW_HOME;
    else process.env.VIDFLOW_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return { open, close };
}

test('independent connections claim each job once, in priority order', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  for (let i = 0; i < 20; i++) queue.enqueueJob(a, { i });
  const urgent = queue.enqueueJob(a, {}, { priority: 10 });
  assert.equal(queue.claimNextJob(b, 'urgent')!.id, urgent.id);
  const claimed = [urgent.id];
  for (;;) {
    const results = await Promise.all([a, b].map(async (db, i) => queue.claimNextJob(db, `worker-${i}`)));
    if (results.every(job => job === null)) break;
    for (const job of results) if (job) claimed.push(job.id);
  }
  assert.equal(claimed.length, 21);
  assert.equal(new Set(claimed).size, 21);
  assert.equal(queue.claimNextJob(a, 'extra'), null);
  for (const job of queue.listJobs(a)) {
    assert.equal(job.status, 'running');
    assert.ok(job.worker_id);
    assert.equal(job.attempts, 1);
  }
});

test('release and terminal transitions require the owning worker', t => {
  const f = fixture(t), db = f.open();
  const job = queue.enqueueJob(db, {}), id = job.id as string;
  queue.claimNextJob(db, 'one');
  assert.equal(queue.releaseJob(db, id, 'other'), false);
  assert.equal(queue.completeJob(db, id, 'other'), false);
  assert.equal(queue.rejectJob(db, id, 'other', 'reason'), false);
  assert.equal(queue.failJob(db, id, 'other', 'error'), false);
  assert.equal(queue.releaseJob(db, id, 'one'), true);
  assert.equal(queue.releaseJob(db, id, 'one'), false);
  assert.equal(queue.claimNextJob(db, 'two')!.attempts, 2);
  assert.equal(queue.claimNextJob(db, 'extra'), null);
  assert.equal(queue.completeJob(db, id, 'two'), true);
  assert.equal(queue.getJob(db, id)!.status, 'done');
  for (const status of ['rejected', 'failed'] as const) {
    const next = queue.enqueueJob(db, {});
    queue.claimNextJob(db, 'owner');
    assert.equal(status === 'rejected' ? queue.rejectJob(db, next.id as string, 'owner', 'policy') : queue.failJob(db, next.id as string, 'owner', 'network'), true);
    assert.equal(queue.getJob(db, next.id as string)!.status, status);
  }
});

test('signed credit ledger sums, validates input and is append only', t => {
  const f = fixture(t), db = f.open();
  const a = accounts.createAccount(db, { label: 'A' }).id as string;
  const b = accounts.createAccount(db, { label: 'B' }).id as string;
  const job = queue.enqueueJob(db, {}).id as string;
  for (const amount of [100, -30, 5, -10]) credits.addEntry(db, { accountId: a, amount, reason: 'test', jobId: amount < 0 ? job : null });
  assert.equal(credits.getBalance(db, a), 65);
  assert.equal(credits.getBalance(db, a), credits.listEntries(db, a).reduce((sum, row) => sum + Number(row.amount), 0));
  assert.equal(credits.getBalance(db, b), 0);
  for (const reason of ['', '  ']) assert.throws(() => credits.addEntry(db, { accountId: a, amount: 1, reason }));
  for (const amount of [1.5, NaN, Infinity]) assert.throws(() => credits.addEntry(db, { accountId: a, amount, reason: 'invalid' }));
  assert.throws(() => db.prepare('DELETE FROM credit_ledger WHERE account_id=?').run(a));
  assert.throws(() => db.prepare('UPDATE credit_ledger SET amount=0 WHERE account_id=?').run(a));
});

test('account status, released job and ledger survive close and reopen', t => {
  const f = fixture(t);
  let db = f.open();
  const account = accounts.createAccount(db, { label: 'Persist' }).id as string;
  accounts.setAccountStatus(db, account, 'needs_owner', 'Verification');
  assert.throws(() => accounts.setAccountStatus(db, account, 'bad' as never));
  const job = queue.enqueueJob(db, { prompt: 'test' }).id as string;
  credits.addEntry(db, { accountId: account, amount: 50, reason: 'Top up', jobId: job });
  queue.claimNextJob(db, 'worker', { accountId: account });
  queue.releaseJob(db, job, 'worker');
  f.close(db); db = f.open();
  assert.equal(accounts.getAccount(db, account)!.status, 'needs_owner');
  assert.equal(accounts.getAccount(db, account)!.status_reason, 'Verification');
  assert.equal(accounts.listAccounts(db, { status: 'needs_owner' }).length, 1);
  assert.equal(queue.getJob(db, job)!.status, 'queued');
  assert.equal(queue.getJob(db, job)!.worker_id, null);
  assert.equal(credits.listEntries(db, account).length, 1);
  assert.equal(credits.getBalance(db, account), 50);
});
