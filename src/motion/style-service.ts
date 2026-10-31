import type { DatabaseSync } from 'node:sqlite';
import type { CompilerBible } from '../prompt/compiler.ts';
import { BibleService } from '../prompt/bible.ts';
import { getBible } from '../repo/bibles.ts';
import { getSourceVideo, listSegments } from './source-import.ts';
import { getEffectiveMapping, listSubjects, validateMappings, MOTION_ANALYSIS_SCHEMA } from './subjects.ts';
import type { MotionAnalysis } from './subjects.ts';
import { validateSchema } from '../script/llm/schema.ts';
import { compileMotionPrompts, estimateMotionCredits } from './style-compiler.ts';
import { configHash, loadStylePresets, syncMotionPresets, defaultPresetPath } from './preset-config.ts';

export interface StyleApproval {
  source_video_id: string; preset_id: string; preset_hash: string; input_hash: string;
  summary: string; credit_estimate: number | null; status: 'pending' | 'approved' | 'rejected';
  approved_by: string | null; approved_at: string | null; created_at: string;
  approvedWithVisualPreview?: boolean;
}
export class MotionStyleService {
  private db: DatabaseSync;
  private path: string | URL;
  private bibleFor: (projectId: string) => CompilerBible;
  constructor(db: DatabaseSync, options: { configPath?: string | URL; bibleFor?: (projectId: string) => CompilerBible } = {}) {
    this.db = db; this.path = options.configPath ?? defaultPresetPath;
    this.bibleFor = options.bibleFor ?? (projectId => ({ style: '', lighting: '', palette: '', lens: '', safe_area: '', avoid: '', ...getBible(db,projectId), entries: new BibleService(db).list(projectId) }));
  }
  private build(sourceVideoId: string, presetKey: string) {
    const db = this.db, video = getSourceVideo(db,sourceVideoId);
    validateMappings(db,sourceVideoId);
    const config = loadStylePresets(this.path);
    syncMotionPresets(db,config);
    const preset = config.presets.find(p => p.key === presetKey);
    if (!preset) throw new Error(`Unknown motion preset: ${presetKey}`);
    const segments = listSegments(db,sourceVideoId);
    if (!segments.length) throw new Error('No source segments');
    const subjects = listSubjects(db,sourceVideoId);
    const mapping = subjects.map(s => getEffectiveMapping(db,s.id)!);
    const analysis = segments.map(segment => {
      const raw = db.prepare('SELECT motion_analysis FROM source_segments WHERE id=?').get(segment.id)!.motion_analysis;
      const data: unknown = raw ? JSON.parse(String(raw)) : null;
      if (!validateSchema(data,MOTION_ANALYSIS_SCHEMA).valid) throw new Error(`Missing or invalid analysis: ${segment.id}`);
      return { segment, analysis: data as MotionAnalysis, subjects: subjects.filter(s => s.segment_id === segment.id) };
    });
    const bible = this.bibleFor(video.project_id);
    const prompts = compileMotionPrompts(analysis,mapping,preset,bible);
    const estimate = estimateMotionCredits(segments,config.pricing);
    // Include raw analysis/mappings as well as output: even a non-prompt edit requires renewed review.
    return { presetHash: configHash(preset), inputHash: configHash({ analysis,mapping,bible,preset,pricing: config.pricing }),
      estimate, summary: JSON.stringify({ kind: 'text-preview', prompts, creditEstimate: estimate,
        variants: config.pricing.variants, segmentEstimates: segments.map(s => ({ segmentId: s.id,
          credits: estimateMotionCredits([s], config.pricing) })),
        visualPreview: { status: 'awaiting-M10.5', segmentIds: segments.slice(0,3).map(s => s.id) } }) };
  }
  createStylePreview(sourceVideoId: string, presetKey: string): StyleApproval {
    const value = this.build(sourceVideoId,presetKey);
    this.db.prepare(`INSERT INTO motion_style_approvals VALUES (?,?,?,?,?,?,'pending',NULL,NULL,?)
      ON CONFLICT(source_video_id) DO UPDATE SET preset_id=excluded.preset_id,preset_hash=excluded.preset_hash,
      input_hash=excluded.input_hash,summary=excluded.summary,credit_estimate=excluded.credit_estimate,status='pending',
      approved_by=NULL,approved_at=NULL,created_at=excluded.created_at`)
      .run(sourceVideoId,presetKey,value.presetHash,value.inputHash,value.summary,value.estimate,new Date().toISOString());
    return this.row(sourceVideoId)!;
  }
  private row(id: string): StyleApproval | undefined {
    const row = this.db.prepare('SELECT * FROM motion_style_approvals WHERE source_video_id=?').get(id) as unknown as StyleApproval | undefined;
    return row ? { ...row, approvedWithVisualPreview: JSON.parse(row.summary).approvedWithVisualPreview === true } : undefined;
  }
  getStyleApproval(id: string): StyleApproval | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    let current = false;
    try {
      const value = this.build(id,row.preset_id);
      current = value.inputHash === row.input_hash && value.presetHash === row.preset_hash && value.estimate === row.credit_estimate;
    } catch { current = false; }
    if (!current) {
      this.db.prepare("UPDATE motion_style_approvals SET status='pending',approved_by=NULL,approved_at=NULL,credit_estimate=NULL WHERE source_video_id=?").run(id);
      return this.row(id);
    }
    return row;
  }
  approveStyle(sourceVideoId: string, approver: string): StyleApproval {
    if (!approver.trim()) throw new Error('Owner approver required');
    const row = this.getStyleApproval(sourceVideoId);
    if (!row || row.credit_estimate === null) throw new Error('Current preview and credit estimate required before approval');
    if (row.status !== 'pending') throw new Error('Style preview is not pending');
    const summary = JSON.parse(row.summary);
    summary.approvedWithVisualPreview = summary.visualPreview?.status === 'ready';
    this.db.prepare('UPDATE motion_style_approvals SET summary=? WHERE source_video_id=?').run(JSON.stringify(summary), sourceVideoId);
    this.db.prepare("UPDATE motion_style_approvals SET status='approved',approved_by=?,approved_at=? WHERE source_video_id=?")
      .run(approver,new Date().toISOString(),sourceVideoId);
    return this.row(sourceVideoId)!;
  }
  /** M10.5 must call immediately before queueing any motion render. */
  assertStyleApproved(sourceVideoId: string): void {
    if (this.getStyleApproval(sourceVideoId)?.status !== 'approved') throw new Error('Owner style approval required');
  }
}
