import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export function addEntry(db: DatabaseSync, input: { accountId: string; amount: number; reason: string; jobId?: string | null }) {
  if (!Number.isSafeInteger(input.amount)) throw new Error('Amount must be a safe integer');
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Reason is required');
  const id = randomUUID();
  db.prepare('INSERT INTO credit_ledger(id,account_id,amount,delta,credits,reason,job_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, input.accountId, input.amount, input.amount, -input.amount, input.reason, input.jobId ?? null, new Date().toISOString());
  return db.prepare('SELECT * FROM credit_ledger WHERE id=?').get(id)!;
}
export function getBalance(db: DatabaseSync, accountId: string): number {
  return db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM credit_ledger WHERE account_id=?').get(accountId)!.balance as number;
}
export function listEntries(db: DatabaseSync, accountId: string) {
  return db.prepare('SELECT * FROM credit_ledger WHERE account_id=? AND amount IS NOT NULL ORDER BY created_at,id').all(accountId);
}

/** The queue job ID is the idempotency key; serialize the check and append. */
export function chargeJob(db: DatabaseSync, accountId: string, jobId: string, credits: number, outputFiles?: string[]) {
  if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('Invalid charge');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM credit_ledger WHERE job_id=? AND amount IS NOT NULL').get(jobId);
    if (previous && previous.account_id !== accountId) throw new Error('Job already charged to another account');
    const entry = previous ?? addEntry(db, { accountId, jobId, amount: -credits, reason: 'Flow generation' });
    if (outputFiles) db.prepare('UPDATE render_jobs SET output_media=? WHERE id=?').run(JSON.stringify(outputFiles), jobId);
    db.exec('COMMIT');
    return entry;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
