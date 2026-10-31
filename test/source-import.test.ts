import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { detectFfmpeg } from './helpers/media.ts';
import { openDatabase } from '../src/db.ts';
import { createProject } from '../src/repo/projects.ts';
import { runFfmpeg } from '../src/media/runner.ts';
import { MediaToolExitError } from '../src/media/errors.ts';
import { importSourceVideo, listSegments, segmentSourceVideo, setOwnerCutPoints, RightsNotConfirmedError } from '../src/motion/source-import.ts';

const tools = detectFfmpeg();
function database(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(),'vidflow-source-'));
  const previous = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = home;
  const db = openDatabase();
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.VIDFLOW_HOME;
    else process.env.VIDFLOW_HOME = previous;
    rmSync(home,{ recursive: true,force: true });
  });
  return db;
}
test('rights rejection has no database or filesystem side effects', async t => {
  const db = database(t);
  const project = createProject(db,'Rights','16:9',null);
  for (const rightsConfirmed of [false, undefined]) {
    await assert.rejects(importSourceVideo(db,{ projectId: project.id,filePath: 'missing.mp4',rightsConfirmed }),RightsNotConfirmedError);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM source_videos').get()!.n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM source_segments').get()!.n,0);
  assert.equal(existsSync(join(project.directory,'sources')),false);
});

test('source scene detection, bounded partition, immutable copy and persistent owner cuts', { skip: tools.available ? false : tools.reason }, async t => {
  // M3 resolves VIDFLOW_FFMPEG before PATH and supplies -hide_banner.
  const filters = await runFfmpeg(['-filters'],{ timeoutMs: 15000 });
  if (!/\bdrawtext\b/.test(filters.stdout + '\n' + filters.stderrTail)) {
    t.skip('ffmpeg drawtext filter unavailable (no libfreetype/fontconfig); M10.2 scene-cut criterion requires color-with-text scene');
    return;
  }
  const db = database(t);
  const project = createProject(db,'Source','16:9',null);
  const file = join(project.directory,'sample.mp4');
  // Fixed text and position keep the middle scene static.
  const args = ['-n','-f','lavfi','-i','testsrc=size=160x120:rate=25:duration=10',
    '-f','lavfi','-i','color=c=blue:size=160x120:rate=25:duration=10',
    '-f','lavfi','-i','mandelbrot=size=160x120:rate=25',
    '-f','lavfi','-i','sine=frequency=440:duration=30',
    '-filter_complex','[0:v]format=yuv420p[a];[1:v]drawtext=text=Scene2:fontcolor=white:fontsize=24:x=(w-tw)/2:y=(h-th)/2,format=yuv420p[b];[2:v]trim=duration=10,setpts=PTS-STARTPTS,format=yuv420p[c];[a][b][c]concat=n=3:v=1:a=0[v]',
    '-map','[v]','-map','3:a','-t','30','-c:v','mpeg4','-q:v','2','-c:a','aac',file];
  try {
    await runFfmpeg(args,{ timeoutMs: 120000 });
  } catch (error) {
    if (error instanceof MediaToolExitError && /fontconfig|cannot find a valid font|could not (?:load|set) font|could not load face|failed to (?:load|open).*font|no font filename provided/i.test(error.stderrTail)) {
      t.skip('ffmpeg drawtext font rendering unavailable; M10.2 scene-cut criterion requires color-with-text scene');
      return;
    }
    throw error;
  }
  const video = await importSourceVideo(db,{ projectId: project.id,filePath: 'sample.mp4',rightsConfirmed: true,maxSegmentSec: 40,sceneThreshold: 0.3 });
  assert.equal(video.has_audio,1);
  assert.ok(existsSync(join(project.directory,video.audio_path!)));
  const initial = listSegments(db,video.id);
  assert.equal(initial.length,3);
  assert.ok(Math.abs(initial[1].start_sec-10) <= 0.2);
  assert.ok(Math.abs(initial[2].start_sec-20) <= 0.2);
  const stored = join(project.directory,video.stored_path);
  const signature = () => ({ mtime: statSync(stored).mtimeMs,size: statSync(stored).size,
    sha256: createHash('sha256').update(readFileSync(stored)).digest('hex') });
  const before = signature();
  const again = await importSourceVideo(db,{ projectId: project.id,filePath: 'sample.mp4',rightsConfirmed: true });
  assert.equal(again.id,video.id);
  const parts = await segmentSourceVideo(db,video.id,{ maxSegmentSec: 4 });
  let duration = 0;
  parts.forEach((part,index) => {
    assert.ok(part.end_sec-part.start_sec <= 4+1e-9);
    if (index) assert.equal(part.start_frame,parts[index-1].end_frame);
    duration += part.end_sec-part.start_sec;
  });
  assert.ok(Math.abs(duration-video.duration_sec) <= 1/video.fps);
  assert.deepEqual(signature(),before);
  assert.equal(readdirSync(join(project.directory,'sources')).length,1);
  setOwnerCutPoints(db,video.id,[23,7.01,7.01]);
  const owned = await segmentSourceVideo(db,video.id,{ maxSegmentSec: 40,sceneThreshold: 1 });
  assert.deepEqual(owned.map(row => row.start_frame),[0,175,575]);
  assert.ok(owned.every(row => row.origin === 'owner'));
  const snapshot = listSegments(db,video.id);
  assert.throws(() => setOwnerCutPoints(db,video.id,[NaN]));
  assert.deepEqual(listSegments(db,video.id),snapshot);
  setOwnerCutPoints(db,video.id,[]);
  assert.equal((await segmentSourceVideo(db,video.id)).length,1);
  assert.deepEqual(signature(),before);
  db.prepare('DELETE FROM source_videos WHERE id=?').run(video.id);
  assert.equal(listSegments(db,video.id).length,0);
});

test('source core import graph contains no Electron dependency', () => {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file,'utf8');
    for (const match of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(!match[1].includes('electron'),file);
      if (match[1].startsWith('.')) visit(resolve(dirname(file),match[1]));
    }
  }
  visit(resolve('src/motion/source-import.ts'));
});

test('frame partitions and owner edits are atomic without requiring media tools', async t => {
  const db = database(t);
  const project = createProject(db,'Frame partitions','16:9',null);
  db.prepare(`INSERT INTO source_videos
    (id,project_id,original_path,stored_path,sha256,size_bytes,duration_sec,fps,width,height,
     has_audio,rights_confirmed,rights_confirmed_at,scene_threshold,max_segment_sec,min_scene_sec,created_at)
    VALUES ('source',?,'input.mp4','sources/source.video','hash',1,30,25,160,120,0,1,'now',0.3,4,0.5,'now')`).run(project.id);
  const rows = setOwnerCutPoints(db,'source',[20,10,10]);
  assert.equal(rows.length,9);
  assert.equal(rows.reduce((sum,row) => sum+row.frame_count,0),750);
  for (let i = 0; i < rows.length; i++) {
    assert.ok(rows[i].frame_count <= 100);
    assert.equal(rows[i].start_frame,i ? rows[i-1].end_frame : 0);
  }
  assert.deepEqual(rows.filter(row => row.origin === 'owner').map(row => row.start_sec),[0,10,20]);
  const again = await segmentSourceVideo(db,'source',{ maxSegmentSec: 4.03 });
  assert.equal(again.reduce((sum,row) => sum+row.frame_count,0),750);
  assert.ok(again.every(row => row.end_sec-row.start_sec <= 4.03));
  for (const invalid of [[0],[30],[-1],[Infinity],[NaN]]) {
    assert.throws(() => setOwnerCutPoints(db,'source',invalid));
    assert.deepEqual(listSegments(db,'source'),again);
  }
  db.exec(`CREATE TRIGGER fail_segment BEFORE INSERT ON source_segments
    BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
  assert.throws(() => setOwnerCutPoints(db,'source',[5]));
  assert.deepEqual(listSegments(db,'source'),again);
  assert.equal(db.prepare("SELECT owner_cuts FROM source_videos WHERE id='source'").get()!.owner_cuts,'[10,20]');
  db.exec('DROP TRIGGER fail_segment');
  setOwnerCutPoints(db,'source',[]);
  const emptyOwner = await segmentSourceVideo(db,'source',{ maxSegmentSec: 40 });
  assert.equal(emptyOwner.length,1);
  assert.equal(emptyOwner[0].origin,'owner');
});
