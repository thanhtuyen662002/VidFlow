import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMotionCommand } from '../src/motion/cli.ts';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createCoreService } from '../src/service/index.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { detectFfmpeg, makeTestVideo } from './helpers/media.ts';

test('motion CLI forwards import, segment and status through the core service', async () => {
  const calls: unknown[] = [], output: string[] = [];
  const service = { listCommands: () => [], async execute(name: string, input: unknown) { calls.push({ name, input }); return { ok: true as const, data: { id: 'video' } }; } };
  const io = { stdout: { write: (s: string) => { output.push(s); return true; } }, stderr: { write: () => true } };
  assert.equal(await runMotionCommand(['import', 'project', 'video.mp4', '--rights-confirmed'], io, service), 0);
  assert.equal(await runMotionCommand(['segment', 'video'], io, service), 0);
  assert.equal(await runMotionCommand(['status', 'video'], io, service), 0);
  assert.deepEqual(calls, [
    { name: 'motion.import', input: { projectId: 'project', filePath: 'video.mp4', rights_confirmed: true } },
    { name: 'motion.segment', input: { sourceVideoId: 'video' } },
    { name: 'motion.status', input: { sourceVideoId: 'video' } },
  ]);
  assert.equal(output.length, 3);
});

test('motion CLI import, segment and status execute the real M10 core offline', { skip: !detectFfmpeg().available && 'ffmpeg/ffprobe unavailable' }, async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'CLI motion', '16:9', null);
  await makeTestVideo(project.directory);
  const service = createCoreService({ db, llm: new MockLlm(), flowDriver: { async run() { throw new Error('No render expected'); } } });
  const output: string[] = [], errors: string[] = [];
  const io = { stdout: { write(s: string) { output.push(s); } }, stderr: { write(s: string) { errors.push(s); } } };
  assert.equal(await runMotionCommand(['import', project.id, 'test-video.mp4'], io, service), 1);
  assert.equal(output.length, 0);
  assert.equal(await runMotionCommand(['import', project.id, 'test-video.mp4', '--rights-confirmed'], io, service), 0);
  const video = JSON.parse(output.at(-1)!); assert.equal(video.rights_confirmed, 1);
  assert.equal(await runMotionCommand(['segment', video.id], io, service), 0);
  const segments = JSON.parse(output.at(-1)!); assert.ok(segments.length > 0);
  assert.equal(await runMotionCommand(['status', video.id], io, service), 0);
  const status = JSON.parse(output.at(-1)!);
  assert.equal(status.source.id, video.id);
  assert.deepEqual(status.segments.map((s: { id: string }) => s.id), segments.map((s: { id: string }) => s.id));
  assert.equal(errors.length, 1);
});
