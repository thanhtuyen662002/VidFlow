import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, compileScenes, GroupDurationExceededError, InvalidSceneDurationError } from '../src/prompt/compiler.ts';
import type { CompilerBible, GroupCompilerScene } from '../src/prompt/compiler.ts';

const bible: CompilerBible = { style: 'Style', lighting: '', palette: '', lens: '', safe_area: '', avoid: '', entries: [] };
const options = { maxReferenceImages: 3 };
const scene = (id: string, groupId?: string | null, durationUsed?: number): GroupCompilerScene => ({
  id, groupId, durationUsed, prompt: `Scene ${id}`, charactersPresent: [], location: '', camera: '', action: '',
});
const snapshot = '0–3s / 3–6s / 6–8s\n\n0–3s\nStyle\nScene 2\n\n3–6s\nStyle\nScene 3\n\n6–8s\nStyle\nScene 4';

test('scenes 2–4 merge at the inclusive 8 second limit; full prompt snapshot and metadata', () => {
  const input = [scene('2', 'beat', 3), scene('3', 'beat', 3), scene('4', 'beat', 2)];
  const before = JSON.stringify(input);
  const result = compileScenes(input, bible, options);
  assert.deepEqual(result, [{ prompt: snapshot, references: [], group_id: 'beat', scene_ids: ['2', '3', '4'],
    segments: [{ scene_id: '2', start: 0, end: 3 }, { scene_id: '3', start: 3, end: 6 }, { scene_id: '4', start: 6, end: 8 }], total_duration: 8 }]);
  assert.equal(JSON.stringify(compileScenes(input, bible, options)), JSON.stringify(result));
  assert.equal(JSON.stringify(input), before);
});

test('absent, null and empty group ids follow M2.3 unchanged', () => {
  const input = [scene('1'), scene('2', null), scene('3', '')];
  assert.deepEqual(compileScenes(input, bible, options), input.map(item => compileScene(item, bible, options)));
});

test('over-limit groups return typed error with context', () => {
  assert.throws(() => compileScenes([scene('2', 'beat', 4), scene('3', 'beat', 4.1)], bible, options), error => {
    assert.ok(error instanceof GroupDurationExceededError);
    assert.equal(error.code, 'GROUP_DURATION_EXCEEDED');
    assert.equal(error.group_id, 'beat');
    assert.deepEqual(error.scene_ids, ['2', '3']);
    assert.equal(error.total, 8.1);
    assert.equal(error.limit, 8);
    return true;
  });
});

test('all grouped scenes require finite positive durations', () => {
  for (const duration of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
    assert.throws(() => compileScenes([scene('2', 'beat', 3), scene('3', 'beat', duration)], bible, options), InvalidSceneDurationError);
  }
});

test('separated group ids start independent units', () => {
  const input = [scene('1', 'a', 2), scene('2', 'a', 2), scene('3'), scene('4', 'a', 2), scene('5', 'a', 2)];
  const result = compileScenes(input, bible, options);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(item => 'scene_ids' in item ? item.scene_ids : []), [['1', '2'], [], ['4', '5']]);
});

test('mixed sequence preserves order: full prompt snapshot', () => {
  const input = [scene('1'), scene('2', 'beat', 3), scene('3', 'beat', 3), scene('4', 'beat', 2), scene('5')];
  assert.deepEqual(compileScenes(input, bible, options).map(item => item.prompt), ['Style\nScene 1', snapshot, 'Style\nScene 5']);
});

test('fractional timestamps use at most one decimal without trailing zeros', () => {
  const result = compileScenes([scene('1', 'a', 1.25), scene('2', 'a', 1.75)], bible, options);
  assert.ok(result[0].prompt.startsWith('0–1.3s / 1.3–3s\n\n'));
});
