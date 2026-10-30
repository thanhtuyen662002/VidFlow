import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { temporaryDatabase } from './helpers.ts';
import { detectFfmpeg } from './helpers/media.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { runMediaFiles } from '../src/media/runner.ts';
import { probe } from '../src/media/probe.ts';
import { mix, measure_loudness } from '../src/edit/audio.ts';
import { exportFinal, escapeSubtitlePath } from '../src/edit/export.ts';
import { timelineSrt, subtitleCues } from '../src/edit/subtitles.ts';
import type { Timeline, TimelineClip } from '../src/edit/timeline.ts';

function clip(start: number, order: number): TimelineClip {
  return { id: String(order), trackId: 'v', sceneId: String(order), takeId: null, sourceAssetId: null,
    sourcePath: '', inPoint: 0.5, outPoint: 1.5, duration: 1, timelineStart: start, order,
    dialogueLines: [{ start: 0.2, end: 0.7, text: 'Xin chào Việt Nam' },
      { start: 1.3, end: 1.8, text: 'Tạm biệt' }, { start: 2, end: 3, text: 'bỏ' }] };
}
function timeline(fps: number): Timeline {
  return { id: 't', projectId: 'p', createdAt: '', revision: 1, status: 'draft', fps,
    tracks: [{ id: 'v', timelineId: 't', kind: 'video', order: 0, muted: false,
      clips: [clip(0, 0), clip(1, 1)], subtitles: [] }] };
}
test('M7.3 subtitle timing: trims, boundaries, 24/29.97 fps and UTF-8 SRT', () => {
  for (const fps of [24, 29.97]) {
    const input = timeline(fps), cues = subtitleCues(input);
    const expected = [[0, 0.2], [0.8, 1], [1, 1.2], [1.8, 2]];
    assert.equal(cues.length, 4);
    const srt = timelineSrt(input);
    const parsed = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3})/g)].map(m =>
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
    expected.flat().forEach((n, i) => assert.ok(Math.abs(parsed[i] - n) <= 1 / fps));
    assert.match(srt, /^1\n00:00:00,000 -->/);
    assert.match(srt, /Xin chào Việt Nam/);
    cues.forEach((c, i) => { if (i) assert.ok(c.startMs >= cues[i - 1].endMs); });
    input.tracks[0].clips[0].dialogueLines!.push({ start: 0.6, end: 1.4, text: 'overlap' });
    const overlapping = subtitleCues(input);
    overlapping.forEach((c, i) => { if (i) assert.ok(c.startMs >= overlapping[i - 1].endMs); });
  }
  assert.match(escapeSubtitlePath('C:\\video folder\\a.srt'), /C\\\\:/);
  const legacy = timeline(24);
  legacy.tracks[0].clips.forEach(c => { delete c.dialogueLines; });
  legacy.tracks.push({ id: 's', timelineId: 't', kind: 'subtitle', order: 1, muted: false, clips: [],
    subtitles: [{ id: 's1', trackId: 's', sceneId: '0', start: 0.1, end: 0.9, text: 'Lời cũ', order: 0 }] });
  assert.equal(subtitleCues(legacy).length, 1);
  assert.match(timelineSrt(legacy), /Lời cũ/);
});
const media = detectFfmpeg();
test('M7.3 export: both ratios, audio duration and -14 LUFS', { skip: !media.available && media.reason }, async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'M7.3', '16:9', null);
  const context = { dataDir: process.env.VIDFLOW_HOME!, projectDir: project.directory, timeoutMs: 120000 };
  const input = timeline(24); input.projectId = project.id;
  const voice = join(project.directory, 'exports', 'quiet.wav');
  await runMediaFiles('ffmpeg', (_, output) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=0.05', output!],
    { ...context, inputPaths: [], outputPath: voice });
  const before = await measure_loudness(voice, context); assert.ok(before.integratedLufs < -30);
  const mixed = await mix(db, project.id, { durationSec: 2, dialogue: [{ file: voice }] }, join(project.directory, 'exports', 'mixed.wav'), context);
  for (const [i, c] of input.tracks[0].clips.entries()) {
    c.sourcePath = join(project.directory, 'exports', `source${i}.mp4`);
    await runMediaFiles('ffmpeg', (_, output) => ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', output!],
    { ...context, inputPaths: [], outputPath: c.sourcePath });
  }
  for (const aspect of ['16:9', '9:16'] as const) {
    const result = await exportFinal(input, { projectDir: project.directory, mixedAudioPath: mixed.path, aspect, timestamp: 'test' });
    const info = await probe(result.path), loudness = await measure_loudness(result.path, context);
    assert.equal(info.width, aspect === '16:9' ? 1920 : 1080);
    assert.equal(info.height, aspect === '16:9' ? 1080 : 1920);
    assert.equal(info.hasAudio, true); assert.ok(Math.abs(info.durationSec - 2) < 1 / 24 + 0.05);
    assert.ok(!relative(join(project.directory, 'exports'), result.path).startsWith('..'));
    assert.equal(await readFile(result.srtPath, 'utf8'), timelineSrt(input));
    assert.ok(Math.abs(loudness.integratedLufs + 14) <= 1);
    t.diagnostic(`${aspect}: ffprobe ${info.width}x${info.height}, duration=${info.durationSec}s; ${loudness.integratedLufs} LUFS (input ${before.integratedLufs} LUFS)`);
  }
});
