import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getProject } from './projects.ts';
import { ValidationError } from '../validate.ts';

export type CreditEntry = { id: string; projectId: string; accountId: string | null; delta: number; reason: string; refType: string | null; refId: string | null; createdAt: string };
type Filter = { projectId?: string; accountId?: string };
function filter(input: Filter): { sql: string; args: SQLInputValue[] } {
  const clauses: string[] = [], args: SQLInputValue[] = [];
  if (input.projectId !== undefined) { clauses.push('project_id=?'); args.push(input.projectId); }
  if (input.accountId !== undefined) { clauses.push('account_id=?'); args.push(input.accountId); }
  return { sql: clauses.join(' AND ') || '1=1', args };
}
function decode(row: Record<string, unknown>): CreditEntry {
  return { id: row.id as string, projectId: row.project_id as string, accountId: row.account_id as string | null, delta: row.delta as number, reason: row.reason as string, refType: row.ref_type as string | null, refId: row.ref_id as string | null, createdAt: row.created_at as string };
}
export function addEntry(db: DatabaseSync, input: Omit<CreditEntry, 'id' | 'createdAt' | 'accountId' | 'refType' | 'refId'> & { accountId?: string | null; refType?: string | null; refId?: string | null }): CreditEntry {
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw new ValidationError('delta must be a non-zero safe integer');
  if (!getProject(db, input.projectId)) throw new ValidationError('Project not found');
  if (input.accountId != null && !db.prepare('SELECT id FROM accounts WHERE id=?').get(input.accountId)) throw new ValidationError('Account not found');
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new ValidationError('Reason is required');
  const id = randomUUID(), createdAt = new Date().toISOString();
  db.prepare('INSERT INTO credit_ledger(id,project_id,account_id,delta,credits,reason,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, input.projectId, input.accountId ?? null, input.delta, -input.delta, input.reason, input.refType ?? null, input.refId ?? null, createdAt);
  return decode(db.prepare('SELECT * FROM credit_ledger WHERE id=?').get(id)!);
}
export function listEntries(db: DatabaseSync, input: Filter = {}): CreditEntry[] {
  const { sql, args } = filter(input);
  return db.prepare('SELECT * FROM credit_ledger WHERE '+sql+' ORDER BY created_at, id').all(...args).map(decode);
}
export function getBalance(db: DatabaseSync, input: Filter = {}): number {
  const { sql, args } = filter(input);
  return db.prepare('SELECT COALESCE(SUM(delta),0) AS balance FROM credit_ledger WHERE '+sql).get(...args)!.balance as number;
}
export function getProjectBudgetStatus(db: DatabaseSync, projectId: string): { budget: number | null; spent: number; remaining: number | null } {
  const project = getProject(db, projectId);
  if (!project) throw new ValidationError('Project not found');
  const spent = db.prepare('SELECT COALESCE(SUM(-delta),0) AS spent FROM credit_ledger WHERE project_id=? AND delta<0').get(projectId)!.spent as number;
  return { budget: project.budget, spent, remaining: project.budget === null ? null : project.budget - spent };
}
