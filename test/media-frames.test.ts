import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFrame, probe, runFfmpeg } from '../src/media/index.ts';
import { detectFfmpeg, mediaHome } from './helpers/media.ts';

test('media input validation requires no binaries', async t => {
  const home = mediaHome(t);
  const project = join(home, 'projects', 'project with spaces');
  mkdirSync(project, { recursive: true });
  await assert.rejects(probe(join(project, 'missing.mp4')), { code: 'MEDIA_FILE_MISSING' });
  await assert.rejects(extractFrame(project, 'missing.mp4', -1), { code: 'MEDIA_INVALID_TIME' });
  await assert.rejects(extractFrame(project, join(project, 'missing.mp4'), 0, { fileName: '../escape.png' }), { code: 'UNSAFE_PATH' });
  await assert.rejects(extractFrame(project, join(project, 'missing.mp4'), 0, { fileName: '..\\escape.png' }), { code: 'UNSAFE_PATH' });
});

test('probe and extract 2.5 s: 320x240 PNG in frames, source sha256 unchanged (paths with spaces)', async t => {
  const home = mediaHome(t);
  const project = join(home, 'projects', 'project with spaces');
  mkdirSync(project, { recursive: true });
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  const silent = join(project, 'silent video.mp4');
  const audio = join(project, 'audio video.mp4');
  await runFfmpeg(['-n', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
    '-t', '5', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', silent], { timeoutMs: 30000 });
  await runFfmpeg(['-n', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-t', '5',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', audio], { timeoutMs: 30000 });
  for (const [file, hasAudio] of [[silent, false], [audio, true]] as const) {
    const info = await probe(file);
    assert.ok(Math.abs(info.durationSec - 5) < 0.1);
    assert.equal(info.width, 320);
    assert.equal(info.height, 240);
    assert.equal(info.fps, 25);
    assert.equal(info.hasAudio, hasAudio);
  }
  const hash = () => createHash('sha256').update(readFileSync(silent)).digest('hex');
  const before = hash();
  const frame = await extractFrame(project, silent, 2.5);
  assert.equal(dirname(frame.path), join(project, 'frames'));
  assert.equal(frame.path, join(project, 'frames', 'silent_video_t002500.png'));
  assert.ok(statSync(frame.path).size > 0);
  const image = await probe(frame.path);
  assert.deepEqual([image.width, image.height], [320, 240]);
  assert.deepEqual([frame.width, frame.height, frame.timeSec], [320, 240, 2.5]);
  assert.equal(hash(), before);
  await assert.rejects(extractFrame(project, silent, 5), { code: 'MEDIA_INVALID_TIME' });
  await assert.rejects(extractFrame(project, silent, 6), { code: 'MEDIA_INVALID_TIME' });
  await assert.rejects(extractFrame(project, silent, NaN), { code: 'MEDIA_INVALID_TIME' });
  await assert.rejects(extractFrame(project, silent, 2.5), { code: 'UNSAFE_PATH' });
  const custom = await extractFrame(project, silent, 0, { fileName: 'custom.png' });
  assert.equal(custom.path, join(project, 'frames', 'custom.png'));
  const wav = join(project, 'audio only.wav');
  await runFfmpeg(['-n', '-f', 'lavfi', '-i', 'sine=duration=1', wav], { timeoutMs: 15000 });
  await assert.rejects(probe(wav), { code: 'MEDIA_NO_VIDEO' });
});
