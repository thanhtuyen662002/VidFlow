import type { DatabaseSync } from 'node:sqlite';
import { repository } from './records.ts';
import { ValidationError } from '../validate.ts';

export type Account = { id: string; provider: string; label: string; email: string | null; type: string; profile: string; credits: number; creditRefreshAt: string | null; status: string; concurrencyLimit: number; secretRef: string | null; createdAt: string; updatedAt: string };
const repo = repository<Account>('accounts', { provider: 'flow', label: '', email: null, type: 'Pro', profile: '', credits: 0, creditRefreshAt: null, status: 'ready', concurrencyLimit: 1, secretRef: null, createdAt: '', updatedAt: '' });
type Input = Partial<Omit<Account, 'id' | 'createdAt' | 'updatedAt'>>;
function validate(input: Input): void {
  for (const key of ['secret', 'password', 'token', 'cookie', 'apiKey']) {
    if (key in input) throw new ValidationError('Store only a secretRef, never a raw secret');
  }
  for (const key of ['provider', 'label', 'type', 'status'] as const) {
    if (typeof input[key] !== 'string' || !input[key]!.trim()) throw new ValidationError(`Invalid ${key}`);
  }
  if (!Number.isSafeInteger(input.concurrencyLimit) || input.concurrencyLimit! < 1) throw new ValidationError('Invalid concurrency limit');
  if (input.secretRef !== null && typeof input.secretRef !== 'string') throw new ValidationError('Invalid secret reference');
}
export const getAccount = repo.get;
export function listAccounts(db: DatabaseSync): Account[] { return repo.list(db, '1=1', [], 'created_at, id'); }
export function createAccount(db: DatabaseSync, input: Input & { label: string }): Account {
  validate({ provider: 'flow', type: 'Pro', status: 'ready', concurrencyLimit: 1, secretRef: null, ...input });
  return repo.create(db, input);
}
export function updateAccount(db: DatabaseSync, id: string, patch: Input): Account | undefined {
  const current = getAccount(db, id);
  if (!current) return undefined;
  validate({ ...current, ...patch });
  return repo.update(db, id, patch);
}
export function deleteAccount(db: DatabaseSync, id: string): boolean {
  if (db.prepare('SELECT id FROM credit_ledger WHERE account_id=? LIMIT 1').get(id)) throw new ValidationError('Account still has ledger entries');
  return repo.remove(db, id);
}
