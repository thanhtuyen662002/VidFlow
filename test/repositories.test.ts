import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject, getProject, listProjects, updateProject, deleteProject } from '../src/repo/projects.ts';
import { createReference, getReference, listReferences, updateReference, deleteReference } from '../src/repo/references.ts';
import { createBible, getBible, listBibles, updateBible, setBible, deleteBible } from '../src/repo/bibles.ts';
import { DuplicateError } from '../src/types.ts';

test('project CRUD preserves budget and cascades related records', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Demo', '16:9', 12.5);
  assert.equal(getProject(db, project.id)?.budget, 12.5);
  assert.equal(listProjects(db).length, 1);
  assert.equal(updateProject(db, project.id, { name: 'Renamed', budget: 42.75 })?.budget, 42.75);
  assert.equal(getProject(db, project.id)?.name, 'Renamed');
  assert.throws(() => updateProject(db, project.id, { budget: -1 }));
  createBible(db, project.id, { style: 'cinematic' });
  createReference(db, { project_id: project.id, name: 'Hero', role: 'character', images: ['refs/hero.png'], description: 'Hero', priority: 1 });
  assert.equal(deleteProject(db, project.id), true);
  assert.equal(getProject(db, project.id), undefined);
  assert.equal(getBible(db, project.id), undefined);
  assert.deepEqual(listReferences(db, project.id), []);
  assert.equal(deleteProject(db, project.id), false);
});

test('reference CRUD validates paths, scopes names and persists relative images', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const one = createProject(db, 'One', '16:9', null);
  const two = createProject(db, 'Two', '9:16', 0);
  const input = { project_id: one.id, name: 'Zed', role: 'prop', images: [join(one.directory, 'refs', 'hero.png')], description: 'Prop', priority: 2 };
  const ref = createReference(db, input);
  assert.deepEqual(getReference(db, ref.id), ref);
  assert.deepEqual(JSON.parse(db.prepare('SELECT images FROM "references" WHERE id = ?').get(ref.id)!.images as string), [join('refs', 'hero.png')]);
  assert.throws(() => createReference(db, input), DuplicateError);
  createReference(db, { ...input, project_id: two.id, images: ['refs/hero.png'] });
  const alpha = createReference(db, { ...input, name: 'Alpha', priority: 1 });
  assert.deepEqual(listReferences(db, one.id).map(r => r.name), ['Alpha', 'Zed']);
  assert.throws(() => updateReference(db, ref.id, { name: 'Alpha' }), DuplicateError);
  assert.equal(updateReference(db, ref.id, { description: 'Updated', priority: 0 })?.description, 'Updated');
  assert.throws(() => updateReference(db, ref.id, { images: ['../escape.png'] }));
  assert.throws(() => updateReference(db, ref.id, { role: 'invalid' }));
  assert.equal(deleteReference(db, alpha.id), true);
  assert.equal(getReference(db, alpha.id), undefined);
  assert.equal(deleteReference(db, alpha.id), false);
});

test('Bible CRUD is isolated by project and validates text', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const one = createProject(db, 'One', '16:9', null);
  const two = createProject(db, 'Two', '9:16', null);
  const bible = createBible(db, one.id, { style: 'film', lighting: 'soft', palette: 'warm', lens: '35mm', avoid: 'blur', safe_area: 'center' });
  assert.deepEqual(getBible(db, one.id), bible);
  assert.throws(() => createBible(db, one.id), DuplicateError);
  setBible(db, two.id, { style: 'ink' });
  assert.equal(updateBible(db, one.id, { style: 'photo' })?.lighting, 'soft');
  assert.equal(getBible(db, two.id)?.style, 'ink');
  assert.equal(listBibles(db).length, 2);
  assert.throws(() => updateBible(db, one.id, { style: null as unknown as string }));
  assert.equal(deleteBible(db, one.id), true);
  assert.equal(getBible(db, one.id), undefined);
  assert.equal(deleteBible(db, one.id), false);
});
