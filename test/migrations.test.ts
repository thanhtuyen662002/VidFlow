import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { latestVersion, migrate, migrations } from '../src/migrations.ts';
import { openDatabase } from '../src/db.ts';

const insertProject = `INSERT INTO projects (id, name, aspect, budget, directory, created_at)
  VALUES ('p', 'Project', '16:9', 100, 'projects/p', '2026-01-01')`;

test('fresh connection migrates all entities and enables foreign keys on every open', t => {
  temporaryDatabase(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase();
    try {
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, latestVersion);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
      for (const name of ['projects', 'bibles', 'references', 'script_variants', 'scenes', 'chains',
        'render_jobs', 'takes', 'selections', 'accounts', 'credit_ledger', 'assets', 'migrations']) {
        assert.ok(tables.includes(name), name);
      }
      assert.ok(existsSync(join(process.env.VIDFLOW_HOME!, 'vidflow.db')));
    } finally { db.close(); }
  }
});

test('second migration preserves all data and bookkeeping', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  db.exec(insertProject);
  const before = db.prepare('SELECT * FROM projects').all();
  const history = db.prepare('SELECT version, name, applied_at FROM migrations').all();
  assert.equal(history.length, migrations.length);
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM projects').all(), before);
  assert.deepEqual(db.prepare('SELECT version, name, applied_at FROM migrations').all(), history);
});

test('upgrade keeps version 1 rows and records version 2 once', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  db.exec(insertProject);
  const list = [...migrations, { version: 2, name: 'Extra field', sql: 'ALTER TABLE projects ADD COLUMN notes TEXT' }];
  migrate(db, list);
  assert.equal(db.prepare('SELECT name FROM projects').get()!.name, 'Project');
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
  migrate(db, list);
  assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 2);
});

test('future version reports database and code versions', t => {
  const db = temporaryDatabase(t);
  db.exec(`PRAGMA user_version = ${latestVersion + 1}`);
  assert.throws(() => migrate(db), new RegExp(`version ${latestVersion + 1}.*version ${latestVersion}`));
});

test('failure rolls back schema, data, history and version together', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  db.exec(insertProject);
  assert.throws(() => migrate(db, [...migrations, {
    version: 2, name: 'Failure', sql: 'CREATE TABLE scratch (id TEXT); DELETE FROM projects; INVALID SQL;'
  }]));
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 1);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'scratch'").get(), undefined);
});

test('reference shape, project-scoped uniqueness and cascade match the CLI contract', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  db.exec(insertProject);
  db.exec(`INSERT INTO "references" (id, project_id, name, role) VALUES ('r', 'p', 'Hero', 'character')`);
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM "references"').get()!),
    ['id', 'project_id', 'name', 'role', 'images', 'description', 'priority']);
  assert.throws(() => db.exec(`INSERT INTO "references" (id, project_id, name, role) VALUES ('s', 'p', 'Hero', 'character')`));
  assert.throws(() => db.exec(`INSERT INTO "references" (id, project_id, name, role) VALUES ('s', 'missing', 'Other', 'character')`));
  db.exec("DELETE FROM projects WHERE id = 'p'");
  assert.equal(db.prepare('SELECT count(*) AS n FROM "references"').get()!.n, 0);
});

test('legacy migrations(version) and project data are preserved', t => {
  const db = temporaryDatabase(t);
  db.exec(`CREATE TABLE migrations (version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES (1);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, aspect TEXT NOT NULL,
    budget REAL, status TEXT NOT NULL DEFAULT 'draft', directory TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.exec(insertProject);
  migrate(db);
  assert.equal(db.prepare('SELECT name FROM projects').get()!.name, 'Project');
  assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 1);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, latestVersion);
});
