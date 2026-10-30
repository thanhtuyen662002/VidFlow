import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase } from '../src/db.ts';
import type { TestContext } from 'node:test';

export function temporaryDatabase(t: TestContext): DatabaseSync {
  // Stay inside the workspace so sandboxed test runs can also create the home.
  const home = mkdtempSync(join(process.cwd(), '.migration-test-'));
  const original = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = home;
  const db = new DatabaseSync(join(home, 'vidflow.db'), { timeout: 5000 });
  t.after(() => {
    if (db.isOpen) db.close();
    if (original === undefined) delete process.env.VIDFLOW_HOME;
    else process.env.VIDFLOW_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });
  try { configureDatabase(db); }
  catch (error) { db.close(); throw error; }
  return db;
}
