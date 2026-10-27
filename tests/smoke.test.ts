import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { VIDFLOW_VERSION } from '../src/version.ts';

// The baseline every milestone builds on: TypeScript runs directly on Node 24
// and the built-in SQLite module is available (AGENTS.md).
test('runs TypeScript directly and has node:sqlite', () => {
  assert.match(VIDFLOW_VERSION, /^\d+\.\d+\.\d+$/);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
  // node:sqlite rows have a null prototype, so compare the value itself.
  assert.equal((db.prepare('SELECT v FROM t').get() as { v: string }).v, 'ok');
  db.close();
});
