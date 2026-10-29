import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createProjectDirectories } from '../paths.ts';
import { projectName, projectAspect, projectBudget } from '../validate.ts';
import { DuplicateError } from '../types.ts';
import type { Project } from '../types.ts';

export type { Project } from '../types.ts';

export function listProjects(db: DatabaseSync): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Project[];
}

export function findProject(db: DatabaseSync, query: string): Project | undefined {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(query)
    || db.prepare('SELECT * FROM projects WHERE name = ?').get(query)) as Project | undefined;
}

export function createProject(db: DatabaseSync, name: string, aspect: string, budget: number | null): Project {
  name = projectName(name);
  aspect = projectAspect(aspect);
  budget = projectBudget(budget == null ? undefined : String(budget));
  // Serialize duplicate checks and insertion, including between CLI processes.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT id FROM projects WHERE name = ?').get(name)) throw new Error('Tên dự án đã tồn tại');
    const id = randomUUID();
    const directory = createProjectDirectories(id);
    const created_at = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, name, aspect, budget, directory, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, aspect, budget, directory, created_at);
    db.exec('COMMIT');
    return { id, name, aspect, budget, status: 'draft', directory, created_at };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getProject(db: DatabaseSync, id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}
export function updateProject(db: DatabaseSync, id: string, patch: Partial<Pick<Project, 'name' | 'aspect' | 'budget' | 'status'>>): Project | undefined {
  const current = getProject(db, id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  next.name = projectName(next.name);
  next.aspect = projectAspect(next.aspect);
  next.budget = projectBudget(next.budget === null ? undefined : String(next.budget));
  if (typeof next.status !== 'string' || !next.status.trim()) throw new Error('Invalid project status');
  try {
    db.prepare('UPDATE projects SET name = ?, aspect = ?, budget = ?, status = ? WHERE id = ?').run(next.name, next.aspect, next.budget, next.status, id);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new DuplicateError('Project name already exists');
    throw error;
  }
  return getProject(db, id);
}
export function deleteProject(db: DatabaseSync, id: string): boolean {
  db.exec('PRAGMA foreign_keys = ON');
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}
