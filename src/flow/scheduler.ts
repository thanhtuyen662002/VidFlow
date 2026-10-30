import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { redactObject, redactString } from '../redact.ts';
import { claimNextJob, completeJob, rejectJob, failJob, releaseJob, listJobs, getJob } from './queue.ts';
import { selectUsableAccount, setAccountStatus } from './accounts.ts';
import type { FlowJobDriver, WorkerJob } from './jobDriver.ts';

export function createScheduler(options: {
  queue: DatabaseSync; accounts: DatabaseSync; driver: FlowJobDriver;
  logger?: (event: unknown) => void; clock?: () => Date; timeoutMs?: number; maxAttempts?: number;
}) {
  const { queue: db, accounts, driver } = options;
  const worker = randomUUID();
  const limit = options.maxAttempts ?? 3, timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid scheduler limits');
  let busy = false;
  async function runOnce(): Promise<'idle' | 'no_account' | 'processed' | 'busy'> {
    if (busy) return 'busy';
    busy = true;
    try {
      if (!listJobs(db, { status: 'queued' }).length) return 'idle';
      const account = selectUsableAccount(accounts);
      if (!account) return 'no_account';
      const row = claimNextJob(db, worker, { accountId: account.id });
      if (!row) return 'idle';
      const job = row as unknown as WorkerJob;
      let result;
      try { result = await driver.run(job, account, { timeoutMs }); }
      catch { result = { kind: 'transient_error' as const, message: 'Lỗi trình điều khiển Flow' }; }
      const current = getJob(db, job.id);
      if (current?.status !== 'running' || current.worker_id !== worker || current.account_id !== account.id) return 'processed';
      const emit = (event: string) => options.logger?.(redactObject({ event, accountId: account.id, at: (options.clock?.() ?? new Date()).toISOString() }));
      switch (result.kind) {
        case 'success':
          db.prepare('UPDATE render_jobs SET output_media=? WHERE id=? AND worker_id=? AND status=\'running\'').run(JSON.stringify(redactObject(result.media)), job.id, worker);
          completeJob(db, job.id, worker); break;
        case 'refused': rejectJob(db, job.id, worker, redactString(result.reason)); break;
        case 'out_of_credit':
          setAccountStatus(accounts, account.id, 'out_of_credit');
          if (releaseJob(db, job.id, worker)) db.prepare('UPDATE render_jobs SET attempts=MAX(0,attempts-1) WHERE id=?').run(job.id);
          break;
        case 'verification_required':
          setAccountStatus(accounts, account.id, 'needs_owner');
          db.prepare(`UPDATE render_jobs SET status='queued',account_id=NULL,worker_id=NULL,claimed_at=NULL,finished_at=NULL,error=NULL,
            attempts=MAX(0,attempts-CASE WHEN status='running' THEN 1 ELSE 0 END),updated_at=?
            WHERE payload IS NOT NULL AND account_id=? AND status IN ('queued','running')`).run(new Date().toISOString(), account.id);
          emit('owner_action_required'); break;
        case 'transient_error':
          if (job.attempts < limit) releaseJob(db, job.id, worker);
          else failJob(db, job.id, worker, redactString(result.message));
          break;
      }
      emit('flow_job_processed');
      return 'processed';
    } finally { busy = false; }
  }
  async function runUntilIdle() { let status; do { status = await runOnce(); } while (status === 'processed'); return status; }
  return { runOnce, runUntilIdle };
}
