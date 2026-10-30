import type { DatabaseSync } from 'node:sqlite';
import type { ScriptVariant } from '../types.ts';
import { repository, transaction } from './records.ts';
const scriptVariantRepo = repository<ScriptVariant>('script_variants', {"versionNumber":1,"parentVariantId":null,"projectId":"","name":"","content":"","isActive":false,"logline":"","audience":"","value":"","beats":[],"scenes":[],"scores":{},"feedback":"","status":"draft","createdAt":"","updatedAt":""}, ["beats","scenes","scores"], ["isActive"]);
export const getScriptVariant = scriptVariantRepo.get;
export const updateScriptVariant = scriptVariantRepo.update;
export const deleteScriptVariant = scriptVariantRepo.remove;
export const createScriptVariant = scriptVariantRepo.create;

export function listScriptVariants(db: DatabaseSync, projectId: string): ScriptVariant[] { return scriptVariantRepo.list(db, 'project_id=?', [projectId], 'created_at, id'); }
export function setActive(db: DatabaseSync, id: string): ScriptVariant | undefined {
 return transaction(db, () => { const script = getScriptVariant(db,id); if(!script) return undefined;
 db.prepare('UPDATE script_variants SET is_active=0 WHERE project_id=?').run(script.projectId);
 return updateScriptVariant(db,id,{isActive:true}); });
}
export const listByProject = listScriptVariants;

export const setActiveScriptVariant = setActive;

