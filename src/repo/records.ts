import { isAbsolute, relative } from 'node:path';
import { resolveInside } from '../paths.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function repository<T extends { id: string }>(table: string, defaults: Record<string, unknown>, json: string[] = [], booleans: string[] = []) {
 const column = (key: string) => '"' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()) + '"';
 const keys = ['id', ...Object.keys(defaults)];
 function decode(row: Record<string, unknown>): T {
  return Object.fromEntries(keys.map(key => { let value = row[key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())]; if(json.includes(key)) value = JSON.parse(value as string); if(booleans.includes(key)) value = Boolean(value); return [key, value]; })) as T;
 }
 function validate(db: DatabaseSync, value: Record<string, unknown>): void {
  if(table==='scenes'||table==='chains') {
   if(value.scriptVariantId) { const row=db.prepare('SELECT project_id FROM script_variants WHERE id=?').get(value.scriptVariantId as string); if(!row||row.project_id!==value.projectId) throw new Error('Script must belong to project'); }
  }
  if(table==='scenes' && value.chainId) { const chain=db.prepare('SELECT project_id FROM chains WHERE id=?').get(value.chainId as string); if(!chain || chain.project_id!==value.projectId) throw new Error('Chain must belong to project'); }
  if(table==='render_jobs') { const row=db.prepare('SELECT project_id FROM scenes WHERE id=?').get(value.sceneId as string); if(!row||row.project_id!==value.projectId) throw new Error('Scene must belong to project'); }
  if(table==='takes') {
   const row=db.prepare('SELECT scene_id, project_id FROM render_jobs WHERE id=?').get(value.renderJobId as string);
   if(!row||row.scene_id!==value.sceneId) throw new Error('Job must belong to scene');
   const project=db.prepare('SELECT directory FROM projects WHERE id=?').get(row.project_id as string)!;
   const filename=value.file as string; resolveInside(project.directory as string,isAbsolute(filename)?relative(project.directory as string,filename):filename);
   if(value.assetId) { const asset=db.prepare('SELECT project_id FROM assets WHERE id=?').get(value.assetId as string); if(!asset||asset.project_id!==row.project_id) throw new Error('Asset must belong to project'); }
  }
  if(table==='selections') { const row=db.prepare('SELECT scene_id FROM takes WHERE id=?').get(value.takeId as string); if(!row||row.scene_id!==value.sceneId) throw new Error('Take must belong to scene'); }
 }
 const encode = (key: string, value: unknown): SQLInputValue => (json.includes(key) ? JSON.stringify(value) : booleans.includes(key) ? Number(value) : value) as SQLInputValue;
 function get(db: DatabaseSync, id: string): T | undefined { const row = db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id); return row ? decode(row) : undefined; }
 function list(db: DatabaseSync, where: string, args: SQLInputValue[], order = 'id'): T[] { return db.prepare('SELECT * FROM '+table+' WHERE '+where+' ORDER BY '+order).all(...args).map(decode); }
 function create(db: DatabaseSync, input: Partial<Omit<T, 'id'>>): T {
  const now = new Date().toISOString(); const value = { ...defaults, createdAt: now, updatedAt: now, ...input, id: randomUUID() } as Record<string, unknown>;
  validate(db,value);
  db.prepare('INSERT INTO '+table+' ('+keys.map(column).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>encode(k,value[k]))); return get(db,value.id as string)!;
 }
 function update(db: DatabaseSync, id: string, patch: Partial<Omit<T, 'id'>>): T | undefined {
  const current = get(db,id); if(!current) return undefined;
  const value = { ...current, ...patch, updatedAt: new Date().toISOString() } as Record<string, unknown>;
  validate(db,value);
  const fields = keys.filter(k=>k!=='id'); db.prepare('UPDATE '+table+' SET '+fields.map(k=>column(k)+'=?').join(',')+' WHERE id=?').run(...fields.map(k=>encode(k,value[k])),id); return get(db,id);
 }
 function remove(db: DatabaseSync,id: string): boolean { return db.prepare('DELETE FROM '+table+' WHERE id=?').run(id).changes>0; }
 return { get,list,create,update,remove };
}
