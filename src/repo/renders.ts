import type { DatabaseSync } from 'node:sqlite';
import type { RenderJob, Take, Selection } from '../types.ts';
import { repository, transaction } from './records.ts';
const renderJobRepo = repository<RenderJob>('render_jobs', {"projectId":"","sceneId":"","accountId":null,"provider":"flow","type":"video","model":"fast","prompt":"","inputImages":[],"status":"queued","credits":0,"error":null,"attempts":0,"paramsJson":{},"createdAt":"","updatedAt":""}, ["inputImages","paramsJson"], []);
export const getRenderJob = renderJobRepo.get;
export const updateRenderJob = renderJobRepo.update;
export const deleteRenderJob = renderJobRepo.remove;
export const createRenderJob = renderJobRepo.create;
const takeRepo = repository<Take>('takes', {"renderJobId":"","sceneId":"","assetId":null,"file":"","metadata":{},"qualityScore":null,"selected":false,"durationSec":0,"createdAt":""}, ["metadata"], ["selected"]);
export const getTake = takeRepo.get;

export const deleteTake = takeRepo.remove;

const selectionRepo = repository<Selection>('selections', {"sceneId":"","takeId":"","in":0,"out":0,"crop":{},"exitFrame":null,"isCurrent":true,"createdAt":""}, ["crop"], ["isCurrent"]);
export const getSelection = selectionRepo.get;
export const updateSelection = selectionRepo.update;
export const deleteSelection = selectionRepo.remove;
export const createSelection = selectionRepo.create;

export function listRenderJobs(db: DatabaseSync,projectId: string): RenderJob[] { return renderJobRepo.list(db,'project_id=?',[projectId],'created_at,id'); }
export function updateStatus(db: DatabaseSync,id: string,status: import('../types.ts').RenderJobStatus,error: string | null = null): RenderJob | undefined {
 if(!['queued','running','succeeded','failed','cancelled'].includes(status)) throw new Error('Invalid render status'); return updateRenderJob(db,id,{status,error});
}
export function listByScene(db: DatabaseSync,id: string): Take[] { return takeRepo.list(db,'scene_id=?',[id],'created_at,id'); }
export function listByJob(db: DatabaseSync,id: string): Take[] { return takeRepo.list(db,'render_job_id=?',[id],'created_at,id'); }
export function createTake(db: DatabaseSync,input: Partial<Omit<Take,'id'>> & Pick<Take,'sceneId'|'renderJobId'|'file'>): Take { return takeRepo.create(db,input); }
export function updateTake(db: DatabaseSync,id: string,patch: Partial<Omit<Take,'id'|'sceneId'|'renderJobId'>>): Take | undefined { return takeRepo.update(db,id,patch); }
export function selectTake(db: DatabaseSync,sceneId: string,takeId: string): Selection {
 return transaction(db,()=>{ const take=getTake(db,takeId); if(!take||take.sceneId!==sceneId) throw new Error('Take must belong to the scene');
 db.prepare('UPDATE selections SET is_current=0 WHERE scene_id=? AND is_current=1').run(sceneId);
 return createSelection(db,{sceneId,takeId,out:take.durationSec}); });
}
export function getCurrentSelection(db: DatabaseSync,sceneId: string): Selection | undefined { return selectionRepo.list(db,'scene_id=? AND is_current=1',[sceneId])[0]; }
export function clearSelection(db: DatabaseSync,sceneId: string): void { db.prepare('UPDATE selections SET is_current=0 WHERE scene_id=? AND is_current=1').run(sceneId); }
