import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../repo/records.ts';
import { getScene } from '../repo/scenes.ts';
import { getTake, getCurrentSelection } from '../repo/renders.ts';
import { getReviewScene, resolveSelection } from '../render/orchestrator.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { dataDirectory } from '../paths.ts';

export class NoSelectedTakeError extends Error {
  readonly code = 'TIMELINE_SCENE_NO_SELECTED_TAKE';
  readonly sceneIds: string[];
  constructor(sceneIds: string[]) {
    super(`Scenes have no selected take: ${sceneIds.join(', ')}`);
    this.name = 'NoSelectedTakeError'; this.sceneIds = sceneIds;
  }
}
export class InvalidTimelineSelectionError extends Error {
  readonly code = 'TIMELINE_INVALID_SELECTION';
  readonly sceneIds: string[];
  constructor(sceneIds: string[]) {
    super(`Invalid selected take or in/out: ${sceneIds.join(', ')}`);
    this.name = 'InvalidTimelineSelectionError'; this.sceneIds = sceneIds;
  }
}
export type TimelineClip = {
  id: string; trackId: string; sceneId: string | null; takeId: string | null;
  sourceAssetId: string | null; sourcePath: string; inPoint: number; outPoint: number;
  timelineStart: number; duration: number; order: number;
  /** Source-relative seconds, before trimming. Optional for older snapshots. */
  dialogueLines?: { text: string; start: number; end: number }[];
};
export type TimelineSubtitle = { id: string; trackId: string; sceneId: string; text: string; start: number; end: number; order: number };
export type TimelineTrack = { id: string; timelineId: string; kind: 'video' | 'dialogue' | 'music' | 'subtitle'; order: number; muted: boolean; clips: TimelineClip[]; subtitles: TimelineSubtitle[] };
export type Timeline = { id: string; projectId: string; createdAt: string; revision: number; status: string; tracks: TimelineTrack[]; fps?: number };

export function getTimeline(db: DatabaseSync, id: string): Timeline | undefined {
  const row = db.prepare('SELECT id,project_id AS projectId,created_at AS createdAt,revision,status FROM timeline WHERE id=?').get(id);
  if (!row) return undefined;
  const tracks = db.prepare('SELECT id,timeline_id AS timelineId,kind,"order",muted FROM timeline_track WHERE timeline_id=? ORDER BY "order"').all(id).map(track => ({
    ...track, muted: Boolean(track.muted),
    clips: db.prepare(`SELECT id,track_id AS trackId,scene_id AS sceneId,take_id AS takeId,
      source_asset_id AS sourceAssetId,source_path AS sourcePath,in_point AS inPoint,out_point AS outPoint,
      timeline_start AS timelineStart,duration,"order" FROM timeline_clip WHERE track_id=? ORDER BY "order"`).all(track.id),
    subtitles: db.prepare('SELECT id,track_id AS trackId,scene_id AS sceneId,text,start,end,"order" FROM timeline_subtitle WHERE track_id=? ORDER BY "order"').all(track.id),
  }));
  return { ...row, tracks } as Timeline;
}

/** Read-only media references; all times are seconds, matching M6. Each build is a new snapshot. */
export function buildTimelineFromSelectedTakes(db: DatabaseSync, projectId: string): Timeline {
  return transaction(db, () => {
    const project = db.prepare('SELECT directory FROM projects WHERE id=?').get(projectId);
    if (!project) throw new Error('Project not found');
    const root = assertInsideDataDir(String(project.directory), dataDirectory());
    // Match M6 planning order, including script-variant scenes.
    const scenes = db.prepare('SELECT id FROM scenes WHERE project_id=? ORDER BY "index",id').all(projectId)
      .map(row => getScene(db, String(row.id))!);
    const hasReviews = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='render_reviews'").get();
    const missing: string[] = [], invalid: string[] = [];
    const inputs = scenes.flatMap(scene => {
      const review = hasReviews ? db.prepare(`SELECT r.step_id FROM render_reviews r
        JOIN render_plan_steps s ON s.id=r.step_id JOIN render_plans p ON p.id=s.plan_id
        WHERE s.scene_id=? AND p.project_id=? ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1`).get(scene.id, projectId) : undefined;
      let selected: { takeId: string; inPoint: number; outPoint: number };
      if (review) {
        const state = getReviewScene(db, String(review.step_id));
        if (!state.suggestion && !state.override) { missing.push(scene.id); return []; }
        try { selected = resolveSelection(state); }
        catch { invalid.push(scene.id); return []; }
      } else {
        const selection = getCurrentSelection(db, scene.id);
        if (!selection) { missing.push(scene.id); return []; }
        selected = { takeId: selection.takeId, inPoint: selection.in, outPoint: selection.out };
      }
      const take = getTake(db, selected.takeId);
      const { inPoint, outPoint } = selected;
      if (!take || take.sceneId !== scene.id || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)
        || inPoint < 0 || outPoint <= inPoint || (take.durationSec > 0 && outPoint > take.durationSec)) {
        invalid.push(scene.id); return [];
      }
      assertInsideDataDir(take.file, root);
      return [{ scene, take, inPoint, outPoint }];
    });
    if (missing.length) throw new NoSelectedTakeError(missing);
    if (invalid.length) throw new InvalidTimelineSelectionError(invalid);
    const id = randomUUID();
    const revision = Number(db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS n FROM timeline WHERE project_id=?').get(projectId)!.n);
    db.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)').run(id, projectId, new Date().toISOString(), revision, 'draft');
    const tracks = new Map<string, string>();
    for (const [order, kind] of ['video', 'dialogue', 'music', 'subtitle'].entries()) {
      const trackId = randomUUID(); tracks.set(kind, trackId);
      db.prepare('INSERT INTO timeline_track VALUES (?,?,?,?,?)').run(trackId, id, kind, order, Number(kind === 'dialogue'));
    }
    let start = 0;
    inputs.forEach(({ scene, take, inPoint, outPoint }, order) => {
      const duration = outPoint - inPoint;
      for (const kind of ['video', ...(scene.dialogue.trim() || scene.sfx.trim() || take.metadata.hasAudio === true ? ['dialogue'] : [])]) {
        db.prepare('INSERT INTO timeline_clip VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), tracks.get(kind)!,
          scene.id, take.id, take.assetId, take.file, inPoint, outPoint, start, duration, order);
      }
      if (scene.dialogue.trim()) db.prepare('INSERT INTO timeline_subtitle VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), tracks.get('subtitle')!, scene.id, scene.dialogue, start, start + duration, order);
      start += duration;
    });
    return getTimeline(db, id)!;
  });
}
