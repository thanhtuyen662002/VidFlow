import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
    if (!db.prepare('SELECT version FROM migrations WHERE version = 1').get()) {
      db.exec(`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, aspect TEXT NOT NULL,
        budget REAL, status TEXT NOT NULL DEFAULT 'draft', directory TEXT NOT NULL,
        created_at TEXT NOT NULL
      ); INSERT INTO migrations (version) VALUES (1);`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
