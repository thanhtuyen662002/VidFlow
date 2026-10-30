import type { DatabaseSync } from 'node:sqlite';
import { repository } from './records.ts';

export type ScriptDecision = { id: string; variantId: string; kind: string; data: Record<string, unknown>; createdAt: string };
const decisions = repository<ScriptDecision>('script_decisions', {
  variantId: '', kind: '', data: {}, createdAt: '',
}, ['data']);
export const createScriptDecision = decisions.create;
export function listScriptDecisions(db: DatabaseSync, variantId: string): ScriptDecision[] {
  return decisions.list(db, 'variant_id=?', [variantId], 'rowid');
}
