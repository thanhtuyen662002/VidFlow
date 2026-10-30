import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { buildPublishPackage, markReadyToPublish, validatePackage } from '../src/edit/package.ts';
import type { MusicLicense } from '../src/edit/package.ts';
import type { Timeline } from '../src/edit/timeline.ts';
import { run } from '../src/cli.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createRenderJob, createTake, createSelection } from '../src/repo/renders.ts';
import { detectFfmpeg, makeTestVideo, makeTestAudio } from './helpers/media.ts';

const response = JSON.stringify({ title: 'Khu vườn', description: 'Một câu chuyện.', hashtags: ['#vuon'] });

for (const status of ['licensed', 'unlicensed', 'unknown'] as const) {
  test(`M7.5 music ${status}: ready gate and persisted state`, async t => {
    const db = temporaryDatabase(t); migrate(db);
    const project = createProject(db, 'Xuất bản', '16:9', null);
    const video = join(project.directory, 'exports', 'video.mp4');
    const cover = join(project.directory, 'frames', 'cover.png');
    await writeFile(video, 'video fixture'); await writeFile(cover, 'cover fixture');
    const timeline: Timeline = { id: 't', projectId: project.id, revision: 1, createdAt: '', status: 'draft', tracks: [] };
    const license: MusicLicense = { trackId: 'music1', title: 'Nhạc một', source: 'Thư viện', licenseType: 'CC0', proof: 'https://example.org/license', status };
    const pkg = await buildPublishPackage({ project, timeline, videos: [{ aspect: '16:9', path: video }],
      licenses: [license], llm: new MockLlm([response]), llmModel: 'MockLlm', coverPath: cover,
      ...{ aiDisclosure: false } });
    if (status === 'licensed') assert.equal((await markReadyToPublish(project.directory, pkg.directory)).state, 'ready_to_publish');
    else {
      await assert.rejects(markReadyToPublish(project.directory, pkg.directory), /Nhạc một.*music1/);
      assert.equal((await validatePackage(project.directory, pkg.directory)).state, 'draft');
    }
    const disclosure = JSON.parse(await readFile(join(pkg.directory, 'ai-disclosure.json'), 'utf8'));
    assert.equal(disclosure.madeWithAI, true);
    assert.match(disclosure.statement, /Google Flow\/Veo.*MockLlm/);
    assert.ok((await readFile(join(pkg.directory, 'description.md'), 'utf8')).includes(disclosure.statement));
    await unlink(join(pkg.directory, 'ai-disclosure.json'));
    await assert.rejects(validatePackage(project.directory, pkg.directory));
    await assert.rejects(markReadyToPublish(project.directory, pkg.directory));
  });
}

test('M7.5 publish package has no network or upload client', async () => {
  const source = await readFile(new URL('../src/edit/package.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|axios|youtube|tiktok|facebook|\bupload\s*\(/i);
});

test('M7.5 omitted music becomes unknown; empty disclosure and changed files fail validation', async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Unknown audio', '16:9', null);
  const video = join(project.directory, 'exports', 'video.mp4'), cover = join(project.directory, 'frames', 'cover.png');
  await writeFile(video, 'video'); await writeFile(cover, 'cover');
  const timeline: Timeline = { id: 't', projectId: project.id, revision: 1, createdAt: '', status: 'draft', tracks: [{
    id: 'm', timelineId: 't', kind: 'music', order: 0, muted: false, subtitles: [], clips: [{
      id: 'unlisted-sfx', trackId: 'm', sceneId: null, takeId: null, sourceAssetId: null,
      sourcePath: video, inPoint: 0, outPoint: 1, timelineStart: 0, duration: 1, order: 0,
    }],
  }] };
  const pkg = await buildPublishPackage({ project, timeline, videos: [{ aspect: '16:9', path: video }], licenses: [],
    llm: new MockLlm([response]), llmModel: 'MockLlm', coverPath: cover });
  await assert.rejects(markReadyToPublish(project.directory, pkg.directory), /unlisted-sfx/);
  const disclosure = join(pkg.directory, 'ai-disclosure.json'), original = await readFile(disclosure);
  await writeFile(disclosure, '');
  await assert.rejects(validatePackage(project.directory, pkg.directory), /khai báo/);
  await writeFile(disclosure, original);
  await writeFile(join(pkg.directory, 'video-16x9.mp4'), 'changed');
  await assert.rejects(validatePackage(project.directory, pkg.directory), /toàn vẹn/);
});

test('M7.5 CLI help and errors', async () => {
  for (const command of ['timeline', 'export', 'package']) {
    let output = '';
    const io = { stdout: { write: (s: string) => { output += s; } }, stderr: { write: (s: string) => { output += s; } } };
    assert.equal(await run([command, '--help'], io), 0);
    assert.match(output, /Cách dùng/);
    assert.notEqual(await run([command], io), 0);
  }
});

const media = detectFfmpeg();
test('M7.5 CLI timeline -> export -> package with fake LLM', { skip: !media.available && media.reason }, async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'CLI package', '16:9', null);
  const video = await makeTestVideo(project.directory);
  const audio = await makeTestAudio(project.directory);
  const scene = createScene(db, { projectId: project.id, dialogue: 'Xin chào' });
  const job = createRenderJob(db, { projectId: project.id, sceneId: scene.id });
  const take = createTake(db, { sceneId: scene.id, renderJobId: job.id, file: video, durationSec: 1 });
  createSelection(db, { sceneId: scene.id, takeId: take.id, in: 0, out: 1 });
  const oldLlm = process.env.VIDFLOW_LLM, oldResponses = process.env.VIDFLOW_LLM_RESPONSES;
  process.env.VIDFLOW_LLM = 'fake'; process.env.VIDFLOW_LLM_RESPONSES = JSON.stringify([response]);
  t.after(() => {
    if (oldLlm === undefined) delete process.env.VIDFLOW_LLM; else process.env.VIDFLOW_LLM = oldLlm;
    if (oldResponses === undefined) delete process.env.VIDFLOW_LLM_RESPONSES; else process.env.VIDFLOW_LLM_RESPONSES = oldResponses;
  });
  const invoke = async (args: string[]) => {
    let stdout = '', stderr = '';
    const code = await run(args, { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } });
    assert.equal(code, 0, stderr); return JSON.parse(stdout);
  };
  const built = await invoke(['timeline', project.id]);
  assert.ok(await readFile(built.path));
  const exported = await invoke(['export', project.id, '--timeline', built.timeline.id, '--audio', relative(project.directory, audio), '--aspect', '16:9,9:16']);
  const pkg = await invoke(['package', project.id, '--timeline', built.timeline.id, '--result', relative(project.directory, exported.path), '--ready']);
  const manifest = await validatePackage(project.directory, pkg.directory);
  assert.equal(manifest.state, 'ready_to_publish');
  assert.equal(manifest.files.filter(f => f.role === 'video').length, 2);
  assert.ok(manifest.files.some(f => f.path === 'cover.png'));
  assert.ok(manifest.files.some(f => f.path === 'subtitles.srt'));
});
