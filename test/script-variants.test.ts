import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate, migrations } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { getScriptVariant, listScriptVariants } from '../src/repo/scripts.ts';
import { listScriptReviews } from '../src/repo/script-reviews.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import { generateVariants, scoreVariants, editVariant } from '../src/script/variants.ts';
import { checkDialogueLength } from '../src/script/dialogue.ts';
import type { ScriptScene } from '../src/types.ts';
import type { TestContext } from 'node:test';

const scene: ScriptScene = { sceneIndex: 1, durationSec: 5, description: 'Khu vườn', dialogue: [{ speaker: 'Lan', text: 'Xin chào bạn' }] };
const output = (count: number, scenes = [scene]) => JSON.stringify({ variants: Array.from({ length: count }, () => ({ scenes })) });
const review = JSON.stringify({ score: 9, comment: 'Đạt ngay', issues: [] });
function setup(t: TestContext) {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Script test', '16:9', null);
  return { db, projectId: project.id, brief: 'Khu vườn' };
}

test('passes immediately: generates three drafts and persists every score and comment', async t => {
  const deps = setup(t);
  const llm = new MockLlm([output(3), review]);
  const variants = await generateVariants({ ...deps, llm, count: 3 });
  assert.equal(variants.length, 3);
  assert.equal(new Set(variants.map(v => v.id)).size, 3);
  assert.ok(variants.every(v => v.status === 'draft' && v.versionNumber === 1 && v.parentVariantId === null));
  assert.equal(listScriptVariants(deps.db, deps.projectId).length, 3);
  await scoreVariants({ ...deps, llm, reviewerModel: 'fake-editor' });
  for (const variant of variants) {
    assert.equal(getScriptVariant(deps.db, variant.id)?.status, 'scored');
    const [saved] = listScriptReviews(deps.db, variant.id);
    assert.equal(saved.score, 9);
    assert.equal(saved.comment, 'Đạt ngay');
    assert.equal(saved.reviewerModel, 'fake-editor');
    assert.ok(saved.createdAt);
    assert.deepEqual(saved.issues, []);
  }
});

test('dialogue checker counts whitespace, empty lines, exact boundary and configurable rate', () => {
  const boundary = { ...scene, durationSec: 2, dialogue: [{ speaker: 'Lan', text: ' một  hai\nba\tbốn năm ' }, { speaker: 'Nam', text: ' ' }] };
  assert.equal(checkDialogueLength(boundary), undefined);
  assert.equal(checkDialogueLength({ ...boundary, dialogue: [] }), undefined);
  assert.equal(checkDialogueLength(scene), undefined);
  assert.equal(checkDialogueLength({ ...boundary, durationSec: 1.99 })?.type, 'dialogue_too_long');
  assert.equal(checkDialogueLength(boundary, { wordsPerSecond: 5 }), undefined);
  assert.throws(() => checkDialogueLength(scene, { wordsPerSecond: 0 }), RangeError);
  assert.throws(() => checkDialogueLength(scene, { wordsPerSecond: NaN }), RangeError);
});

test('long dialogue issue is merged with editor feedback and stored in review', async t => {
  const deps = setup(t);
  const long = { ...scene, dialogue: [{ speaker: 'Lan', text: Array(30).fill('từ').join(' ') }] };
  const editorIssue = { sceneIndex: 1, type: 'clarity', severity: 'info', message: 'Làm rõ mục tiêu' };
  const llm = new MockLlm([output(1, [long, { ...scene, sceneIndex: 2 }]), JSON.stringify({ score: 7, comment: 'Cần rút gọn', issues: [editorIssue] })]);
  const [variant] = await generateVariants({ ...deps, llm, count: 1 });
  await scoreVariants({ db: deps.db, llm, variantIds: [variant.id], reviewerModel: 'fake' });
  const [saved] = listScriptReviews(deps.db, variant.id);
  assert.equal(saved.issues.length, 2);
  assert.deepEqual(saved.issues[0], editorIssue);
  assert.equal(saved.issues[1].type, 'dialogue_too_long');
  assert.equal(saved.issues[1].sceneIndex, 1);
  assert.match(saved.issues[1].message, /30 từ ≈ 12s.*5s/);
});

test('both system prompts are reloaded after editing their files', async t => {
  const deps = setup(t);
  const promptsDir = join(process.env.VIDFLOW_HOME!, 'prompts');
  mkdirSync(promptsDir);
  const received: (string | undefined)[] = [];
  const llm = new MockLlm([(request) => {
    received.push(request.system);
    return request.system?.startsWith('writer') ? output(1) : review;
  }]);
  for (const revision of ['A', 'B']) {
    writeFileSync(join(promptsDir, 'script-writer.system.md'), `writer ${revision}`);
    writeFileSync(join(promptsDir, 'script-editor.system.md'), `editor ${revision}`);
    const [variant] = await generateVariants({ ...deps, llm, promptsDir, count: 1 });
    await scoreVariants({ db: deps.db, llm, promptsDir, variantIds: [variant.id], reviewerModel: 'fake' });
  }
  assert.deepEqual(received, ['writer A', 'editor A', 'writer B', 'editor B']);
});

test('invalid output and invalid batch scores leave no partial records', async t => {
  const deps = setup(t);
  const invalid = new MockLlm([output(2), '{bad json', JSON.stringify({ variants: [{ scenes: [{ ...scene, durationSec: -1 }] }] })]);
  await assert.rejects(generateVariants({ ...deps, llm: invalid, count: 1 }), /validation/i);
  assert.equal(invalid.calls, 3);
  assert.deepEqual(listScriptVariants(deps.db, deps.projectId), []);
  const llm = new MockLlm([output(2), review, JSON.stringify({ score: 11, comment: 'invalid', issues: [] })]);
  const variants = await generateVariants({ ...deps, llm, count: 2 });
  await assert.rejects(scoreVariants({ ...deps, llm, reviewerModel: 'fake' }), /validation/i);
  for (const variant of variants) {
    assert.deepEqual(listScriptReviews(deps.db, variant.id), []);
    assert.equal(getScriptVariant(deps.db, variant.id)?.status, 'draft');
  }
});

test('editing creates a new draft version and retains original content and reviews', async t => {
  const deps = setup(t);
  const llm = new MockLlm([output(1), review]);
  const [original] = await generateVariants({ ...deps, llm, count: 1 });
  await scoreVariants({ ...deps, llm, reviewerModel: 'fake' });
  const before = getScriptVariant(deps.db, original.id);
  const edited = editVariant(deps.db, original.id, [{ ...scene, description: 'Vườn mới' }]);
  assert.notEqual(edited.id, original.id);
  assert.equal(edited.versionNumber, 2);
  assert.equal(edited.parentVariantId, original.id);
  assert.equal(edited.status, 'draft');
  assert.deepEqual(getScriptVariant(deps.db, original.id), before);
  assert.equal(listScriptReviews(deps.db, original.id).length, 1);
  assert.deepEqual(listScriptReviews(deps.db, edited.id), []);
});

test('migration upgrades existing scripts without losing content', t => {
  const db = temporaryDatabase(t);
  migrate(db, migrations.slice(0, 4));
  db.exec("INSERT INTO projects(id,name,aspect,directory,created_at) VALUES ('p','Old','16:9','p','now'); INSERT INTO script_variants(id,project_id,content) VALUES ('v','p','original')");
  migrate(db);
  const variant = getScriptVariant(db, 'v')!;
  assert.equal(variant.content, 'original');
  assert.equal(variant.versionNumber, 1);
  assert.equal(variant.parentVariantId, null);
  assert.deepEqual(listScriptReviews(db, 'v'), []);
});
