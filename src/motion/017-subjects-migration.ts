export const motionSubjectsMigration = {
  version: 17, name: 'Motion subjects and owner mappings', sql: `
ALTER TABLE source_videos ADD COLUMN face_consent INTEGER NOT NULL DEFAULT 0 CHECK(face_consent IN (0,1));
CREATE UNIQUE INDEX source_segment_video ON source_segments(id,source_video_id);
CREATE TABLE motion_subjects (
 id TEXT PRIMARY KEY, source_video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
 segment_id TEXT NOT NULL, subject_key TEXT NOT NULL CHECK(length(subject_key)>0),
 kind TEXT NOT NULL CHECK(kind IN ('person','hand','object','scene')),
 description TEXT NOT NULL, motion_description TEXT NOT NULL, composition TEXT NOT NULL,
 has_human_face INTEGER NOT NULL CHECK(has_human_face IN (0,1)),
 ai_suggestion TEXT CHECK(ai_suggestion IS NULL OR json_valid(ai_suggestion)),
 analyzed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(segment_id,subject_key),
 FOREIGN KEY(segment_id,source_video_id) REFERENCES source_segments(id,source_video_id) ON DELETE CASCADE
);
CREATE TABLE motion_mappings (
 id TEXT PRIMARY KEY, subject_id TEXT NOT NULL UNIQUE REFERENCES motion_subjects(id) ON DELETE CASCADE,
 target_type TEXT NOT NULL CHECK(target_type IN ('character','scene','keep','drop','faceless')),
 target_ref TEXT, target_id TEXT,
 source TEXT NOT NULL CHECK(source IN ('ai','owner')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((target_type IN ('character','scene') AND target_ref IS NOT NULL AND target_id IS NOT NULL)
 OR (target_type IN ('keep','drop','faceless') AND target_ref IS NULL AND target_id IS NULL))
);
ALTER TABLE source_segments ADD COLUMN motion_analysis TEXT CHECK(motion_analysis IS NULL OR json_valid(motion_analysis));
` };
