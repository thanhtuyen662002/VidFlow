import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.ts';
import { redactObject, redactString } from '../redact.ts';
import { listAccounts, getAccount, setAccountStatus, accountStatusLabels } from './accounts.ts';
import type { AccountStatus } from './accounts.ts';
import { getJob, listJobs, jobStatusLabels } from './queue.ts';
import type { JobStatus } from './queue.ts';
import type { FlowJobDriver } from './jobDriver.ts';
import { createScheduler } from './scheduler.ts';
import { createPageDriver } from './pageDriver.ts';
import { launchFlowContext } from './driver.ts';
import { recoverInterruptedJobs } from '../render/recovery.ts';

type IO = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
export async function runFlowWorkerCommand(args: string[], io: IO = process, dependencies: { db?: DatabaseSync; driver?: FlowJobDriver } = {}): Promise<number> {
  let db: DatabaseSync | undefined;
  const output = (value: unknown) => io.stdout.write(JSON.stringify(redactObject(value)) + '\n');
  try {
    const group = args[0], action = args[1];
    const { positionals: p, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      ...(group === 'run' ? { once: { type: 'boolean' as const } } : {}),
      ...(group === 'queue' && action === 'list' ? { state: { type: 'string' as const } } : {}),
      ...(group === 'queue' && action === 'retry' ? { force: { type: 'boolean' as const } } : {}),
    } });
    if (group === 'account' && ['add', 'import'].includes(action)) throw new Error('Lệnh này cần mô-đun phiên đăng nhập M5.x');
    const lengths: Record<string, number> = { list: 2, show: 3, mark: 4, reset: 3, retry: 3, cancel: 3 };
    if (group === 'run' ? p.length !== 1 : !['account', 'queue'].includes(group) || p.length !== lengths[action] ||
      !(group === 'account' ? ['list', 'show', 'mark', 'reset'] : ['list', 'show', 'retry', 'cancel']).includes(action)) throw new Error('Đối số lệnh Flow không hợp lệ');
    db = dependencies.db ?? openDatabase();
    if (group === 'account') {
      const display = (row: NonNullable<ReturnType<typeof getAccount>>) => ({ id: row.id, label: row.label, state: row.status, status: accountStatusLabels[row.status as AccountStatus] });
      if (action === 'list') output(listAccounts(db).map(display));
      else {
        if (!getAccount(db, p[2])) throw new Error('Không tìm thấy tài khoản');
        if (action === 'mark' || action === 'reset') setAccountStatus(db, p[2], action === 'reset' ? 'ready' : p[3] as AccountStatus);
        output(display(getAccount(db, p[2])!));
      }
    } else if (group === 'queue') {
      const display = (row: NonNullable<ReturnType<typeof getJob>>) => ({ id: row.id, state: row.status, status: jobStatusLabels[row.status as JobStatus], accountId: row.account_id, attempts: row.attempts, reason: row.error, media: row.output_media });
      if (action === 'list') output(listJobs(db, { status: values.state as JobStatus | undefined }).map(display));
      else {
        const job = getJob(db, p[2]); if (!job) throw new Error('Không tìm thấy việc');
        if (action === 'retry') {
          if (job.status === 'rejected' && !values.force) throw new Error('Việc bị từ chối cần --force để thử lại');
          if (!['rejected', 'failed'].includes(String(job.status))) throw new Error('Chỉ thử lại việc đã thất bại');
          db.prepare("UPDATE render_jobs SET status='queued',account_id=NULL,worker_id=NULL,attempts=0,error=NULL,claimed_at=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), p[2]);
        } else if (action === 'cancel') {
          if (!['queued', 'running'].includes(String(job.status))) throw new Error('Việc đã kết thúc');
          db.prepare("UPDATE render_jobs SET status='failed',error='Đã hủy',worker_id=NULL,account_id=NULL,finished_at=?,updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), p[2]);
        }
        output(display(getJob(db, p[2])!));
      }
    } else {
      const store = db;
      await recoverInterruptedJobs(db);
      const driver = dependencies.driver ?? createPageDriver(async accountId => ({ db: store, browser: await launchFlowContext(accountId), url: 'https://labs.google/fx/tools/flow', timeoutMs: 30000 }));
      const scheduler = createScheduler({ queue: db, accounts: db, driver, logger: output });
      output({ state: await (values.once ? scheduler.runOnce() : scheduler.runUntilIdle()) });
    }
    return 0;
  } catch (error) { io.stderr.write(redactString('vidflow: ' + (error instanceof Error ? error.message : 'Lỗi Flow')) + '\n'); return 1; }
  finally { if (db && !dependencies.db) db.close(); }
}
