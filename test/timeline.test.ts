import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createRenderJob, createTake, createSelection } from '../src/repo/renders.ts';
import { buildRenderPlan } from '../src/render/plans.ts';
import { initializeRenderReviews, setOwnerOverride } from '../src/render/orchestrator.ts';
import { buildTimelineFromSelectedTakes, getTimeline, NoSelectedTakeError, InvalidTimelineSelectionError } from '../src/edit/timeline.ts';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const directory = join(process.env.VIDFLOW_HOME!, 'projects', 'p');
  mkdirSync(directory, { recursive: true });
  db.prepare('INSERT INTO projects(id,name,aspect,directory,created_at) VALUES (?,?,?,?,?)').run('p', 'Project', '16:9', directory, 'now');
  const file = join(directory, 'original.txt'); writeFileSync(file, 'immutable fixture');
  const scenes = [0, 1, 2].map(i => createScene(db, { projectId: 'p', dialogue: i === 1 ? '' : `Line ${i}` }));
  const takes = scenes.map(scene => {
    const job = createRenderJob(db, { projectId: 'p', sceneId: scene.id });
    return [0, 1].map(() => createTake(db, { sceneId: scene.id, renderJobId: job.id, file, durationSec: 8 }));
  });
  return { db, scenes, takes, file };
}

test('timeline snapshots selected takes, seconds, scene order, subtitles and immutable originals', t => {
  const { db, scenes, takes, file } = fixture(t);
  scenes.forEach((scene, i) => createSelection(db, { sceneId: scene.id, takeId: takes[i][1].id, in: i + 0.25, out: i + 2.75 }));
  const before = db.prepare('SELECT * FROM takes ORDER BY id').all();
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const checksum = hash(), mtime = statSync(file).mtimeMs;
  const timeline = buildTimelineFromSelectedTakes(db, 'p');
  assert.deepEqual(getTimeline(db, timeline.id), timeline);
  assert.equal(getTimeline(db, 'absent'), undefined);
  assert.deepEqual(timeline.tracks.map(track => track.kind), ['video', 'dialogue', 'music', 'subtitle']);
  const clips = timeline.tracks[0].clips; assert.equal(clips.length, 3);
  assert.deepEqual(clips.map(c => c.sceneId), scenes.map(s => s.id));
  assert.deepEqual(clips.map(c => c.takeId), takes.map(ts => ts[1].id));
  assert.deepEqual(clips.map(c => [c.inPoint, c.outPoint, c.timelineStart, c.duration, c.order]),
    [[0.25, 2.75, 0, 2.5, 0], [1.25, 3.75, 2.5, 2.5, 1], [2.25, 4.75, 5, 2.5, 2]]);
  assert.deepEqual(timeline.tracks[1].clips.map(c => [c.inPoint, c.outPoint, c.timelineStart]), [[0.25, 2.75, 0], [2.25, 4.75, 5]]);
  assert.equal(timeline.tracks[1].muted, true);
  assert.equal(timeline.tracks[2].clips.length, 0);
  assert.deepEqual(timeline.tracks[3].subtitles.map(s => [s.text, s.start, s.end]), [['Line 0', 0, 2.5], ['Line 2', 5, 7.5]]);
  db.prepare("UPDATE projects SET aspect='9:16' WHERE id='p'").run();
  const next = buildTimelineFromSelectedTakes(db, 'p');
  assert.notEqual(next.id, timeline.id); assert.equal(next.revision, 2);
  assert.deepEqual(next.tracks[0].clips.map(c => c.timelineStart), clips.map(c => c.timelineStart));
  assert.deepEqual(getTimeline(db, timeline.id), timeline);
  assert.deepEqual(db.prepare('SELECT * FROM takes ORDER BY id').all(), before);
  assert.equal(hash(), checksum); assert.equal(statSync(file).mtimeMs, mtime);
});

test('missing selections report every offending scene and write nothing', t => {
  const { db, scenes, takes } = fixture(t);
  createSelection(db, { sceneId: scenes[1].id, takeId: takes[1][0].id, in: 1, out: 3 });
  const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.throws(() => buildTimelineFromSelectedTakes(db, 'p'), error => {
    assert.ok(error instanceof NoSelectedTakeError);
    assert.deepEqual(error.sceneIds, [scenes[0].id, scenes[2].id]); return true;
  });
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timeline').get()!.n, 0);
});

test('invalid in/out is typed and does not create any timeline rows', t => {
  const { db, scenes, takes } = fixture(t);
  scenes.forEach((scene, i) => createSelection(db, { sceneId: scene.id, takeId: takes[i][0].id, in: 0, out: 8 }));
  for (const [start, end] of [[-1, 3], [3, 3], [4, 3], [0, 9]]) {
    db.prepare('UPDATE selections SET "in"=?,"out"=? WHERE scene_id=?').run(start, end, scenes[1].id);
    assert.throws(() => buildTimelineFromSelectedTakes(db, 'p'), error => {
      assert.ok(error instanceof InvalidTimelineSelectionError); assert.deepEqual(error.sceneIds, [scenes[1].id]); return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timeline').get()!.n, 0);
  }
});

test('M6 review resolver uses owner fields over AI and legacy selections', t => {
  const { db, scenes, takes } = fixture(t);
  const plan = buildRenderPlan(db, 'p'); initializeRenderReviews(db);
  for (const scene of scenes) {
    const i = scenes.indexOf(scene), step = plan.steps.find(s => s.sceneId === scene.id)!;
    createSelection(db, { sceneId: scene.id, takeId: takes[i][0].id, in: 0, out: 8 });
    db.prepare('INSERT INTO render_reviews(step_id,scene_id,suggestion) VALUES (?,?,?)').run(step.id, scene.id,
      JSON.stringify({ takeId: takes[i][0].id, inPoint: 1, outPoint: 7, reason: 'AI' }));
    setOwnerOverride(db, step.id, { takeId: takes[i][1].id, outPoint: 6 });
  }
  const before = db.prepare('SELECT * FROM render_reviews ORDER BY step_id').all();
  const timeline = buildTimelineFromSelectedTakes(db, 'p');
  assert.deepEqual(timeline.tracks[0].clips.map(c => [c.takeId, c.inPoint, c.outPoint]), takes.map(ts => [ts[1].id, 1, 6]));
  assert.deepEqual(db.prepare('SELECT * FROM render_reviews ORDER BY step_id').all(), before);
});

test('a write failure rolls back the entire snapshot', t => {
  const { db, scenes, takes } = fixture(t);
  scenes.forEach((s, i) => createSelection(db, { sceneId: s.id, takeId: takes[i][0].id, out: 8 }));
  db.exec("CREATE TRIGGER reject_clip BEFORE INSERT ON timeline_clip BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => buildTimelineFromSelectedTakes(db, 'p'), /injected failure/);
  for (const table of ['timeline', 'timeline_track', 'timeline_clip', 'timeline_subtitle'])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
});
