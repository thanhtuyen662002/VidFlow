import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { concatSegments, probe, runFfmpeg, runFfprobe } from '../src/media/index.ts';
import { detectFfmpeg, mediaHome } from './helpers/media.ts';

test('concat rejects an empty list without ffmpeg', async t => {
  const home = mediaHome(t);
  await assert.rejects(concatSegments(join(home, 'project'), []), /không được rỗng/);
});

test('concat normalizes three cuts, preserves originals and avoids overwrites', async t => {
  const home = mediaHome(t);
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  const project = join(home, 'projects', 'concat');
  mkdirSync(project, { recursive: true });
  const sources: string[] = [];
  for (const [i, size, fps] of [[0, '640x360', 30], [1, '1280x720', 25], [2, '320x240', 24]] as const) {
    const path = join(project, `source-${i}.mp4`);
    await runFfmpeg(['-n', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=4`,
      ...(i === 2 ? [] : ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${i ? 48000 : 44100}:duration=4`]),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(i === 2 ? [] : ['-c:a', 'aac']), path], { timeoutMs: 60000 });
    sources.push(path);
  }
  const snapshot = (path: string) => ({ size: statSync(path).size, mtime: statSync(path).mtimeMs,
    hash: createHash('sha256').update(readFileSync(path)).digest('hex') });
  const before = sources.map(snapshot);
  const segments = sources.map((path, i) => ({ path, in: [0.5, 1, 0][i], out: [2, 3.5, 1.2][i] }));
  const result = await concatSegments(project, segments, { outputName: 'preview.mp4' });
  assert.equal(dirname(result.path), join(project, 'exports'));
  const info = await probe(result.path);
  assert.deepEqual([info.fps, info.width, info.height, info.audioSampleRate, info.audioChannels], [30, 640, 360, 44100, 1]);
  const video = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'json', result.path], { timeoutMs: 15000 });
  const duration = Number(JSON.parse(video.stdout).streams[0].duration);
  const expected = 5.2;
  const error = Math.abs(duration - expected);
  t.diagnostic(`video duration=${duration}s expected=${expected}s error=${error}s tolerance=${1 / info.fps}s`);
  assert.ok(error <= 1 / info.fps);
  assert.equal(result.durationSec, info.durationSec);
  const originalOutput = snapshot(result.path);
  const second = await concatSegments(project, segments, { outputName: 'preview.mp4' });
  assert.equal(second.path, join(project, 'exports', 'preview_1.mp4'));
  assert.deepEqual(snapshot(result.path), originalOutput);
  assert.deepEqual(sources.map(snapshot), before);
  for (const [start, end] of [[-1, 2], [2, 2], [3, 2], [0, 9], [NaN, 2], [0, Infinity]]) {
    await assert.rejects(concatSegments(project, [{ path: sources[0], in: start, out: end }]), /cần 0 <= in/);
  }
  await assert.rejects(concatSegments(project, [{ path: join(project, 'missing.mp4'), in: 0 }]), { code: 'MEDIA_FILE_MISSING' });
  await assert.rejects(concatSegments(project, segments, { outputPath: sources[0] }));
  await assert.rejects(concatSegments(project, segments, { outputName: '../escape.mp4' }));
  await assert.rejects(concatSegments(project, segments, { width: 321 }), /chuẩn hóa không hợp lệ/);
  const override = await concatSegments(project, [{ path: sources[2], in: 3 }], {
    outputName: 'override.mp4', fps: 24, width: 320, height: 240, audioSampleRate: 48000, audioChannels: 2,
  });
  const overrideInfo = await probe(override.path);
  assert.deepEqual([overrideInfo.fps, overrideInfo.width, overrideInfo.height, overrideInfo.audioSampleRate, overrideInfo.audioChannels], [24, 320, 240, 48000, 2]);
});
