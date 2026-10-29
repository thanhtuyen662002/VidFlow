import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveInside, projectDirectory } from '../paths.ts';
import { DuplicateError } from '../types.ts';
import { ValidationError } from '../validate.ts';
import { getProject } from './projects.ts';
import { repository } from './records.ts';

export type Asset = { id: string; projectId: string; kind: string; relPath: string; mime: string | null; sizeBytes: number | null; sha256: string | null; createdAt: string };
const repo = repository<Asset & { type: string; file: string }>('assets', { projectId: '', kind: '', relPath: '', mime: null, sizeBytes: null, sha256: null, createdAt: '', type: '', file: '' });
type Input = Pick<Asset, 'projectId' | 'kind' | 'relPath'> & Partial<Pick<Asset, 'mime' | 'sizeBytes' | 'sha256'>>;
function checked(db: DatabaseSync, input: Input): Input & { type: string; file: string } {
  if (!getProject(db, input.projectId)) throw new ValidationError('Project not found');
  if (typeof input.relPath !== 'string' || !input.relPath || input.relPath.includes('\0')) throw new ValidationError('Invalid asset path');
  const directory = projectDirectory(input.projectId);
  resolveInside(directory, input.relPath);
  const relPath = posix.normalize(input.relPath.replaceAll('\\', '/'));
  resolveInside(directory, relPath);
  if (typeof input.kind !== 'string' || !input.kind.trim()) throw new ValidationError('Invalid asset kind');
  if (input.sizeBytes != null && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)) throw new ValidationError('Invalid asset size');
  return { ...input, relPath, type: input.kind, file: relPath };
}
function decode(value: (Asset & { type: string; file: string }) | undefined): Asset | undefined {
  if (!value) return undefined;
  const { type, file, ...asset } = value;
  return asset;
}
function write(action: () => Asset | undefined): Asset | undefined {
  try { return action(); } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new DuplicateError('Asset path already exists in this project');
    throw error;
  }
}
export function createAsset(db: DatabaseSync, input: Input): Asset { return write(() => decode(repo.create(db, checked(db, input))))!; }
export function getAsset(db: DatabaseSync, id: string): Asset | undefined { return decode(repo.get(db, id)); }
export function listAssets(db: DatabaseSync, projectId: string, kind?: string): Asset[] {
  return repo.list(db, 'project_id=?'+(kind === undefined ? '' : ' AND kind=?'), kind === undefined ? [projectId] : [projectId, kind], 'created_at, id').map(value => decode(value)!);
}
export function updateAsset(db: DatabaseSync, id: string, patch: Partial<Omit<Input, 'projectId'>>): Asset | undefined {
  const current = getAsset(db, id);
  return current ? write(() => decode(repo.update(db, id, checked(db, { ...current, ...patch })))) : undefined;
}
export const deleteAsset = repo.remove;
