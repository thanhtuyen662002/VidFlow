import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { initializeDirectories } from './paths.ts';
import { migrate } from './migrations.ts';

export function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(join(initializeDirectories(), 'vidflow.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
