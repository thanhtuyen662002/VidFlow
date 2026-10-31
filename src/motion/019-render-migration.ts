export const motionRenderMigration = {
  version: 19, name: 'Motion RenderJob state', sql: `
ALTER TABLE render_jobs ADD COLUMN source_segment_id TEXT REFERENCES source_segments(id);
ALTER TABLE render_jobs ADD COLUMN motion_state TEXT CHECK(motion_state IS NULL OR json_valid(motion_state));
CREATE UNIQUE INDEX motion_segment_job ON render_jobs(source_segment_id) WHERE source_segment_id IS NOT NULL;
CREATE UNIQUE INDEX motion_operation_step ON render_jobs(
  json_extract(payload,'$.parentId'), json_extract(payload,'$.generation'), json_extract(payload,'$.step'))
  WHERE json_extract(payload,'$.internalMotionStep')=1 AND json_extract(payload,'$.parentId') IS NOT NULL;
` };
