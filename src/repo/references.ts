import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Reference } from '../types.ts';
import { DuplicateError } from '../types.ts';
import { referenceSchema } from '../migrations.ts';
import { referenceInput, referenceImages } from '../validate.ts';
import { resolveInside } from '../paths.ts';
export type { Reference } from '../types.ts';

function initialize(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(referenceSchema);
}
function decode(db: DatabaseSync, row: Record<string, unknown>): Reference {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id as string);
  const images = JSON.parse(row.images as string) as string[];
  return { ...row, images: project?.directory
    ? referenceImages(images, project.directory as string).map(image => resolveInside(project.directory as string, image))
    : images } as Reference;
}
function write(db: DatabaseSync, id: string, input: Omit<Reference, 'id'>, update: boolean): Reference {
  initialize(db);
  const checked = referenceInput({ ...input, priority: String(input.priority) });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.project_id);
  if (!project) throw new Error('Project not found');
  const images = referenceImages(input.images, project.directory as string | undefined);
  const duplicate = db.prepare('SELECT id FROM "references" WHERE project_id = ? AND name = ? AND id <> ?').get(input.project_id, checked.name, id);
  if (duplicate) throw new DuplicateError('Reference name already exists in this project');
  const args = [input.project_id, checked.name, checked.role, JSON.stringify(images), checked.description, checked.priority, id];
  try {
    if (update) db.prepare('UPDATE "references" SET project_id = ?, name = ?, role = ?, images = ?, description = ?, priority = ? WHERE id = ?').run(...args);
    else db.prepare('INSERT INTO "references" (project_id, name, role, images, description, priority, id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...args);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new DuplicateError('Reference name already exists in this project');
    throw error;
  }
  return getReference(db, id)!;
}
export function findReferenceByName(db: DatabaseSync, projectId: string, name: string): boolean {
  initialize(db);
  return !!db.prepare('SELECT id FROM "references" WHERE project_id = ? AND name = ?').get(projectId, name);
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
