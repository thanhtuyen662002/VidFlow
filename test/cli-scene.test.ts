import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.ts';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScene, listScenes } from '../src/repo/scenes.ts';
import { createBible } from '../src/repo/bibles.ts';
import { BibleService } from '../src/prompt/bible.ts';
import { compileScene, compileScenes, compileSceneUnit } from '../src/prompt/compiler.ts';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Demo', '16:9', null);
  const bible = createBible(db, project.id, { style: 'Cinema' });
  const registry = new BibleService(db);
  registry.add(project.id, { name: 'Lan', kind: 'character', description: 'Lan in blue', images: ['refs/lan.png'], priority: 1 });
  const compilerBible = { ...bible, entries: registry.list(project.id) };
  const invoke = (projectKey: string, sceneId: string, ...extra: string[]) => {
    let stdout = '';
    let stderr = '';
    const status = run(['scene', 'compile', projectKey, sceneId, ...extra], {
      stdout: { write: (text: string) => { stdout += text; return true; } },
      stderr: { write: (text: string) => { stderr += text; return true; } },
    });
    return { status, stdout, stderr };
  };
  return { db, project, compilerBible, invoke };
}
const options = { maxReferenceImages: 3 };
const output = (compiled: ReturnType<typeof compileScene>) => [compiled.prompt, ...compiled.references.map(ref => ref.image)].join('\n') + '\n';

test('CLI prints compiler prompt and ordered images by project id or name', t => {
  const { db, project, compilerBible, invoke } = fixture(t);
  const scene = createScene(db, { projectId: project.id, prompt: 'Hello @Lan' });
  const expected = compileScene(scene, compilerBible, options);
  for (const key of [project.id, project.name]) {
    const result = invoke(key, scene.id);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output(expected));
    assert.equal(expected.references.length, 1);
  }
});

test('CLI reports unregistered reference name and original position without stack', t => {
  const { db, project, invoke } = fixture(t);
  const scene = createScene(db, { projectId: project.id, prompt: 'Hello\n  @Missing' });
  const result = invoke(project.id, scene.id);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /@Missing/);
  assert.match(result.stderr, /2:3, offset 8/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('CLI compiles the adjacent group containing the requested scene only', t => {
  const { db, project, compilerBible, invoke } = fixture(t);
  createScene(db, { projectId: project.id, prompt: '@Unrelated' });
  const group = [3, 3, 2].map(durationUsed => createScene(db, {
    projectId: project.id, prompt: '@Lan', groupId: 'beat', durationUsed,
  }));
  const expected = compileScenes(group, compilerBible, options)[0];
  const all = listScenes(db, project.id);
  for (const scene of group) {
    assert.deepEqual(compileSceneUnit(all, scene.id, compilerBible, options), expected);
    const result = invoke(project.id, scene.id);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output(expected));
  }
  assert.match(expected.prompt, /0–3s \/ 3–6s \/ 6–8s/);
  assert.throws(() => compileSceneUnit(all, 'missing', compilerBible, options), /missing/);
});

test('CLI rejects missing project, missing or foreign scene and invalid syntax', t => {
  const { db, project, invoke } = fixture(t);
  const other = createProject(db, 'Other', '16:9', null);
  const foreign = createScene(db, { projectId: other.id });
  for (const [key, id] of [['missing', 'missing'], [project.id, 'missing'], [project.id, foreign.id]]) {
    const result = invoke(key, id);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vidflow: /);
    assert.equal(result.stdout, '');
  }
  assert.equal(invoke(project.id, foreign.id, 'extra').status, 2);
});
