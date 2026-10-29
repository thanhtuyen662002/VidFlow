import type { DatabaseSync } from 'node:sqlite';
import type { Chain } from '../types.ts';
import { repository, transaction } from './records.ts';
const chainRepo = repository<Chain>('chains', {"projectId":"","scriptVariantId":null,"name":"","status":"pending","createdAt":""}, [], []);
export const getChain = chainRepo.get;
export const updateChain = chainRepo.update;
export const deleteChain = chainRepo.remove;
export const createChain = chainRepo.create;

export function listChains(db: DatabaseSync, projectId: string): Chain[] { return chainRepo.list(db,'project_id=?',[projectId],'created_at,id'); }
export function listChainScenes(db: DatabaseSync,chainId: string): import('../types.ts').ChainScene[] { return db.prepare('SELECT chain_id AS chainId, scene_id AS sceneId, position FROM chain_scenes WHERE chain_id=? ORDER BY position').all(chainId).map(r=>({...r})) as import('../types.ts').ChainScene[]; }
export function addScene(db: DatabaseSync,chainId: string,sceneId: string): void { transaction(db,()=>{
 const chain=getChain(db,chainId); const scene=db.prepare('SELECT project_id FROM scenes WHERE id=?').get(sceneId);
 if(!chain||!scene||chain.projectId!==scene.project_id) throw new Error('Scene and chain must belong to the same project');
 const rows=listChainScenes(db,chainId); db.prepare('INSERT INTO chain_scenes VALUES (?,?,?)').run(chainId,sceneId,rows.length?Math.max(...rows.map(r=>r.position))+1:0); }); }
export function removeScene(db: DatabaseSync,chainId: string,sceneId: string): boolean { return transaction(db,()=>{
 const removed=db.prepare('DELETE FROM chain_scenes WHERE chain_id=? AND scene_id=?').run(chainId,sceneId).changes>0;
 const rows=listChainScenes(db,chainId); const stmt=db.prepare('UPDATE chain_scenes SET position=? WHERE chain_id=? AND scene_id=?'); rows.forEach((r,i)=>stmt.run(i,chainId,r.sceneId)); return removed; }); }
