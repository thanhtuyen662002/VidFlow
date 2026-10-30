import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScriptVariant, updateScriptVariant } from '../src/repo/scripts.ts';
import { createScene, listScenes } from '../src/repo/scenes.ts';
import { BibleService } from '../src/prompt/bible.ts';
import { compileScene } from '../src/prompt/compiler.ts';
import { split, ScriptReferenceError } from '../src/script/split.ts';

function setup(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Split', '16:9', null);
  const bible = new BibleService(db);
  // Same non-empty path-array fixture used by bible.test.ts and cli-scene.test.ts.
  bible.add(project.id, { name: 'Lan', kind: 'character', images: ['refs/lan.png'], description: 'Lan in blue', priority: 1 });
  bible.add(project.id, { name: 'Garden', kind: 'location', images: ['refs/garden.png'], description: 'Quiet garden', priority: 1 });
  const scenes = [{ sceneIndex: 1, durationSec: 4, description: '@Lan visits @Garden',
    dialogue: [{ speaker: '@Lan', text: 'Hello' }] },
  { sceneIndex: 2, durationSec: 3, description: 'Waves goodbye', dialogue: [{ speaker: 'Lan', text: 'Bye' }] }];
  const variant = createScriptVariant(db, { projectId: project.id, scenes, status: 'approved' });
  return { db, project, bible, variant, scenes };
}

test('split stores required fields, resolves both speaker forms and compiles each identity once', t => {
  const { db, bible, project, variant } = setup(t);
  const rows = split(db, variant.id);
  assert.equal(rows.length, 2);
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.charactersPresent, ['Lan']);
    assert.equal(row.transition, 'cut');
    assert.equal(row.durationUsed, index === 0 ? 4 : 3);
    assert.ok(row.moment);
    const compiled = compileScene(row, { entries: bible.list(project.id), style: '', lighting: '', palette: '', lens: '', safe_area: '', avoid: '' }, { maxReferenceImages: 3 });
    assert.equal(compiled.prompt.split('Lan in blue').length - 1, 1);
    if (index === 0) assert.equal(compiled.prompt.split('Quiet garden').length - 1, 1);
  }
  assert.deepEqual(listScenes(db, project.id, variant.id), rows);
});

test('draft split is refused without writes', t => {
  const { db, project, variant } = setup(t);
  updateScriptVariant(db, variant.id, { status: 'draft' });
  assert.throws(() => split(db, variant.id), /approved/);
  assert.deepEqual(listScenes(db, project.id, variant.id), []);
});

test('all unknown mentions and speakers are reported before replacing any scenes', t => {
  const { db, project, variant, scenes } = setup(t);
  const previous = split(db, variant.id);
  const other = createScene(db, { projectId: project.id, prompt: 'Unrelated' });
  updateScriptVariant(db, variant.id, { scenes: [{ ...scenes[0], description: '@Ghost meets @Missing',
    dialogue: [{ speaker: 'Nobody', text: '@Lost' }, { speaker: '@Unknown', text: 'Hello' }] }] });
  assert.throws(() => split(db, variant.id), error => error instanceof ScriptReferenceError &&
    ['Ghost', 'Missing', 'Nobody', 'Lost', 'Unknown'].every(name => error.references.some(ref => ref.replace(/^@/, '') === name)));
  assert.deepEqual(listScenes(db, project.id, variant.id), previous);
  assert.deepEqual(listScenes(db, project.id), [other]);
});

test('failed replacement rolls back deletions and earlier inserts', t => {
  const { db, project, variant } = setup(t);
  const previous = split(db, variant.id);
  db.exec(`CREATE TRIGGER reject_second_scene BEFORE INSERT ON scenes WHEN NEW."index" = 1
    BEGIN SELECT RAISE(ABORT, 'replacement failed'); END`);
  assert.throws(() => split(db, variant.id), /replacement failed/);
  assert.deepEqual(listScenes(db, project.id, variant.id), previous);
});

test('unknown references in an initial split save no scenes; locations cannot be speakers', t => {
  const { db, project, variant, scenes } = setup(t);
  updateScriptVariant(db, variant.id, { scenes: [{ ...scenes[0], description: '@Missing',
    dialogue: [{ speaker: 'Garden', text: '@Lost' }] }] });
  assert.throws(() => split(db, variant.id), error => error instanceof ScriptReferenceError &&
    ['Missing', 'Lost', 'Garden'].every(name => error.references.includes(name)));
  assert.deepEqual(listScenes(db, project.id, variant.id), []);
});
