import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { initializeDirectories } from './paths.ts';
import { migrate } from './migrations.ts';

/** Shared connection settings, also used by raw migration test connections. */
export function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(join(initializeDirectories(), 'vidflow.db'), { timeout: 5000 });
  try {
    configureDatabase(db);
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
