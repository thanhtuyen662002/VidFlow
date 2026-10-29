import type { DatabaseSync } from 'node:sqlite';
import type { Reference } from '../types.ts';
import { createReference, updateReference, getReference, listReferences, deleteReference,
  listNameConflicts } from '../repo/references.ts';
import { normalizeRefName } from '../ref-name.ts';
import { parsePrompt } from './parse-refs.ts';
import { BibleDeleteConfirmationError } from './bible-errors.ts';
export { BibleDuplicateError, BibleDeleteConfirmationError } from './bible-errors.ts';
export { normalizeRefName } from '../ref-name.ts';

export type BibleKind = 'character' | 'location' | 'prop' | 'style';
export type BibleEntry = Reference & { kind: BibleKind };
export type BibleEntryInput = { kind: BibleKind; name: string; images: string[]; description: string; priority: number };
/** Lookup a canonical registry snapshot without accessing storage. */
export function lookupBibleEntry(entries: readonly BibleEntry[], name: string): BibleEntry | undefined {
  const key = normalizeRefName(name);
  return entries.filter(value => normalizeRefName(value.name) === key)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
}
function entry(ref: Reference): BibleEntry {
  return { ...ref, kind: ref.role as BibleKind };
}

export class BibleService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  add(projectId: string, input: BibleEntryInput): BibleEntry {
    const { kind, ...fields } = input;
    return entry(createReference(this.db, { ...fields, role: kind, project_id: projectId }));
  }

  update(projectId: string, id: string, patch: Partial<BibleEntryInput>): BibleEntry | undefined {
    const current = getReference(this.db, id);
    if (!current || current.project_id !== projectId) return undefined;
    const { kind, ...fields } = patch;
    const result = updateReference(this.db, id, { ...fields, ...(kind === undefined ? {} : { role: kind }) });
    return result ? entry(result) : undefined;
  }

  list(projectId: string): BibleEntry[] {
    return listReferences(this.db, projectId).map(entry);
  }

  listNameConflicts(projectId: string): BibleEntry[] {
    return listNameConflicts(this.db, projectId).map(entry);
  }

  delete(projectId: string, id: string, confirm = false): boolean {
    const current = getReference(this.db, id);
    if (!current || current.project_id !== projectId) return false;
    if (confirm !== true) throw new BibleDeleteConfirmationError(current.role, current.name);
    return deleteReference(this.db, id);
  }
}

export class UnregisteredReferenceError extends Error {
  readonly code = 'REF_UNREGISTERED';
  readonly normalizedName: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  constructor(name: string, offset: number, line: number, column: number) {
    super(`Reference @${name} is not registered (${line}:${column})`);
    this.name = name;
    this.normalizedName = normalizeRefName(name);
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export function validatePromptRefs(db: DatabaseSync, projectId: string, prompt: string): UnregisteredReferenceError[] {
  // Initialize raw M1 connections too, then use only the canonical registry keys.
  listReferences(db, projectId);
  const known = new Set(db.prepare('SELECT name_key FROM "references" WHERE project_id = ? AND name_conflict = 0')
    .all(projectId).map(row => String(row.name_key)));
  const errors: UnregisteredReferenceError[] = [];
  for (const token of parsePrompt(prompt)) {
    if (token.kind === 'ref' && !known.has(normalizeRefName(token.name))) {
      errors.push(new UnregisteredReferenceError(token.raw, token.start, token.line, token.column));
    }
  }
  return errors;
}
