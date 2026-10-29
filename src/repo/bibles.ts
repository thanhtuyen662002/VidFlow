import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Bible } from '../types.ts';
import { DuplicateError } from '../types.ts';
import { bibleText } from '../validate.ts';
export type { Bible } from '../types.ts';

type Fields = Omit<Bible, 'id' | 'project_id'>;
const defaults: Fields = { style: '', lighting: '', palette: '', lens: '', avoid: '', safe_area: '' };
function fields(input: Partial<Fields>): Fields {
  const value = { ...defaults, ...input };
  for (const key of Object.keys(defaults) as (keyof Fields)[]) value[key] = bibleText(value[key]);
  return value;
}
export function getBible(db: DatabaseSync, projectId: string): Bible | undefined {
  return db.prepare('SELECT * FROM bibles WHERE project_id = ?').get(projectId) as Bible | undefined;
}
export function listBibles(db: DatabaseSync): Bible[] {
  return db.prepare('SELECT * FROM bibles ORDER BY project_id').all() as Bible[];
}
export function createBible(db: DatabaseSync, projectId: string, input: Partial<Fields> = {}): Bible {
  const value = fields(input);
  try {
    db.prepare('INSERT INTO bibles (id, project_id, style, lighting, palette, lens, avoid, safe_area) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), projectId, value.style, value.lighting, value.palette, value.lens, value.avoid, value.safe_area);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new DuplicateError('Bible already exists for this project');
    throw error;
  }
  return getBible(db, projectId)!;
}
export function updateBible(db: DatabaseSync, projectId: string, input: Partial<Fields>): Bible | undefined {
  const current = getBible(db, projectId);
  if (!current) return undefined;
  const value = fields({ ...current, ...input });
  db.prepare('UPDATE bibles SET style = ?, lighting = ?, palette = ?, lens = ?, avoid = ?, safe_area = ? WHERE project_id = ?').run(value.style, value.lighting, value.palette, value.lens, value.avoid, value.safe_area, projectId);
  return getBible(db, projectId);
}
export function setBible(db: DatabaseSync, projectId: string, input: Partial<Fields>): Bible {
  return getBible(db, projectId) ? updateBible(db, projectId, input)! : createBible(db, projectId, input);
}
export function deleteBible(db: DatabaseSync, projectId: string): boolean {
  return db.prepare('DELETE FROM bibles WHERE project_id = ?').run(projectId).changes > 0;
}
