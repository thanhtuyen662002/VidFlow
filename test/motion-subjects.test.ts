import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createReference, deleteReference } from '../src/repo/references.ts';
import { setOwnerCutPoints } from '../src/motion/source-import.ts';
import { analyzeSubjects, setMapping, validateMappings, getEffectiveMapping, UnknownReferenceError, FaceConsentRequiredError } from '../src/motion/subjects.ts';
import { MockLlm, SAMPLE_MOTION } from '../src/script/llm/mock.ts';
import { compileMotionSegment } from '../src/motion/compiler.ts';
import { BibleService } from '../src/prompt/bible.ts';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db,'Motion','16:9',null);
  db.prepare(`INSERT INTO source_videos (id,project_id,original_path,stored_path,sha256,size_bytes,duration_sec,fps,width,height,has_audio,
    rights_confirmed,rights_confirmed_at,scene_threshold,max_segment_sec,min_scene_sec,created_at)
    VALUES ('video',?,'sample.mp4','sources/sample.mp4','hash',1,4,25,160,120,0,1,'now',0.3,8,0.5,'now')`).run(project.id);
  setOwnerCutPoints(db,'video',[]);
  const times: number[] = [];
  const frameExtractor = async (_project: string, _video: string, time: number) => {
    times.push(time); return { path: 'stub.png',timeSec: time,width: 160,height: 120 };
  };
  const llm = new MockLlm([JSON.stringify(SAMPLE_MOTION)]);
  return { db,project,llm,frameExtractor,times };
}
test('segmented sample analysis stores fixed subjects and AI mappings', async t => {
  const f = fixture(t);
  const rows = await analyzeSubjects(f.db,'video',f);
  assert.equal(rows.length,4);
  assert.deepEqual(f.times,[0,1.98,3.96]);
  for (const expected of SAMPLE_MOTION.subjects) {
    const row = rows.find(s => s.subject_key === expected.subject_key)!;
    assert.equal(row.kind,expected.kind); assert.equal(row.has_human_face,Number(expected.has_human_face));
    assert.equal(getEffectiveMapping(f.db,row.id)!.source,'ai');
  }
});
test('unknown reference rejects before mapping, LLM or jobs; preflight catches stale refs', async t => {
  const f = fixture(t);
  const [row] = await analyzeSubjects(f.db,'video',f);
  f.db.prepare('DELETE FROM motion_mappings WHERE subject_id=?').run(row.id);
  const before = f.db.prepare('SELECT count(*) n FROM render_jobs').get()!.n;
  const calls = f.llm.calls;
  assert.throws(() => setMapping(f.db,row.id,'@Lan'),UnknownReferenceError);
  assert.equal(getEffectiveMapping(f.db,row.id),undefined);
  const ref = createReference(f.db,{ project_id: f.project.id,name: 'Lan',role: 'character',images: ['refs/lan.png'],description: 'Lan',priority: 0 });
  assert.equal(setMapping(f.db,row.id,'@Lan').target_id,ref.id);
  deleteReference(f.db,ref.id);
  assert.throws(() => validateMappings(f.db,'video'), /@Lan chưa được đăng ký/);
  await assert.rejects(analyzeSubjects(f.db,'video',f),UnknownReferenceError);
  assert.equal(f.llm.calls,calls);
  assert.equal(f.db.prepare('SELECT count(*) n FROM render_jobs').get()!.n,before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM credit_ledger').get()!.n,0);
});
test('owner mapping survives changed AI analysis and remains effective', async t => {
  const f = fixture(t);
  const rows = await analyzeSubjects(f.db,'video',f);
  const row = rows.find(s => s.subject_key === 'person_1')!;
  const mapping = setMapping(f.db,row.id,'bỏ');
  const changed = structuredClone(SAMPLE_MOTION);
  changed.subjects[0].has_human_face = false;
  changed.subjects[0].description = 'Changed cook';
  await analyzeSubjects(f.db,'video',{ ...f,llm: new MockLlm([JSON.stringify(changed)]) });
  assert.deepEqual(getEffectiveMapping(f.db,row.id),mapping);
  assert.equal(JSON.parse(f.db.prepare('SELECT ai_suggestion FROM motion_subjects WHERE id=?').get(row.id)!.ai_suggestion as string).target,'keep');
});
test('face consent is required for keep, and checked again by preflight', async t => {
  const f = fixture(t);
  const rows = await analyzeSubjects(f.db,'video',f);
  const row = rows.find(s => s.has_human_face)!;
  assert.throws(() => setMapping(f.db,row.id,'giữ'),FaceConsentRequiredError);
  f.db.prepare('UPDATE source_videos SET face_consent=1').run();
  assert.equal(setMapping(f.db,row.id,'keep').target_type,'keep');
  validateMappings(f.db,'video');
  f.db.prepare('UPDATE source_videos SET face_consent=0').run();
  assert.throws(() => validateMappings(f.db,'video'),FaceConsentRequiredError);
});
test('invalid and duplicate outputs leave no partial segment rows', async t => {
  const f = fixture(t);
  for (const value of [{ subjects: [] },{ ...SAMPLE_MOTION,subjects: [SAMPLE_MOTION.subjects[0],SAMPLE_MOTION.subjects[0]] }]) {
    await assert.rejects(analyzeSubjects(f.db,'video',{ ...f,llm: new MockLlm([JSON.stringify(value)]) }));
    assert.equal(f.db.prepare('SELECT count(*) n FROM motion_subjects').get()!.n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM motion_mappings').get()!.n,0);
  }
});
test('motion compiler resolves registry and produces deterministic faceless instructions', async t => {
  const f = fixture(t);
  const rows = await analyzeSubjects(f.db,'video',{ ...f,llm: new MockLlm() });
  createReference(f.db,{ project_id: f.project.id,name: 'Lan',role: 'character',images: ['refs/lan.png'],description: 'Animated Lan',priority: 0 });
  setMapping(f.db,rows.find(s => s.subject_key === 'person_1')!.id,'@Lan');
  const bible = { style: 'Watercolor', lighting: '', palette: '', lens: '', safe_area: 'Safe area',avoid: 'Avoid text',entries: new BibleService(f.db).list(f.project.id) };
  const options = { preset: 'faceless-animation',maxReferenceImages: 3 };
  const result = compileMotionSegment(f.db,rows[0].segment_id,bible,options);
  assert.deepEqual(compileMotionSegment(f.db,rows[0].segment_id,bible,options),result);
  assert.match(result.prompt,/No visible human faces/);
  assert.match(result.prompt,/person_1: Animated Lan/);
  assert.match(result.prompt,/Preserve motion, rhythm, composition, camera angle and duration \(4s\)/);
  assert.equal(result.references[0].name,'Lan');
});
