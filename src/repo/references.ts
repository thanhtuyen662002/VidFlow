import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Reference } from '../types.ts';
import { referenceSchema } from '../migrations.ts';
import { referenceInput, referenceImages } from '../validate.ts';
import { resolveInside } from '../paths.ts';
import { normalizeRefName } from '../ref-name.ts';
import { upgradeReferenceRegistry } from '../reference-migration.ts';
import { BibleDuplicateError } from '../prompt/bible-errors.ts';
export { normalizeRefName } from '../ref-name.ts';
export type { Reference } from '../types.ts';

function initialize(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(referenceSchema);
  db.exec('SAVEPOINT reference_registry');
  try {
    upgradeReferenceRegistry(db);
    db.exec('RELEASE reference_registry');
  } catch (error) {
    db.exec('ROLLBACK TO reference_registry');
    db.exec('RELEASE reference_registry');
    throw error;
  }
}
function decode(db: DatabaseSync, row: Record<string, unknown>): Reference {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id as string);
  const images = JSON.parse(row.images as string) as string[];
  const { name_key, name_conflict, ...fields } = row;
  return { ...fields, images: project?.directory
    ? referenceImages(images, project.directory as string).map(image => resolveInside(project.directory as string, image))
    : images } as Reference;
}
function write(db: DatabaseSync, id: string, input: Omit<Reference, 'id'>, update: boolean): Reference {
  initialize(db);
  const checked = referenceInput({ ...input, priority: String(input.priority) });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.project_id);
  if (!project) throw new Error('Project not found');
  const images = referenceImages(input.images, project.directory as string | undefined);
  const key = normalizeRefName(checked.name);
  const duplicate = db.prepare('SELECT id FROM "references" WHERE project_id = ? AND name_key = ? AND id <> ?').get(input.project_id, key, id);
  if (duplicate) throw new BibleDuplicateError(checked.name, key);
  const args = [input.project_id, checked.name, checked.role, JSON.stringify(images), checked.description, checked.priority, key, id];
  try {
    if (update) db.prepare('UPDATE "references" SET project_id = ?, name = ?, role = ?, images = ?, description = ?, priority = ?, name_key = ?, name_conflict = 0 WHERE id = ?').run(...args);
    else db.prepare('INSERT INTO "references" (project_id, name, role, images, description, priority, name_key, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new BibleDuplicateError(checked.name, key);
    throw error;
  }
  return getReference(db, id)!;
}
export function findReferenceByName(db: DatabaseSync, projectId: string, name: string): boolean {
  initialize(db);
  return !!db.prepare('SELECT id FROM "references" WHERE project_id = ? AND name_key = ? AND name_conflict = 0').get(projectId, normalizeRefName(name));
}
export function createReference(db: DatabaseSync, input: Omit<Reference, 'id'>): Reference {
  return write(db, randomUUID(), input, false);
}
export function getReference(db: DatabaseSync, id: string): Reference | undefined {
  initialize(db);
  const row = db.prepare('SELECT * FROM "references" WHERE id = ?').get(id);
  return row ? decode(db, row) : undefined;
}
export function listReferences(db: DatabaseSync, projectId: string): Reference[] {
  initialize(db);
  return db.prepare('SELECT * FROM "references" WHERE project_id = ? ORDER BY priority ASC, name ASC').all(projectId).map(row => decode(db, row));
}
export function updateReference(db: DatabaseSync, id: string, patch: Partial<Omit<Reference, 'id' | 'project_id'>>): Reference | undefined {
  const current = getReference(db, id);
  return current ? write(db, id, { ...current, ...patch }, true) : undefined;
}
export function deleteReference(db: DatabaseSync, id: string): boolean {
  initialize(db);
  return db.prepare('DELETE FROM "references" WHERE id = ?').run(id).changes > 0;
}

export function listNameConflicts(db: DatabaseSync, projectId: string): Reference[] {
  initialize(db);
  return db.prepare('SELECT * FROM "references" WHERE project_id = ? AND name_conflict = 1 ORDER BY id')
    .all(projectId).map(row => decode(db, row));
}
