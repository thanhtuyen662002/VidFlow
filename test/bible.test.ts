import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate, migrations } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createReference, findReferenceByName, listReferences, listNameConflicts, updateReference } from '../src/repo/references.ts';
import { BibleService, BibleDuplicateError, validatePromptRefs } from '../src/prompt/bible.ts';

const fields = { name: 'Lan', images: ['refs/lan.png'], description: 'Character Lan', priority: 1 };

test('unregistered errors retain raw name and original UTF-16 positions', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Demo', '16:9', null);
  const errors = validatePromptRefs(db, project.id, 'Hi\r\n😀 @Lan');
  assert.equal(errors.length, 1);
  const error = errors[0];
  assert.equal(error.code, 'REF_UNREGISTERED');
  assert.equal(error.name, 'Lan');
  assert.equal(error.normalizedName, 'Lan');
  assert.equal(error.offset, 7);
  assert.equal(error.line, 2);
  assert.equal(error.column, 4);
  const raw = 'Hương'.normalize('NFD');
  const decomposed = validatePromptRefs(db, project.id, `@${raw}`)[0];
  assert.equal(decomposed.name, raw);
  assert.equal(decomposed.normalizedName, 'Hương');
  assert.deepEqual(validatePromptRefs(db, project.id, '@@Lan'), []);
});

test('Bible and M1 share registrations, CRUD, NFC uniqueness and confirmation', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Demo', '16:9', null);
  const other = createProject(db, 'Other', '16:9', null);
  const bible = new BibleService(db);
  const lan = createReference(db, { ...fields, role: 'character', project_id: project.id });
  assert.deepEqual(validatePromptRefs(db, project.id, 'Hi @Lan'), []);
  assert.equal(bible.list(project.id)[0].id, lan.id);
  const huong = bible.add(project.id, { ...fields, name: 'Hương', kind: 'character' });
  assert.equal(findReferenceByName(db, project.id, 'Hương'.normalize('NFD')), true);
  assert.equal(listReferences(db, project.id).length, 2);
  const duplicate = (error: unknown) => error instanceof BibleDuplicateError && error.code === 'BIBLE_DUPLICATE_NAME';
  assert.throws(() => createReference(db, { ...fields, name: 'Hương'.normalize('NFD'), role: 'prop', project_id: project.id }), duplicate);
  assert.throws(() => bible.add(project.id, { ...fields, name: 'Hương'.normalize('NFD'), kind: 'style' }), duplicate);
  assert.throws(() => bible.update(project.id, lan.id, { name: 'Hương'.normalize('NFD') }), duplicate);
  assert.deepEqual(bible.list(other.id), []);
  assert.equal(bible.update(other.id, lan.id, { name: 'Wrong' }), undefined);
  assert.equal(bible.delete(other.id, lan.id, true), false);
  assert.equal(bible.update(project.id, lan.id, { name: 'Mai', priority: 3, description: 'Updated' })?.name, 'Mai');
  assert.deepEqual(validatePromptRefs(db, project.id, '@Mai'), []);
  assert.equal(findReferenceByName(db, project.id, 'Lan'), false);
  assert.throws(() => bible.delete(project.id, lan.id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, 'BIBLE_DELETE_CONFIRMATION_REQUIRED');
    assert.equal(error.name, 'Mai');
    assert.match(error.message, /Mai/);
    return true;
  });
  assert.equal(bible.list(project.id).length, 2);
  assert.equal(bible.delete(project.id, lan.id, true), true);
  assert.equal(bible.delete(project.id, huong.id, true), true);
  assert.deepEqual(bible.list(project.id), []);
});

test('migration preserves colliding rows and exposes conflicts for resolution', t => {
  const db = temporaryDatabase(t);
  migrate(db, migrations.slice(0, 3));
  const project = createProject(db, 'Demo', '16:9', null);
  const insert = db.prepare('INSERT INTO "references" (id, project_id, name, role, images) VALUES (?, ?, ?, ?, ?)');
  insert.run('a', project.id, 'Hương', 'character', '["refs/a.png"]');
  insert.run('b', project.id, 'Hương'.normalize('NFD'), 'prop', '["refs/b.png"]');
  migrate(db);
  assert.equal(listReferences(db, project.id).length, 2);
  const rows = db.prepare('SELECT * FROM "references" ORDER BY id').all();
  assert.equal(rows[0].name_key, 'Hương');
  assert.equal(rows[0].name_conflict, 0);
  assert.equal(rows[1].name_conflict, 1);
  assert.equal(listNameConflicts(db, project.id)[0].id, 'b');
  assert.deepEqual(validatePromptRefs(db, project.id, '@Hương'), []);
  assert.ok(db.prepare('PRAGMA index_list("references")').all().some(row => row.name === 'reference_project_name_key' && row.unique === 1));
  assert.throws(() => db.prepare('UPDATE "references" SET name_key = ? WHERE id = ?').run('Hương', 'b'));
  updateReference(db, 'b', { name: 'Khác' });
  assert.deepEqual(listNameConflicts(db, project.id), []);
  migrate(db);
  assert.equal(listReferences(db, project.id).length, 2);
});

test('repo NFC registration rejects decomposed Bible names', t => {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Demo', '16:9', null);
  createReference(db, { ...fields, name: 'Hương', role: 'character', project_id: project.id });
  assert.throws(() => new BibleService(db).add(project.id, {
    ...fields, name: 'Hương'.normalize('NFD'), kind: 'character',
  }), BibleDuplicateError);
});

test('one-time legacy Bible copy preserves identical names, ids and content', t => {
  const db = temporaryDatabase(t);
  migrate(db, migrations.slice(0, 3));
  const project = createProject(db, 'Demo', '16:9', null);
  db.prepare('INSERT INTO "references" (id, project_id, name, role, images) VALUES (?, ?, ?, ?, ?)')
    .run('a', project.id, 'Lan', 'character', '["refs/a.png"]');
  // Fixture for a previously shipped store; production code only accesses it in migration.
  db.exec(`CREATE TABLE bible_entries (id TEXT PRIMARY KEY, project_id TEXT, name TEXT,
    kind TEXT, images TEXT, description TEXT, priority INTEGER)`);
  db.prepare('INSERT INTO bible_entries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('b', project.id, 'Lan', 'style', '["refs/b.png"]', 'Legacy description', 9);
  migrate(db);
  const refs = listReferences(db, project.id);
  assert.equal(refs.length, 2);
  const copied = refs.find(row => row.id === 'b')!;
  assert.equal(copied.name, 'Lan');
  assert.equal(copied.role, 'style');
  assert.equal(copied.description, 'Legacy description');
  assert.equal(copied.priority, 9);
  assert.match(copied.images[0], /b\.png$/);
  assert.equal(listNameConflicts(db, project.id)[0].id, 'b');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'bible_entries'").get(), undefined);
});
