import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Reference = { id: string; project_id: string; name: string; role: string; images: string[]; description: string; priority: number };

function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "references" (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL, role TEXT NOT NULL, images TEXT NOT NULL,
    description TEXT NOT NULL, priority INTEGER NOT NULL,
    UNIQUE(project_id, name)
  )`);
}

export function findReferenceByName(db: DatabaseSync, projectId: string, name: string): boolean {
  initialize(db);
  return !!db.prepare('SELECT id FROM "references" WHERE project_id = ? AND name = ?').get(projectId, name);
}

export function createReference(db: DatabaseSync, input: Omit<Reference, 'id'>): Reference {
  initialize(db);
  const reference = { ...input, id: randomUUID() };
  db.prepare('INSERT INTO "references" (id, project_id, name, role, images, description, priority) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(reference.id, input.project_id, input.name, input.role, JSON.stringify(input.images), input.description, input.priority);
  return reference;
}

export function listReferences(db: DatabaseSync, projectId: string): Reference[] {
  initialize(db);
  // PLAN does not specify direction: smaller priority first, then name (SQLite BINARY).
  const rows = db.prepare('SELECT * FROM "references" WHERE project_id = ? ORDER BY priority ASC, name ASC').all(projectId);
  return rows.map(row => ({ ...row, images: JSON.parse(row.images as string) })) as Reference[];
}
