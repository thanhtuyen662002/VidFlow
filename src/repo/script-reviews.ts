import type { DatabaseSync } from 'node:sqlite';
import type { ScriptReview } from '../types.ts';
import { repository } from './records.ts';

const reviews = repository<ScriptReview>('script_reviews', {
  variantId: '', score: 0, comment: '', issues: [], reviewerModel: '', createdAt: '',
}, ['issues']);
export const createScriptReview = reviews.create;
export function listScriptReviews(db: DatabaseSync, variantId: string): ScriptReview[] {
  return reviews.list(db, 'variant_id=?', [variantId], 'created_at, rowid');
}
