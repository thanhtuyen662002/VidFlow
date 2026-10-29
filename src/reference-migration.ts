import type { DatabaseSync } from 'node:sqlite';
import { normalizeRefName } from './ref-name.ts';

/** Caller supplies the transaction, including M1 raw-connection callers. */
export function upgradeReferenceRegistry(db: DatabaseSync): void {
  if (db.prepare('PRAGMA table_info("references")').all().some(row => row.name === 'name_key')) return;
  // Rebuild to remove raw-name uniqueness: identical legacy names must survive.
  db.exec(`ALTER TABLE "references" RENAME TO references_legacy;
    CREATE TABLE "references" (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
      name_key TEXT, name_conflict INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO "references" (id, project_id, name, role, images, description, priority)
      SELECT id, project_id, name, role, images, description, priority FROM references_legacy;
    DROP TABLE references_legacy;`);
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bible_entries'").get()) {
    for (const row of db.prepare('SELECT * FROM bible_entries ORDER BY id').all()) {
      let id = String(row.id);
      while (db.prepare('SELECT id FROM "references" WHERE id = ?').get(id)) id += '#legacy';
      db.prepare(`INSERT INTO "references" (id, project_id, name, role, images, description, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, String(row.project_id), String(row.name),
        String(row.kind ?? row.role), String(row.images), String(row.description), Number(row.priority));
    }
    db.exec('DROP TABLE bible_entries');
  }
  const rows = db.prepare('SELECT id, project_id, name FROM "references" ORDER BY id').all();
  const occupied = new Map<string, Set<string>>();
  for (const row of rows) {
    const project = String(row.project_id);
    if (!occupied.has(project)) occupied.set(project, new Set());
    occupied.get(project)!.add(normalizeRefName(String(row.name)));
  }
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const project = String(row.project_id);
    if (!seen.has(project)) seen.set(project, new Set());
    let key = normalizeRefName(String(row.name));
    const conflict = seen.get(project)!.has(key);
    seen.get(project)!.add(key);
    // Lowest id keeps the real key. Preserve and flag later collisions for the owner.
    if (conflict) {
      key += `#conflict-${row.id}`;
      while (occupied.get(project)!.has(key)) key += '#';
      occupied.get(project)!.add(key);
    }
    db.prepare('UPDATE "references" SET name_key = ?, name_conflict = ? WHERE id = ?')
      .run(key, conflict ? 1 : 0, String(row.id));
  }
  db.exec('CREATE UNIQUE INDEX reference_project_name_key ON "references" (project_id, name_key)');
}
