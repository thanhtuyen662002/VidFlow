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
