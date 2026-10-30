import type { DatabaseSync } from 'node:sqlite';
import { createAccount as createLegacyAccount } from '../repo/accounts.ts';

export type AccountStatus = 'ready' | 'out_of_credit' | 'needs_owner' | 'disabled';
const statuses = ['ready', 'out_of_credit', 'needs_owner', 'disabled'];
function validate(status: string): void {
  if (!statuses.includes(status)) throw new Error('Invalid account status');
}
export function getAccount(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM flow_accounts WHERE id=?').get(id);
}
export function createAccount(db: DatabaseSync, input: { label: string; email?: string; status?: AccountStatus }) {
  validate(input.status ?? 'ready');
  db.exec('BEGIN IMMEDIATE');
  try {
    const account = createLegacyAccount(db, input);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO flow_accounts(id,label,email,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(account.id, input.label, input.email ?? null, input.status ?? 'ready', now, now);
    db.exec('COMMIT');
    return getAccount(db, account.id)!;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function listAccounts(db: DatabaseSync, options: { status?: AccountStatus } = {}) {
  if (options.status !== undefined) validate(options.status);
  return db.prepare('SELECT * FROM flow_accounts WHERE (? IS NULL OR status=?) ORDER BY created_at,id')
    .all(options.status ?? null, options.status ?? null);
}
export function setAccountStatus(db: DatabaseSync, id: string, status: AccountStatus, reason?: string) {
  validate(status);
  if (!db.prepare('UPDATE flow_accounts SET status=?,status_reason=?,updated_at=? WHERE id=?')
    .run(status, reason ?? null, new Date().toISOString(), id).changes) throw new Error('Account not found');
  return getAccount(db, id)!;
}
