import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createProjectDirectories } from '../paths.ts';

export type Project = { id: string; name: string; aspect: string; budget: number | null; status: string; directory: string; created_at: string };

export function listProjects(db: DatabaseSync): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Project[];
}

export function findProject(db: DatabaseSync, query: string): Project | undefined {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(query)
    || db.prepare('SELECT * FROM projects WHERE name = ?').get(query)) as Project | undefined;
}

export function createProject(db: DatabaseSync, name: string, aspect: string, budget: number | null): Project {
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
