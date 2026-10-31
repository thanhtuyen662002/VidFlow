import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { parseAnalyticsCsv } from './analytics-csv.ts';
import { getWeights, initializeWeights } from './weights.ts';
import type { Weights } from './weights.ts';
import { getTimeline } from '../edit/timeline.ts';
import { getScene } from '../repo/scenes.ts';
import { getProject } from '../repo/projects.ts';
import { transaction } from '../repo/records.ts';
import { assertInsideDataDir } from '../media/paths.ts';

export class ProposalConflictError extends Error {}
export type BeatReport = { id: string; name: string; sceneIds: string[]; start: number; end: number; dropRate: number | null; flagged: boolean };
export type WeightProposal = { id: string; projectId: string; createdAt: string; sourceCsv: { name: string; hash: string }; status: 'pending' | 'accepted' | 'rejected'; baseWeights: Weights; proposedWeights: Weights; rationale: { beatId: string; message: string }[] };
function save(db: DatabaseSync, p: WeightProposal) {
  db.prepare('INSERT OR REPLACE INTO analytics_proposals VALUES (?,?,?)').run(p.id, p.projectId, JSON.stringify(p)); return p;
}
export function listProposals(db: DatabaseSync, projectId: string): WeightProposal[] {
  initializeWeights(db);
  return db.prepare('SELECT data FROM analytics_proposals WHERE project_id=? ORDER BY rowid').all(projectId).map(r => JSON.parse(String(r.data)));
}
export function acceptProposal(db: DatabaseSync, id: string) { return decide(db, id, true); }
export function rejectProposal(db: DatabaseSync, id: string) { return decide(db, id, false); }
function decide(db: DatabaseSync, id: string, accept: boolean) {
  initializeWeights(db);
  return transaction(db, () => {
    const row = db.prepare('SELECT data FROM analytics_proposals WHERE id=?').get(id);
    if (!row) throw new ProposalConflictError('Không tìm thấy đề xuất');
    const p: WeightProposal = JSON.parse(String(row.data));
    if (p.status !== 'pending') throw new ProposalConflictError('Đề xuất không còn chờ chấp nhận');
    if (accept) {
      if (!isDeepStrictEqual(p.baseWeights, getWeights(db, p.projectId))) throw new ProposalConflictError('Trọng số đã thay đổi; cần nhập lại CSV');
      db.prepare('INSERT OR REPLACE INTO script_weights VALUES (?,?)').run(p.projectId, JSON.stringify(p.proposedWeights));
    }
    return save(db, { ...p, status: accept ? 'accepted' : 'rejected' });
  });
}
/** Absolute fractional loss threshold, strictly >20% by default; no length normalization.
 * Boundary retention uses linear interpolation, never extrapolation. Zero baseline has zero loss.
 */
export function importAnalyticsCsv(db: DatabaseSync, projectId: string, timelineId: string, csvPath: string, threshold = 0.2) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError('Ngưỡng phải nằm trong 0–1');
  const project = getProject(db, projectId), timeline = getTimeline(db, timelineId);
  if (!project || !timeline || timeline.projectId !== projectId) throw new Error('Timeline không thuộc dự án');
  const path = assertInsideDataDir(csvPath, project.directory);
  const csv = readFileSync(path, 'utf8'), samples = parseAnalyticsCsv(csv);
  const clips = timeline.tracks.filter(t => t.kind === 'video' && !t.muted).flatMap(t => t.clips).sort((a,b) => a.timelineStart - b.timelineStart);
  if (!clips.length) throw new Error('Timeline không có cảnh');
  const report: BeatReport[] = [];
  for (const clip of clips) {
    const scene = clip.sceneId && getScene(db, clip.sceneId);
    if (!scene || scene.projectId !== projectId || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.timelineStart < 0) throw new Error('Cảnh timeline không hợp lệ');
    const previous = report.at(-1);
    if (previous && previous.end > clip.timelineStart) throw new Error('Timeline có cảnh chồng lấn');
    if (scene.beat && previous?.name === scene.beat && previous.end === clip.timelineStart) { previous.end += clip.duration; previous.sceneIds.push(scene.id); }
    else report.push({ id: scene.id, name: scene.beat || scene.title || scene.id, sceneIds: [scene.id], start: clip.timelineStart, end: clip.timelineStart + clip.duration, dropRate: null, flagged: false });
  }
  const warnings: string[] = [];
  const mappedSamples = samples.map(s => {
    const beat = report.find(b => s.seconds >= b.start && s.seconds < b.end);
    if (!beat) warnings.push(`Dòng ${s.line}: thời điểm ${s.seconds} ngoài các cảnh timeline`);
    return { ...s, beatId: beat?.id ?? null, sceneId: clips.find(c => s.seconds >= c.timelineStart && s.seconds < c.timelineStart + c.duration)?.sceneId ?? null };
  });
  function at(time: number): number | null {
    const right = samples.findIndex(s => s.seconds >= time);
    if (right < 0) return null;
    if (samples[right].seconds === time) return samples[right].retention;
    if (!right) return null;
    const a = samples[right - 1], b = samples[right];
    return a.retention + (b.retention - a.retention) * (time - a.seconds) / (b.seconds - a.seconds);
  }
  for (const beat of report) {
    const start = at(beat.start), end = at(beat.end);
    if (start === null || end === null) warnings.push(`Nhịp ${beat.name}: thiếu dữ liệu tại biên`);
    else { beat.dropRate = start === 0 ? 0 : Math.max(0, (start - end) / start); beat.flagged = beat.dropRate > threshold; }
  }
  report.sort((a,b) => (b.dropRate ?? -1) - (a.dropRate ?? -1) || a.start - b.start);
  initializeWeights(db);
  const proposal = transaction(db, () => {
    const baseWeights = getWeights(db, projectId), proposedWeights = { ...baseWeights };
    if (report.some(b => b.flagged)) proposedWeights.retention *= 1.25;
    return save(db, { id: randomUUID(), projectId, createdAt: new Date().toISOString(), sourceCsv: { name: basename(path), hash: createHash('sha256').update(csv).digest('hex') }, status: 'pending', baseWeights, proposedWeights,
      rationale: report.filter(b => b.flagged).map(b => ({ beatId: b.id, message: `Nhịp ${b.name} mất ${(b.dropRate! * 100).toFixed(1)}% người xem; tăng trọng số giữ chân 25%.` })) });
  });
  return { report, warnings, mappedSamples, threshold, proposal };
}
