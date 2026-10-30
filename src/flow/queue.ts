import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type JobStatus = 'queued' | 'running' | 'done' | 'rejected' | 'failed';
export const jobStatusLabels: Record<JobStatus, string> = { queued: 'đang chờ', running: 'đang chạy', done: 'hoàn tất', rejected: 'bị từ chối', failed: 'thất bại' };
export function getJob(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM render_jobs WHERE id=? AND payload IS NOT NULL').get(id) ?? null;
}
export function enqueueJob(db: DatabaseSync, payload: unknown, options: { projectId?: string; priority?: number } = {}) {
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error('Payload must be JSON');
  if (!Number.isSafeInteger(options.priority ?? 0)) throw new Error('Priority must be an integer');
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO render_jobs(id,project_id,payload,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, options.projectId ?? null, json, options.priority ?? 0, 'queued', now, now);
  return getJob(db, id)!;
}
export function claimNextJob(db: DatabaseSync, workerId: string, options: { accountId?: string } = {}) {
  if (!workerId.trim()) throw new Error('Worker is required');
  if (options.accountId !== undefined && !db.prepare('SELECT id FROM flow_accounts WHERE id=?').get(options.accountId)) throw new Error('Account not found');
  const now = new Date().toISOString();
  return db.prepare(`UPDATE render_jobs SET status='running',worker_id=?,account_id=?,claimed_at=?,attempts=attempts+1,updated_at=?
    WHERE id=(SELECT id FROM render_jobs WHERE status='queued' AND payload IS NOT NULL ORDER BY priority DESC,created_at,id LIMIT 1)
    AND status='queued' RETURNING *`).get(workerId, options.accountId ?? null, now, now) ?? null;
}
function finish(db: DatabaseSync, id: string, workerId: string, status: JobStatus, error: string | null) {
  const now = new Date().toISOString();
  return db.prepare(`UPDATE render_jobs SET status=?,error=?,finished_at=?,updated_at=?
    WHERE id=? AND status='running' AND worker_id=? AND payload IS NOT NULL`).run(status, error, now, now, id, workerId).changes === 1;
}
export function completeJob(db: DatabaseSync, id: string, workerId: string) { return finish(db, id, workerId, 'done', null); }
export function rejectJob(db: DatabaseSync, id: string, workerId: string, reason: string) { return finish(db, id, workerId, 'rejected', reason); }
export function failJob(db: DatabaseSync, id: string, workerId: string, error: string) { return finish(db, id, workerId, 'failed', error); }
export function releaseJob(db: DatabaseSync, id: string, workerId: string) {
  return db.prepare(`UPDATE render_jobs SET status='queued',worker_id=NULL,account_id=NULL,claimed_at=NULL,finished_at=NULL,error=NULL,updated_at=?
    WHERE id=? AND status='running' AND worker_id=? AND payload IS NOT NULL`).run(new Date().toISOString(), id, workerId).changes === 1;
}
export function listJobs(db: DatabaseSync, options: { status?: JobStatus } = {}) {
  if (options.status !== undefined && !['queued','running','done','rejected','failed'].includes(options.status)) throw new Error('Invalid job status');
  return db.prepare('SELECT * FROM render_jobs WHERE payload IS NOT NULL AND (? IS NULL OR status=?) ORDER BY priority DESC,created_at,id')
    .all(options.status ?? null, options.status ?? null);
}
