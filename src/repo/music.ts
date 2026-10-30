import type { DatabaseSync } from 'node:sqlite';
import { resolveInside } from '../paths.ts';
import { getProject } from './projects.ts';
import { repository } from './records.ts';

export interface MusicTrack {
  id: string; projectId: string; file: string; title: string;
  hasLicense: boolean; licenseSource: string; attribution: string;
}
type Input = Omit<MusicTrack, 'id'>;
const repo = repository<MusicTrack>('music_tracks', {
  projectId: '', file: '', title: '', hasLicense: false, licenseSource: '', attribution: '',
}, [], ['hasLicense']);
function checked(db: DatabaseSync, input: Input): Input {
  const project = getProject(db, input.projectId);
  if (!project) throw new Error('Không tìm thấy dự án');
  if (!input.file || input.file.includes('\0')) throw new Error('Đường dẫn nhạc không hợp lệ');
  resolveInside(project.directory, input.file);
  if (typeof input.hasLicense !== 'boolean' ||
      [input.title, input.licenseSource, input.attribution].some(value => typeof value !== 'string') ||
      (input.hasLicense && !input.licenseSource.trim())) throw new Error('Thông tin giấy phép không hợp lệ');
  return input;
}
export function createMusicTrack(db: DatabaseSync, input: Input): MusicTrack { return repo.create(db, checked(db, input)); }
export const getMusicTrack = repo.get;
export const deleteMusicTrack = repo.remove;
export function listMusicTracks(db: DatabaseSync, projectId: string): MusicTrack[] { return repo.list(db, 'project_id=?', [projectId]); }
export function updateMusicTrack(db: DatabaseSync, id: string, patch: Partial<Omit<Input, 'projectId'>>): MusicTrack | undefined {
  const current = repo.get(db, id);
  return current ? repo.update(db, id, checked(db, { ...current, ...patch })) : undefined;
}
