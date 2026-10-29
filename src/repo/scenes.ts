import type { DatabaseSync } from 'node:sqlite';
import type { Scene } from '../types.ts';
import { repository, transaction } from './records.ts';
const sceneRepo = repository<Scene>('scenes', {"projectId":"","scriptVariantId":null,"chainId":null,"index":0,"title":"","prompt":"","status":"draft","beat":"","durationUsed":0,"moment":"","camera":"","action":"","dialogue":"","sfx":"","charactersPresent":[],"location":"","transition":"cut","groupId":null,"mode":"text","createdAt":"","updatedAt":""}, ["charactersPresent"], []);
export const getScene = sceneRepo.get;




export function listScenes(db: DatabaseSync, projectId: string, scriptVariantId: string | null = null): Scene[] { return sceneRepo.list(db,'project_id=? AND script_variant_id IS ?', [projectId,scriptVariantId], '"index", id'); }
function order(db: DatabaseSync, rows: Scene[], ids: string[]): void {
 if(ids.length!==rows.length || new Set(ids).size!==ids.length || ids.some(id=>!rows.some(row=>row.id===id))) throw new Error('Reorder must contain every scene exactly once');
 const statement=db.prepare('UPDATE scenes SET "index"=?, updated_at=? WHERE id=?'); const now=new Date().toISOString();
 const base=Math.min(0,...rows.map(r=>r.index))-rows.length-1;
 ids.forEach((id,i)=>statement.run(base-i,now,id)); ids.forEach((id,i)=>statement.run(i,now,id));
}
export function reorderScenes(db: DatabaseSync, projectId: string, ids: string[], scriptVariantId: string | null = null): void { transaction(db,()=>order(db,listScenes(db,projectId,scriptVariantId),ids)); }
export function createScene(db: DatabaseSync, input: Partial<Omit<Scene,'id'>> & Pick<Scene,'projectId'>): Scene {
 return transaction(db,()=>{ const rows=listScenes(db,input.projectId,input.scriptVariantId??null); const index=input.index??rows.length;
 if(!Number.isSafeInteger(index)||index<0||index>rows.length) throw new Error('Invalid scene index');
 const scene=sceneRepo.create(db,{...input,index:rows.length}); const ids=rows.map(r=>r.id); ids.splice(index,0,scene.id); order(db,[...rows,scene],ids); return getScene(db,scene.id)!; });
}
export function updateScene(db: DatabaseSync,id: string,patch: Partial<Omit<Scene,'id'|'projectId'|'scriptVariantId'>>): Scene | undefined {
 return transaction(db,()=>{ const scene=getScene(db,id); if(!scene) return undefined; const rows=listScenes(db,scene.projectId,scene.scriptVariantId);
 const index=patch.index??scene.index; if(!Number.isSafeInteger(index)||index<0||index>=rows.length) throw new Error('Invalid scene index');
 const ids=rows.map(r=>r.id).filter(x=>x!==id); ids.splice(index,0,id); order(db,rows,ids); return sceneRepo.update(db,id,{...patch,index}); });
}
export function deleteScene(db: DatabaseSync,id: string): boolean { return transaction(db,()=>{ const scene=getScene(db,id); if(!scene) return false; sceneRepo.remove(db,id); const rows=listScenes(db,scene.projectId,scene.scriptVariantId); order(db,rows,rows.map(r=>r.id)); return true; }); }
export const reorder = reorderScenes;
