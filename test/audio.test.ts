import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { temporaryDatabase } from './helpers.ts';
import { detectFfmpeg } from './helpers/media.ts';
import { migrate, migrations } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createMusicTrack, getMusicTrack, updateMusicTrack, listMusicTracks, deleteMusicTrack } from '../src/repo/music.ts';
import { buildMixGraph, mix, normalize, measure_loudness, parseLoudnorm } from '../src/edit/audio.ts';
import { TtsRegistry } from '../src/edit/tts.ts';
import { runMediaFiles } from '../src/media/runner.ts';

test('loudnorm: đọc JSON trong stderr và từ chối số đo không hợp lệ', () => {
  const sample = 'ffmpeg banner\n[Parsed_loudnorm_0]\n{\n"input_i":"-35.25", "input_tp":"-30.12",\n"input_lra":"0.10", "input_thresh":"-45.25", "target_offset":"0.02"\n}\n';
  assert.deepEqual(parseLoudnorm(sample), { integratedLufs: -35.25, truePeak: -30.12, lra: 0.1, threshold: -45.25, offset: 0.02 });
  assert.throws(() => parseLoudnorm(sample.replace('-35.25', '-inf')), /không hợp lệ/);
  assert.throws(() => parseLoudnorm('no JSON'), /JSON/);
  assert.throws(() => parseLoudnorm('{"input_i":null}'), /Thiếu/);
});

test('đồ thị trộn: ducking dùng lời làm key; bỏ ducking khi không có lời', () => {
  const graph = buildMixGraph(undefined, [{ file: 'voice', startSec: 1 }], { file: 'music' }, 4);
  assert.match(graph, /\[bed\]\[key\]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250/);
  assert.match(graph, /asplit=2\[spoken\]\[key\]/);
  assert.match(graph, /volume=-15dB/);
  assert.match(graph, /adelay=1000:all=1/);
  assert.doesNotMatch(graph, /normalize=1/);
  assert.doesNotMatch(buildMixGraph(undefined, [], { file: 'music' }, 4), /sidechaincompress/);
  assert.match(buildMixGraph(undefined, [], undefined, 4), /anullsrc/);
  assert.throws(() => buildMixGraph(undefined, [], undefined, NaN));
});

test('migration 15 và CRUD giấy phép nhạc giữ dữ liệu khi nâng cấp', t => {
  const db = temporaryDatabase(t);
  migrate(db, migrations.slice(0, 14));
  const project = createProject(db, 'Nhạc', '16:9', null);
  migrate(db);
  const track = createMusicTrack(db, { projectId: project.id, file: 'audio/music.wav', title: 'Nhạc thử', hasLicense: true, licenseSource: 'CC0 — nguồn thử', attribution: 'Tác giả' });
  assert.deepEqual(getMusicTrack(db, track.id), track);
  assert.equal(track.hasLicense, true);
  assert.equal(track.licenseSource, 'CC0 — nguồn thử');
  assert.equal(listMusicTracks(db, project.id).length, 1);
  assert.equal(updateMusicTrack(db, track.id, { hasLicense: false })!.hasLicense, false);
  assert.throws(() => createMusicTrack(db, { ...track, file: '../escape.wav' }));
  assert.throws(() => updateMusicTrack(db, track.id, { hasLicense: true, licenseSource: '' }));
  assert.equal(deleteMusicTrack(db, track.id), true);
  assert.equal(getMusicTrack(db, track.id), undefined);
});

const ffmpeg = detectFfmpeg();
test('sine: trộn, chuẩn hóa hai lượt và đo lại −14 LUFS ±1', { skip: !ffmpeg.available && ffmpeg.reason }, async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Âm thanh', '16:9', null);
  const context = { dataDir: process.env.VIDFLOW_HOME!, projectDir: project.directory };
  // Generated fixtures use the same M3 runner; exports are required for processed files.
  const voiceFile = join(project.directory, 'exports', 'dialogue.wav');
  const musicFile = join(project.directory, 'exports', 'music.wav');
  for (const [file, frequency] of [[voiceFile, 440], [musicFile, 220]] as const) {
    await runMediaFiles('ffmpeg', (_, output) => ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=5`, '-af', 'volume=-30dB', output!],
      { ...context, inputPaths: [], outputPath: file, timeoutMs: 15000 });
  }
  const track = createMusicTrack(db, { projectId: project.id, file: 'exports/music.wav', title: 'Sine', hasLicense: true, licenseSource: 'Tự sinh trong test', attribution: '' });
  const output = join(project.directory, 'exports', 'mix.wav');
  const result = await mix(db, project.id, { durationSec: 6, dialogue: [{ file: voiceFile, startSec: 1 }], music: { id: track.id } }, output, context);
  const measured = await measure_loudness(output, context);
  t.diagnostic(`Đo lại bản trộn: ${measured.integratedLufs} LUFS; true peak ${measured.truePeak} dBTP`);
  assert.ok(Math.abs(measured.integratedLufs + 14) <= 1);
  assert.equal(result.musicId, track.id);
  assert.equal(result.loudness!.integratedLufs, measured.integratedLufs);
  await assert.rejects(normalize(voiceFile, voiceFile, context));
  await assert.rejects(mix(db, project.id, { durationSec: 1, music: { id: 'missing' } }, output, context), /giấy phép/);
  const empty = await mix(db, project.id, { durationSec: 1 }, join(project.directory, 'exports', 'silence.wav'), context);
  assert.equal(empty.loudness, null);
});

test('TTS giả lập tạo WAV xác định, thời lượng dương, không cần mạng', { skip: !ffmpeg.available && ffmpeg.reason }, async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'TTS', '16:9', null);
  const context = { dataDir: process.env.VIDFLOW_HOME!, projectDir: project.directory };
  const registry = new TtsRegistry();
  assert.throws(() => registry.get('paid'));
  const provider = registry.get('mock');
  const first = await provider.synthesize('Xin chào thế giới', 'voice-1', 'vi', join(project.directory, 'exports', 'tts.wav'), context);
  const second = await provider.synthesize('Xin chào thế giới', 'voice-1', 'vi', join(project.directory, 'exports', 'tts2.wav'), context);
  assert.ok(first.durationSec > 0);
  assert.deepEqual(readFileSync(first.path), readFileSync(second.path));
  assert.equal(readFileSync(first.path).subarray(0, 4).toString(), 'RIFF');
  const probe = await runMediaFiles('ffprobe', paths => ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', paths[0]],
    { ...context, inputPaths: [first.path], timeoutMs: 15000 });
  assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 0);
});
