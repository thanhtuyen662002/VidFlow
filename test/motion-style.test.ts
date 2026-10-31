import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { setOwnerCutPoints } from '../src/motion/source-import.ts';
import { analyzeSubjects, setMapping } from '../src/motion/subjects.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { compileMotionPrompts, estimateMotionCredits } from '../src/motion/style-compiler.ts';
import type { AnalyzedMotionSegment } from '../src/motion/style-compiler.ts';
import type { MotionMapping } from '../src/motion/subjects.ts';
import type { CompilerBible } from '../src/prompt/compiler.ts';
import { loadStylePresets } from '../src/motion/preset-config.ts';
import { MotionStyleService } from '../src/motion/style-service.ts';

// Small fixed input, independent of generated UUIDs/timestamps.
const analysis = [0,1].map(idx => ({ segment: { id: `s${idx}`, idx, start_sec: idx*2, end_sec: idx*2+2 },
  analysis: { subjects: [], motion: 'Stir', rhythm: 'Steady', composition: 'Overhead' },
  subjects: [{ id: `p${idx}`, subject_key: 'cook', description: 'Show a face', motion_description: 'Stir', composition: 'Center' }]
})) as AnalyzedMotionSegment[];
const mapping = [0,1].map(idx => ({ subject_id: `p${idx}`, target_type: 'character', target_ref: '@Lan' })) as MotionMapping[];
const bible: CompilerBible = { style: 'Bible', lighting: '', palette: '', lens: '', safe_area: 'Safe', avoid: 'No text',
  entries: [{ id: 'lan', name: 'Lan', kind: 'character', description: 'Animated cook', images: ['refs/z.png','refs/a.png'], priority: 1 }] as CompilerBible['entries'] };

test('pure motion snapshot, shuffled arrays, faceless, disclosure, no mutation, no clock or random', t => {
  const preset = loadStylePresets().presets[0];
  const before = JSON.stringify({ analysis,mapping,bible,preset });
  const first = compileMotionPrompts(analysis,mapping,preset,bible);
  assert.deepEqual(first,compileMotionPrompts(analysis,mapping,preset,bible));
  t.mock.method(Math,'random',() => { throw new Error('Random called'); });
  t.mock.method(globalThis,'Date',class { constructor() { throw new Error('Date called'); } } as unknown as DateConstructor);
  assert.deepEqual(first,compileMotionPrompts([...analysis].reverse(),[...mapping].reverse(),preset,bible));
  assert.deepEqual(first,JSON.parse(readFileSync(new URL('./fixtures/compiler/motion-style.json',import.meta.url),'utf8')));
  for (const row of first) { assert.match(row.prompt,/No face visible/); assert.match(row.prompt,/This content is AI-generated/); }
  assert.equal(JSON.stringify({ analysis,mapping,bible,preset }),before);
  // The non-configurable safety clauses survive edited configuration.
  for (const row of compileMotionPrompts(analysis,mapping,{ ...preset,required: [],disclosure: 'Other' },bible)) {
    assert.match(row.prompt,/No face visible/); assert.match(row.prompt,/This content is AI-generated/);
  }
});

test('config reload changes prompts and invalid configs report schema errors', t => {
  temporaryDatabase(t);
  const path = join(process.env.VIDFLOW_HOME!,'presets.json');
  const config = loadStylePresets();
  writeFileSync(path,JSON.stringify(config));
  const a = compileMotionPrompts(analysis,mapping,loadStylePresets(path).presets[0],bible);
  config.presets[0].style = 'New watercolor style';
  writeFileSync(path,JSON.stringify(config));
  assert.notDeepEqual(a,compileMotionPrompts(analysis,mapping,loadStylePresets(path).presets[0],bible));
  writeFileSync(path,'{}'); assert.throws(() => loadStylePresets(path),/Invalid motion preset config/);
});

test('reference roles and IDs determine order across shuffled subjects, mappings and registry', () => {
  const preset = loadStylePresets().presets[0];
  const input = structuredClone(analysis);
  input[0].subjects.push({ ...input[0].subjects[0], id: 'other', subject_key: 'background' });
  const maps = [...mapping,{ ...mapping[0], subject_id: 'other',target_ref: '@Room' }];
  const registry = { ...bible, entries: [...bible.entries,{ ...bible.entries[0],id: 'room',name: 'Room',kind: 'location' as const,description: 'Kitchen' }] };
  const result = compileMotionPrompts(input,maps,preset,registry);
  input.reverse().forEach(s => s.subjects.reverse());
  assert.deepEqual(result,compileMotionPrompts(input,maps.reverse(),preset,{ ...registry, entries: [...registry.entries].reverse() }));
  assert.deepEqual(result[0].references.map(r => r.id),['lan','room']);
});

test('credit sum uses configured K, duration rounding, and rejects invalid prices', () => {
  const segments = [{ start_sec: 0,end_sec: 1.5 },{ start_sec: 2,end_sec: 6 },{ start_sec: 8,end_sec: 8.1 }] as AnalyzedMotionSegment['segment'][];
  assert.equal(estimateMotionCredits(segments,{ variants: 3,creditsPerSecond: 2 }),(3+8+1)*3);
  assert.throws(() => estimateMotionCredits(segments,{ variants: 0,creditsPerSecond: 2 }));
});

test('pending estimate, owner approval, invalidation on config, analysis and mapping changes', async t => {
  const db = temporaryDatabase(t); migrate(db); migrate(db);
  const project = createProject(db,'Style','16:9',null);
  db.prepare(`INSERT INTO source_videos (id,project_id,original_path,stored_path,sha256,size_bytes,duration_sec,fps,width,height,has_audio,
    rights_confirmed,rights_confirmed_at,scene_threshold,max_segment_sec,min_scene_sec,created_at)
    VALUES ('video',?,'sample.mp4','sources/sample.mp4','hash',1,4,25,160,120,0,1,'now',0.3,8,0.5,'now')`).run(project.id);
  setOwnerCutPoints(db,'video',[]);
  const subjects = await analyzeSubjects(db,'video',{ llm: new MockLlm(), frameExtractor: async () => ({ path: 'stub.png',timeSec: 0,width: 160,height: 120 }) });
  const path = join(process.env.VIDFLOW_HOME!,'preset.json'), config = loadStylePresets();
  writeFileSync(path,JSON.stringify(config));
  const service = new MotionStyleService(db,{ configPath: path });
  assert.throws(() => service.approveStyle('video','owner'),/estimate required/);
  const preview = service.createStylePreview('video','cartoon_faceless');
  assert.equal(preview.status,'pending'); assert.equal(preview.credit_estimate,40);
  assert.equal(JSON.parse(preview.summary).creditEstimate,40);
  assert.throws(() => service.assertStyleApproved('video'));
  assert.equal(service.approveStyle('video','owner').approved_by,'owner'); service.assertStyleApproved('video');
  setMapping(db,subjects[0].id,'faceless'); assert.throws(() => service.assertStyleApproved('video'));
  assert.equal(service.getStyleApproval('video')!.credit_estimate,null);
  service.createStylePreview('video','cartoon_faceless'); service.approveStyle('video','owner');
  config.presets[0].style += ' Changed'; writeFileSync(path,JSON.stringify(config));
  assert.throws(() => service.approveStyle('video','owner'),/estimate required/);
  service.createStylePreview('video','cartoon_faceless'); service.approveStyle('video','owner');
  db.prepare("UPDATE source_segments SET motion_analysis=json_set(motion_analysis,'$.motion','changed')").run();
  assert.throws(() => service.assertStyleApproved('video'));
  service.createStylePreview('video','cartoon_faceless');
  db.prepare('UPDATE motion_style_approvals SET credit_estimate=NULL').run();
  assert.throws(() => service.approveStyle('video','owner'),/estimate required/);
});
