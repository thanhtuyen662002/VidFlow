import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileScene } from '../src/prompt/compiler.ts';
import type { CompilerScene, CompilerBible } from '../src/prompt/compiler.ts';
import { UnregisteredReferenceError } from '../src/prompt/bible.ts';

function fixture(): { scene: CompilerScene; bible: CompilerBible } {
  return JSON.parse(readFileSync(new URL('./fixtures/compiler/input.json', import.meta.url), 'utf8'));
}

test('compiler golden snapshot, repeatability, reordered keys and registry, no mutation', () => {
  const { scene, bible } = fixture();
  const before = JSON.stringify({ scene, bible });
  const options = { maxReferenceImages: 3 };
  const first = compileScene(scene, bible, options);
  const second = compileScene(scene, bible, options);
  const golden = readFileSync(new URL('./fixtures/compiler/expected.json', import.meta.url), 'utf8');
  assert.deepEqual(first, JSON.parse(golden));
  assert.equal(JSON.stringify(first, null, 2) + '\n', golden);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
    return value;
  }
  const cloned = reverseKeys(JSON.parse(before)) as ReturnType<typeof fixture>;
  cloned.bible.entries = [...cloned.bible.entries].reverse();
  assert.deepEqual(compileScene(cloned.scene, cloned.bible, options), first);
  assert.equal(JSON.stringify({ scene, bible }), before);
});

test('five references: kind before descending priority; limits and appearance ties', () => {
  const { scene, bible } = fixture();
  const ids = (limit: number) => compileScene(scene, bible, { maxReferenceImages: limit }).references.map(ref => ref.id);
  assert.deepEqual(ids(3), ['b', 'a', 'l']);
  assert.deepEqual(ids(9), ['b', 'a', 'l', 'p', 's']);
  assert.deepEqual(ids(0), []);
  bible.entries = bible.entries.map(entry => ({ ...entry, priority: 1 }));
  assert.deepEqual(ids(3), ['a', 'b', 'l']);
  scene.prompt = '@Mai @Lan';
  assert.deepEqual(ids(3), ['b', 'a', 'l']);
});

test('compiler reuses M2.2 error including original position', () => {
  const { scene, bible } = fixture();
  scene.prompt = 'Hi\r\n@KhongTonTai';
  assert.throws(() => compileScene(scene, bible, { maxReferenceImages: 3 }), error => {
    assert.ok(error instanceof UnregisteredReferenceError);
    assert.equal(error.code, 'REF_UNREGISTERED');
    assert.equal(error.name, 'KhongTonTai');
    assert.equal(error.offset, 4);
    assert.equal(error.line, 2);
    assert.equal(error.column, 1);
    return true;
  });
});

test('NFC lookup, prose whitespace, implicit scene fields and canonical id ties', () => {
  const { scene, bible } = fixture();
  bible.entries = bible.entries.map(entry => entry.id === 'a' ? { ...entry, name: 'Lán' } : entry);
  scene.prompt = '  @La\u0301n,\t@Lán!  ';
  scene.charactersPresent = ['Lán', 'Mai'];
  const result = compileScene(scene, bible, { maxReferenceImages: 9 });
  assert.ok(result.prompt.includes('  Cô gái Lan,\tCô gái Lan!  \nCô gái Mai\nQuiet park'));
  assert.equal(result.references.filter(ref => ref.id === 'a').length, 1);
  scene.prompt = '';
  scene.charactersPresent = ['Mai', 'Lán'];
  bible.entries = bible.entries.map(entry => ({ ...entry, priority: 1 }));
  assert.deepEqual(compileScene(scene, bible, { maxReferenceImages: 9 }).references.map(ref => ref.id), ['a', 'b', 'l']);
  assert.throws(() => compileScene(scene, bible, { maxReferenceImages: -1 }), RangeError);
});
