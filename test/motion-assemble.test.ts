import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { enqueueJob } from '../src/flow/queue.ts';
import { setOwnerCutPoints, listSegments } from '../src/motion/source-import.ts';
import { getMotionState, selectVariant } from '../src/motion/render.ts';
import { syncMotionPresets, loadStylePresets } from '../src/motion/preset-config.ts';
import { reviewMotion, assembleMotion, parseMotionReview } from '../src/motion/assemble.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { detectFfmpeg } from './helpers/media.ts';
import { runFfmpeg } from '../src/media/runner.ts';
import { probe } from '../src/media/probe.ts';
import { stretchVideo, muxSourceAudio } from '../src/edit/export.ts';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Assemble motion', '16:9', null), root = project.directory;
  db.prepare(`INSERT INTO source_videos(id,project_id,original_path,stored_path,sha256,size_bytes,duration_sec,fps,width,height,
    has_audio,rights_confirmed,rights_confirmed_at,scene_threshold,max_segment_sec,min_scene_sec,created_at)
    VALUES ('video',?,'assets/source.mp4','assets/source.mp4','hash',1,3,25,160,120,1,1,'now',0.3,1,0.1,'now')`).run(project.id);
  const segments = setOwnerCutPoints(db, 'video', [1,2]);
  syncMotionPresets(db, loadStylePresets());
  db.prepare(`INSERT INTO motion_style_approvals VALUES ('video','cartoon_faceless','hash','hash','{}',0,'pending',NULL,NULL,'now')`).run();
  let renders = 0;
  for (const segment of segments) {
    const job = enqueueJob(db, { sourceVideoId:'video', sceneId:segment.scene_index, segmentOrder:segment.idx }, { projectId: project.id }); renders++;
    const variants = [0,1].map(i => ({ id: `${segment.idx}-${i}`, file: join(root, 'renders', `take-${i}.mp4`), aiGenerated: true }));
    db.prepare(`UPDATE render_jobs SET status='done',source_segment_id=?,motion_state=? WHERE id=?`).run(segment.id,
      JSON.stringify({ status:'done', steps:{}, operations:[], variants, selectedVariantId:variants[0].id, generation:0 }), job.id);
  }
  const llm = new MockLlm([request => JSON.stringify({ score: JSON.parse(request.prompt).candidate.id.endsWith('-0') ? 99 : 70,
    face_detected: JSON.parse(request.prompt).candidate.id.endsWith('-0') })]);
  const media = { frame: async () => 'frame.png', comparison: async () => 'comparison.png',
    crop: async () => 'unused', clip: async () => 'unused' };
  return { db, root, segments, llm, media, renderCount: () => renders };
}

test('no-face review excludes the highest score, persists results and skips repeated LLM work', async t => {
  const f = fixture(t);
  await reviewMotion(f.db, 'video', f);
  for (const s of f.segments) assert.equal(getMotionState(f.db,s.id)!.selectedVariantId, `${s.idx}-1`);
  assert.equal(f.llm.calls, 6);
  await reviewMotion(f.db, 'video', f); assert.equal(f.llm.calls, 6);
});

test('owner choice is saved even when it matches the automatic default and overrides the review', async t => {
  const f = fixture(t), segment = f.segments[0];
  selectVariant(f.db, segment.id, '0-0');
  await reviewMotion(f.db, 'video', f);
  assert.equal(getMotionState(f.db,segment.id)!.ownerVariantId, '0-0');
  assert.equal(getMotionState(f.db,segment.id)!.selectedVariantId, '0-0');
});

test('strict JSON rejects malformed scores and face flags; no valid candidate requests owner review', async t => {
  for (const text of ['{}','null','{"score":101,"face_detected":false}', '{"score":1,"face_detected":"false"}',
    '{"score":1,"face_detected":false,"extra":1}', '```json\n{}\n```']) assert.throws(() => parseMotionReview(text));
  const f = fixture(t);
  await assert.rejects(reviewMotion(f.db, 'video', { ...f, llm: new MockLlm(['{}']) }), /owner review/);
  assert.equal(getMotionState(f.db,f.segments[0].id)!.status,'needs_rerender');
  assert.equal(getMotionState(f.db,f.segments[0].id)!.selectedVariantId,undefined);
  selectVariant(f.db,f.segments[0].id,'0-1');
  await reviewMotion(f.db,'video',f);
  assert.equal(getMotionState(f.db,f.segments[0].id)!.selectedVariantId,'0-1');
});

test('all face-flagged candidates require owner review instead of silently selecting a face', async t => {
  const f = fixture(t);
  await assert.rejects(reviewMotion(f.db,'video',{ ...f,
    llm:new MockLlm(['{"score":100,"human_face":true}']) }), /face policy/);
  assert.equal(getMotionState(f.db,f.segments[0].id)!.selectedVariantId,undefined);
});

const tools = detectFfmpeg();
test('M7 retiming, original audio onsets, final duration and interrupted assembly resume', {
  skip: !tools.available && `ffmpeg/ffprobe not found on PATH – skipping M10.6 media test: ${tools.reason}`,
}, async t => {
  const f = fixture(t);
  await mkdir(join(f.root,'renders'), { recursive:true });
  await runFfmpeg(['-f','lavfi','-i','testsrc=size=160x120:rate=25:duration=3',
    '-f','lavfi','-i',"aevalsrc='if(lt(mod(t,1),0.1),0.6*sin(2*PI*1000*t),0)':s=48000:d=3",
    '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',join(f.root,'assets/source.mp4')], { timeoutMs:30000 });
  for (const i of [0,1]) await runFfmpeg(['-f','lavfi','-i',`testsrc=size=160x120:rate=25:duration=${i ? 0.6 : 1.4}`,
    '-c:v','libx264','-pix_fmt','yuv420p',join(f.root,'renders',`take-${i}.mp4`)], { timeoutMs:30000 });
  const original = await readFile(join(f.root,'assets/source.mp4'));
  // A completed stretch is committed before this injected process failure.
  await assert.rejects(assembleMotion(f.db,'video', { ...f, keepOriginalAudio:true,
    afterStretch: () => { throw new Error('interrupted'); } }), /interrupted/);
  const completed = getMotionState(f.db,f.segments[0].id)!.assembly!.stretched!;
  const before = (await stat(completed)).mtimeMs, renderCount = f.renderCount();
  const result = await assembleMotion(f.db,'video',{ ...f,keepOriginalAudio:true });
  assert.equal((await stat(completed)).mtimeMs,before);
  assert.equal(f.renderCount(),renderCount);
  assert.ok(Math.abs((await probe(result.path)).durationSec-3)<=1/25);
  assert.deepEqual(await readFile(join(f.root,'assets/source.mp4')),original);
  assert.equal(JSON.parse(await readFile(result.disclosurePath,'utf8')).madeWithAI,true);
  const pcm = join(f.root,'exports/decoded.pcm');
  await runFfmpeg(['-i',result.path,'-vn','-ac','1','-ar','48000','-f','s16le',pcm],{ timeoutMs:30000 });
  const bytes = await readFile(pcm);
  for (const start of [0,1,2]) {
    let onset = -1;
    for (let n = Math.max(0,Math.floor((start-0.05)*48000)); n < (start+0.15)*48000 && n*2+1 < bytes.length; n++) {
      if (Math.abs(bytes.readInt16LE(n*2)) > 3000) { onset=n/48000; break; }
    }
    assert.ok(onset>=0 && Math.abs(onset-start)<=0.04, `beep at ${start}: ${onset}`);
  }
  assert.equal((await assembleMotion(f.db,'video',{ ...f,keepOriginalAudio:true })).path,result.path);
  const stretched = await stretchVideo(f.root,join(f.root,'renders/take-0.mp4'),25,25);
  assert.ok(Math.abs((await probe(stretched)).durationSec-1)<1/25);
  const silent = await muxSourceAudio(f.root,stretched,join(f.root,'assets/source.mp4'),false,1);
  assert.equal((await probe(silent)).hasAudio,false);
  const missing = await muxSourceAudio(f.root,stretched,stretched,true,1);
  assert.equal((await probe(missing)).hasAudio,false);
});
