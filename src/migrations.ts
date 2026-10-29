import type { DatabaseSync } from 'node:sqlite';

export interface Migration { version: number; name: string; sql: string }

// Also supports callers supplying a raw SQLite connection with a projects table.
export const referenceSchema = `CREATE TABLE IF NOT EXISTS "references" (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, name)
)`;

export const migrations: readonly Migration[] = [{
  version: 1, name: 'Initial schema', sql: `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, aspect TEXT NOT NULL,
  budget REAL, status TEXT NOT NULL DEFAULT 'draft', directory TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE bibles (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  style TEXT NOT NULL DEFAULT '', lighting TEXT NOT NULL DEFAULT '', palette TEXT NOT NULL DEFAULT '',
  lens TEXT NOT NULL DEFAULT '', avoid TEXT NOT NULL DEFAULT '', safe_area TEXT NOT NULL DEFAULT ''
);
${referenceSchema};
CREATE TABLE script_variants (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  logline TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', value TEXT NOT NULL DEFAULT '',
  beats TEXT NOT NULL DEFAULT '[]', scenes TEXT NOT NULL DEFAULT '[]', scores TEXT NOT NULL DEFAULT '{}',
  feedback TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE chains (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_variant_id TEXT REFERENCES script_variants(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE scenes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_variant_id TEXT REFERENCES script_variants(id) ON DELETE CASCADE,
  chain_id TEXT REFERENCES chains(id) ON DELETE SET NULL, "index" INTEGER NOT NULL,
  beat TEXT NOT NULL DEFAULT '', duration_used REAL NOT NULL DEFAULT 0, moment TEXT NOT NULL DEFAULT '',
  camera TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '', dialogue TEXT NOT NULL DEFAULT '',
  sfx TEXT NOT NULL DEFAULT '', characters_present TEXT NOT NULL DEFAULT '[]', location TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT 'cut', group_id TEXT, mode TEXT NOT NULL DEFAULT 'text'
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT, label TEXT, type TEXT NOT NULL, profile TEXT NOT NULL,
  credits REAL NOT NULL DEFAULT 0, credit_refresh_at TEXT, status TEXT NOT NULL DEFAULT 'ready',
  concurrency_limit INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  type TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, input_images TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', credits REAL NOT NULL DEFAULT 0, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE takes (
  id TEXT PRIMARY KEY, render_job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, file TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', quality_score REAL, selected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE selections (
  id TEXT PRIMARY KEY, scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id) ON DELETE CASCADE,
  take_id TEXT NOT NULL REFERENCES takes(id) ON DELETE CASCADE, "in" REAL NOT NULL DEFAULT 0,
  "out" REAL NOT NULL, crop TEXT NOT NULL DEFAULT '{}', exit_frame TEXT
);
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  render_job_id TEXT REFERENCES render_jobs(id) ON DELETE SET NULL, credits REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, file TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
);
` }, { version: 2, name: 'Script and render repositories', sql: `

ALTER TABLE script_variants ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE script_variants ADD COLUMN content TEXT NOT NULL DEFAULT '';
ALTER TABLE script_variants ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE script_variants ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE script_variants ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX script_active ON script_variants(project_id) WHERE is_active = 1;
ALTER TABLE scenes ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE scenes ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE scenes ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE scenes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE scenes ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
-- Normalize legacy order before enforcing a unique slot, including unassigned scenes.
WITH ranked AS MATERIALIZED (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id, script_variant_id ORDER BY "index", id)-1 AS position FROM scenes) UPDATE scenes SET "index" = (SELECT position FROM ranked WHERE ranked.id = scenes.id);
CREATE UNIQUE INDEX scene_order ON scenes(project_id, IFNULL(script_variant_id, ''), "index");
ALTER TABLE chains ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE chains ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
CREATE TABLE chain_scenes(chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(chain_id, scene_id), UNIQUE(chain_id, position));
INSERT INTO chain_scenes SELECT chain_id, id, ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY "index", id)-1 FROM scenes WHERE chain_id IS NOT NULL;
ALTER TABLE render_jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'flow';
ALTER TABLE render_jobs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE render_jobs ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE render_jobs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE render_jobs SET status = 'queued' WHERE status = 'pending';
ALTER TABLE render_jobs ADD COLUMN status_valid INTEGER CHECK(status IN ('queued','running','succeeded','failed','cancelled'));
ALTER TABLE takes ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
ALTER TABLE takes ADD COLUMN duration_sec REAL NOT NULL DEFAULT 0;
ALTER TABLE takes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE selections RENAME TO selections_legacy;
CREATE TABLE selections(id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, take_id TEXT NOT NULL REFERENCES takes(id) ON DELETE CASCADE, "in" REAL NOT NULL DEFAULT 0, "out" REAL NOT NULL, crop TEXT NOT NULL DEFAULT '{}', exit_frame TEXT, is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)), created_at TEXT NOT NULL DEFAULT '');
INSERT INTO selections(id,scene_id,take_id,"in","out",crop,exit_frame) SELECT id,scene_id,take_id,"in","out",crop,exit_frame FROM selections_legacy;
DROP TABLE selections_legacy;
CREATE UNIQUE INDEX selection_current ON selections(scene_id) WHERE is_current = 1;
` }];

export const latestVersion = migrations.at(-1)!.version;

export function migrate(db: DatabaseSync, list: readonly Migration[] = migrations): void {
  let latest = 0;
  for (const migration of list) {
    if (!Number.isSafeInteger(migration.version) || migration.version !== latest + 1) {
      throw new Error('Migration versions must be consecutive integers starting at 1');
    }
    latest = migration.version;
  }
  const current = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (current > latest) throw new Error(`Database version ${current} is newer than code migration version ${latest}`);
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const columns = db.prepare('PRAGMA table_info(migrations)').all();
  if (!columns.some(column => column.name === 'name')) db.exec('ALTER TABLE migrations ADD COLUMN name TEXT');
  if (!columns.some(column => column.name === 'applied_at')) db.exec('ALTER TABLE migrations ADD COLUMN applied_at TEXT');
  for (const migration of list) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (migration.version > version) {
        // Version 1 also completes the legacy projects-only schema without losing its rows.
        db.exec(migration.sql);
        db.prepare('INSERT OR REPLACE INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
