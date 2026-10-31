import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../types.ts';
import type { Timeline } from './timeline.ts';
import type { LlmClient } from '../script/llm/types.ts';
import { listMusicTracks } from '../repo/music.ts';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { extractFrame } from '../media/extract-frame.ts';
import { timelineSrt } from './subtitles.ts';

// Việc đăng lên nền tảng do chủ sở hữu thực hiện thủ công.
export interface MusicLicense {
  clipId?: string;
  trackId: string; title: string; source: string; licenseType: string;
  proof: string; status: 'licensed' | 'unlicensed' | 'unknown';
}
export function aiDisclosure(tools: string[]) {
  return { madeWithAI: true, statement: `Nội dung này được tạo bằng AI. Công cụ/mô hình: ${tools.join(', ')}.`, tools };
}
export interface PackageManifest {
  projectId: string; state: 'draft' | 'ready_to_publish';
  files: { path: string; sha256: string; size: number; role: string; status: string }[];
}
export function collectMusicLicenses(db: DatabaseSync, project: Project, timeline: Timeline): MusicLicense[] {
  const library = listMusicTracks(db, project.id);
  return timeline.tracks.filter(t => t.kind === 'music' && !t.muted).flatMap(t => t.clips).map(c => {
    const track = library.find(m => resolveInside(project.directory, m.file) === assertInsideDataDir(c.sourcePath, project.directory));
    return { clipId: c.id, trackId: track?.id ?? c.id, title: track?.title ?? c.id,
      source: track?.attribution ?? c.sourcePath, licenseType: track?.hasLicense ? 'Giấy phép đã xác nhận' : 'Chưa xác định',
      proof: track?.licenseSource ?? '', status: track ? track.hasLicense && track.licenseSource.trim() ? 'licensed' : 'unlicensed' : 'unknown' };
  });
}
function packageRoot(projectDir: string, directory: string): string {
  assertInsideDataDir(projectDir, dataDirectory());
  return assertInsideDataDir(directory, resolveInside(projectDir, 'exports'));
}
export async function validatePackage(projectDir: string, directory: string): Promise<PackageManifest> {
  const root = packageRoot(projectDir, directory);
  const manifest: PackageManifest = JSON.parse(await readFile(resolveInside(root, 'manifest.json'), 'utf8'));
  for (const name of ['ai-disclosure.json', 'ai-disclosure.txt', 'description.md', 'music-licenses.json']) {
    if (!manifest.files.some(f => f.path === name)) throw new Error(`Gói thiếu tệp bắt buộc: ${name}`);
  }
  let disclosure: { madeWithAI?: boolean; statement?: string; tools?: unknown[] };
  try { disclosure = JSON.parse(await readFile(resolveInside(root, 'ai-disclosure.json'), 'utf8')); }
  catch { throw new Error('Thiếu hoặc rỗng khai báo nội dung được tạo bằng AI'); }
  if (!disclosure || disclosure.madeWithAI !== true || typeof disclosure.statement !== 'string' || !disclosure.statement.includes('AI') || !Array.isArray(disclosure.tools) || !disclosure.tools.length)
    throw new Error('Thiếu khai báo nội dung được tạo bằng AI');
  for (const name of ['ai-disclosure.txt', 'description.md']) {
    if (!(await readFile(resolveInside(root, name), 'utf8')).includes(disclosure.statement))
      throw new Error('Thiếu dòng khai báo AI trong mô tả hoặc bản khai báo');
  }
  for (const file of manifest.files) {
    const bytes = await readFile(resolveInside(root, file.path));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error(`Tệp gói không toàn vẹn: ${file.path}`);
  }
  return manifest;
}
export async function markReadyToPublish(projectDir: string, directory: string): Promise<PackageManifest> {
  const manifest = await validatePackage(projectDir, directory);
  const licenses: MusicLicense[] = JSON.parse(await readFile(resolveInside(directory, 'music-licenses.json'), 'utf8'));
  const problems = licenses.filter(t => t.status !== 'licensed' || !t.proof.trim());
  if (problems.length) throw new Error(`Chưa thể sẵn sàng đăng: nhạc chưa có giấy phép: ${problems.map(t => `${t.title} (${t.trackId})`).join(', ')}`);
  manifest.state = 'ready_to_publish';
  const temporary = resolveInside(directory, `manifest-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await rename(temporary, resolveInside(directory, 'manifest.json'));
  return manifest;
}
export async function buildPublishPackage(input: {
  project: Project; timeline: Timeline; videos: { aspect: string; path: string }[];
  licenses: MusicLicense[]; llm: LlmClient; llmModel: string; ttsModel?: string; coverPath?: string;
}) {
  const { project, timeline } = input;
  assertInsideDataDir(project.directory, dataDirectory());
  if (timeline.projectId !== project.id || !input.videos.length) throw new Error('Dự án hoặc video của gói không hợp lệ');
  // An omitted library record must never silently turn a used audio clip into licensed music.
  const licenses = [...input.licenses];
  for (const clip of timeline.tracks.filter(t => t.kind === 'music' && !t.muted).flatMap(t => t.clips)) {
    if (!licenses.some(l => l.clipId === clip.id || l.trackId === clip.id)) licenses.push({
      clipId: clip.id, trackId: clip.id, title: clip.id, source: clip.sourcePath,
      licenseType: 'Chưa xác định', proof: '', status: 'unknown',
    });
  }
  const suggestion = JSON.parse((await input.llm.complete({ prompt: `Đề xuất tiêu đề, mô tả và hashtag cho ${project.name}. Chỉ trả JSON {"title":string,"description":string,"hashtags":string[]}.`, timeoutMs: 120000 })).text);
  if (typeof suggestion.title !== 'string' || typeof suggestion.description !== 'string' || !Array.isArray(suggestion.hashtags) || suggestion.hashtags.some((h: unknown) => typeof h !== 'string')) throw new Error('Mô tả LLM không hợp lệ');
  const slug = project.name.normalize('NFKD').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || project.id;
  const directory = resolveInside(project.directory, `exports/${slug}/${Date.now()}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const manifest: PackageManifest = { projectId: project.id, state: 'draft', files: [] };
  const record = async (name: string, role: string) => {
    const bytes = await readFile(resolveInside(directory, name));
    manifest.files.push({ path: name, role, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'complete' });
  };
  const save = async (name: string, content: string, role: string) => {
    await writeFile(resolveInside(directory, name), content, { flag: 'wx' }); await record(name, role);
  };
  const copy = async (source: string, name: string, role: string) => {
    await copyFile(assertInsideDataDir(source, project.directory), resolveInside(directory, name), constants.COPYFILE_EXCL); await record(name, role);
  };
  for (const video of input.videos) {
    if (!['16:9', '9:16'].includes(video.aspect)) throw new Error('Tỉ lệ video không hợp lệ');
    await copy(video.path, `video-${video.aspect.replace(':', 'x')}.mp4`, 'video');
  }
  await save('subtitles.srt', timelineSrt(timeline), 'subtitles');
  const cover = input.coverPath ?? (await extractFrame(project.directory, input.videos[0].path, 0, { fileName: `cover-${randomUUID()}.png` })).path;
  await copy(cover, 'cover.png', 'cover');
  const tools = ['Google Flow/Veo', input.llmModel, ...(input.ttsModel ? [input.ttsModel] : [])];
  const { statement } = aiDisclosure(tools);
  await save('ai-disclosure.json', JSON.stringify({ madeWithAI: true, statement, tools }, null, 2), 'ai-disclosure');
  await save('ai-disclosure.txt', statement + '\n', 'ai-disclosure');
  await save('description.json', JSON.stringify({ ...suggestion, aiDisclosure: statement }, null, 2), 'description');
  await save('description.md', `# ${suggestion.title}\n\n${suggestion.description}\n\n${suggestion.hashtags.join(' ')}\n\n${statement}\n`, 'description');
  await save('music-licenses.json', JSON.stringify(licenses, null, 2), 'music-licenses');
  // manifest.json is the index; hashing itself would be circular.
  await writeFile(resolveInside(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await validatePackage(project.directory, directory);
  return { directory, manifest };
}
