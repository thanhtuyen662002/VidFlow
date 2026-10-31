export const motionStyleMigration = {
  version: 18, name: 'Motion presets and style approval', sql: `
CREATE TABLE motion_presets (
 id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, version INTEGER NOT NULL,
 config_hash TEXT NOT NULL, config TEXT NOT NULL CHECK(json_valid(config)),
 active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE motion_style_approvals (
 source_video_id TEXT PRIMARY KEY REFERENCES source_videos(id) ON DELETE CASCADE,
 preset_id TEXT NOT NULL REFERENCES motion_presets(id), preset_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
 summary TEXT NOT NULL CHECK(json_valid(summary)), credit_estimate INTEGER CHECK(credit_estimate>=0),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
 approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL,
 CHECK(status!='approved' OR (credit_estimate IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
` };
