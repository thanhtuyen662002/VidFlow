import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate, migrations } from '../src/migrations.ts';
import { openDatabase } from '../src/db.ts';
import { createProject, getProject, listProjects, updateProject } from '../src/repo/projects.ts';
import { createAccount, deleteAccount } from '../src/repo/accounts.ts';
import { addEntry, getBalance, listEntries, getProjectBudgetStatus } from '../src/repo/ledger.ts';

test('ledger balances, project budgets and entries survive reopening', t => {
  temporaryDatabase(t);
  let db = openDatabase();
  try {
    const a = createProject(db, 'A', '16:9', 80), b = createProject(db, 'B', '16:9', null);
    updateProject(db, a.id, { budget: 120 });
    const x = createAccount(db, { label: 'X' }), y = createAccount(db, { label: 'Y' });
    for (const [projectId, accountId, delta] of [[a.id, x.id, 100], [a.id, x.id, -30], [a.id, y.id, -20], [b.id, y.id, 50]] as const) {
      addEntry(db, { projectId, accountId, delta, reason: 'test', refType: 'scene', refId: 'example' });
    }
    const entries = listEntries(db);
    assert.deepEqual(entries, [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    for (const delta of [0, 1.5, NaN, Infinity]) assert.throws(() => addEntry(db, { projectId: a.id, delta, reason: 'bad' }));
    assert.throws(() => addEntry(db, { projectId: 'missing', delta: 1, reason: 'bad' }));
    assert.throws(() => addEntry(db, { projectId: a.id, accountId: 'missing', delta: 1, reason: 'bad' }));
    assert.throws(() => deleteAccount(db, x.id));
    assert.throws(() => db.prepare('DELETE FROM accounts WHERE id=?').run(x.id));
    db.close(); db = openDatabase();
    assert.deepEqual(listEntries(db), entries);
    assert.equal(getBalance(db, { projectId: a.id }), 50);
    assert.equal(getBalance(db, { projectId: b.id }), 50);
    assert.equal(getBalance(db, { accountId: x.id }), 70);
    assert.equal(getBalance(db, { accountId: y.id }), 30);
    assert.equal(getBalance(db, { projectId: a.id, accountId: y.id }), -20);
    assert.equal(getBalance(db, { projectId: 'missing' }), 0);
    assert.equal(listEntries(db, { projectId: a.id, accountId: x.id }).length, 2);
    assert.equal(getProject(db, a.id)?.budget, 120);
    assert.equal(listProjects(db).find(p => p.id === a.id)?.budget, 120);
    assert.deepEqual(getProjectBudgetStatus(db, a.id), { budget: 120, spent: 50, remaining: 70 });
    assert.deepEqual(getProjectBudgetStatus(db, b.id), { budget: null, spent: 0, remaining: null });
  } finally { db.close(); }
});

test('new migration preserves legacy ledger usage and account metadata', t => {
  const db = temporaryDatabase(t); migrate(db, migrations.slice(0, 2));
  const p = createProject(db, 'Legacy', '16:9', 100);
  db.exec("INSERT INTO accounts(id,label,type,profile) VALUES ('a','Old','Pro','profiles/a')");
  db.prepare('INSERT INTO credit_ledger(id,project_id,account_id,credits,created_at) VALUES (?,?,?,?,?)').run('entry', p.id, 'a', 30, '2026-01-01');
  migrate(db);
  assert.equal(getBalance(db, { projectId: p.id }), -30);
  assert.equal(listEntries(db)[0].accountId, 'a');
  assert.deepEqual(getProjectBudgetStatus(db, p.id), { budget: 100, spent: 30, remaining: 70 });
});
