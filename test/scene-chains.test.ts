import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChains, computeRedoScope, SceneNotFoundError } from '../src/prompt/scene-chains.ts';
import type { ChainSceneInput } from '../src/prompt/scene-chains.ts';

const scenes = (...transitions: ChainSceneInput['transition'][]): ChainSceneInput[] =>
  transitions.map((transition, index) => ({ id: String(index + 1), transition }));
const sequence = scenes('cut', 'continue', 'continue', 'cut', 'continue');

test('cut starts a new indexed chain and continue joins the current chain', () => {
  assert.deepEqual(computeChains(sequence), [
    { index: 0, scene_ids: ['1', '2', '3'] },
    { index: 1, scene_ids: ['4', '5'] },
  ]);
});

test('redo includes the edited scene and stops before the next cut', () => {
  for (const [index, expected] of [
    [0, ['1', '2', '3']], [1, ['2', '3']], [2, ['3']], [3, ['4', '5']], [4, ['5']],
  ] as const) {
    assert.deepEqual(computeRedoScope(sequence, index), expected);
    assert.deepEqual(computeRedoScope(sequence, String(index + 1)), expected);
  }
});

test('an initial continue is treated as cut consistently for chains and redo', () => {
  const input = scenes('continue', 'continue', 'cut');
  assert.deepEqual(computeChains(input), [
    { index: 0, scene_ids: ['1', '2'] }, { index: 1, scene_ids: ['3'] },
  ]);
  assert.deepEqual(computeRedoScope(input, 0), ['1', '2']);
  assert.deepEqual(computeRedoScope(input, 1), ['2']);
});

test('empty input, single scenes, all cuts and all continues', () => {
  assert.deepEqual(computeChains([]), []);
  for (const transition of ['cut', 'continue'] as const) {
    const input = scenes(transition);
    assert.deepEqual(computeChains(input), [{ index: 0, scene_ids: ['1'] }]);
    assert.deepEqual(computeRedoScope(input, 0), ['1']);
  }
  const cuts = scenes('cut', 'cut', 'cut');
  assert.deepEqual(computeChains(cuts), cuts.map((scene, index) => ({ index, scene_ids: [scene.id] })));
  assert.deepEqual(computeRedoScope(cuts, 1), ['2']);
  assert.deepEqual(computeChains(scenes('continue', 'continue', 'continue')),
    [{ index: 0, scene_ids: ['1', '2', '3'] }]);
});

test('missing ids and invalid positions throw a named error with a code', () => {
  for (const selector of ['missing', '', -1, 5, 1.5, NaN, Infinity]) {
    assert.throws(() => computeRedoScope(sequence, selector), error => {
      assert.ok(error instanceof SceneNotFoundError);
      assert.equal(error.code, 'SCENE_NOT_FOUND');
      assert.match(error.message, /Scene not found/);
      return true;
    });
  }
  assert.throws(() => computeRedoScope([], 0), SceneNotFoundError);
  assert.throws(() => computeRedoScope([], '1'), SceneNotFoundError);
});

test('functions accept frozen inputs and return independent fresh results', () => {
  const input = Object.freeze(scenes('continue', 'continue', 'cut').map(scene => Object.freeze(scene)));
  const before = JSON.stringify(input);
  const chains = computeChains(input);
  const scope = computeRedoScope(input, 0);
  chains[0].scene_ids.push('changed');
  chains[0].index = 99;
  scope.push('changed');
  assert.deepEqual(computeChains(input), [
    { index: 0, scene_ids: ['1', '2'] }, { index: 1, scene_ids: ['3'] },
  ]);
  assert.deepEqual(computeRedoScope(input, 0), ['1', '2']);
  assert.equal(JSON.stringify(input), before);
});
