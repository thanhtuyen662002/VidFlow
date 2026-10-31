import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { setBible, getBible } from '../src/repo/bibles.ts';
import { createReference, listReferences, updateReference } from '../src/repo/references.ts';
import { saveProjectAsTemplate, createProjectFromTemplate, listTemplates, getTemplate, deleteTemplate } from '../src/repo/templates.ts';
import { compileScene } from '../src/prompt/compiler.ts';
import { BibleService } from '../src/prompt/bible.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=', 'base64');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t: Parameters<typeof temporaryDatabase>[0]) {
  const db = temporaryDatabase(t);
  migrate(db);
  const project = createProject(db, 'Nguồn', '9:16', 100);
  setBible(db, project.id, { style: 'Hoạt hình', lighting: 'Ấm', palette: 'Vàng' });
  for (const name of ['Lan', 'Vuon']) {
    const path = join(project.directory, 'refs', `${name}.png`);
    writeFileSync(path, png);
    createReference(db, { project_id: project.id, name, role: name === 'Lan' ? 'character' : 'location', images: [path], description: name, priority: 1 });
  }
  return { db, project };
}
test('series template copies Bible, handles, config and images; compiler resolves new files; edits are isolated', t => {
  const { db, project } = fixture(t);
  const template = saveProjectAsTemplate(db, project.id, { name: 'Series' });
  assert.deepEqual(template.config, { aspect: '9:16' });
  assert.equal(template.style, 'Hoạt hình');
  const directory = join(process.env.VIDFLOW_HOME!, 'templates', template.id);
  const paths = [join(directory, 'template.json'), ...template.references.flatMap(r => r.images.map(f => join(directory, f)))];
  const before = paths.map(hash);
  const created = createProjectFromTemplate(db, template.id, { name: 'Tập mới' });
  assert.notEqual(created.id, project.id);
  assert.equal(created.budget, null);
  const { id, project_id, ...bible } = getBible(db, created.id)!;
  assert.deepEqual(bible, template.bible);
  const refs = listReferences(db, created.id);
  assert.deepEqual(refs.map(r => r.name).sort(), ['Lan', 'Vuon']);
  for (const ref of refs) for (const file of ref.images) {
    assert.ok(existsSync(file));
    assert.ok(relative(created.directory, file).startsWith('refs'));
    assert.deepEqual(readFileSync(file), png);
  }
  const compiled = compileScene({ prompt: '@Lan @Vuon', charactersPresent: ['Lan'], location: 'Vuon', camera: '', action: '' },
    { ...bible, entries: new BibleService(db).list(created.id) }, { maxReferenceImages: 3 });
  assert.deepEqual(compiled.references.map(r => r.image).sort(), refs.flatMap(r => r.images).sort());
  setBible(db, created.id, { style: 'Đã sửa' });
  updateReference(db, refs[0].id, { description: 'Đã sửa', priority: 99 });
  writeFileSync(refs[0].images[0], 'changed');
  unlinkSync(refs[1].images[0]);
  assert.deepEqual(paths.map(hash), before);
  template.bible!.style = 'mutation';
  assert.equal(getTemplate(template.id).bible!.style, 'Hoạt hình');
  assert.equal(listTemplates().length, 1);
  assert.equal(deleteTemplate(template.id), true);
  assert.equal(deleteTemplate(template.id), false);
  assert.deepEqual(listTemplates(), []);
  assert.throws(() => deleteTemplate('../projects'));
});
test('series template rejects escaped source images without leaving a template', t => {
  const { db, project } = fixture(t);
  for (const unsafe of ['../../x.png', join(process.cwd(), 'x.png')]) {
    db.prepare('UPDATE "references" SET images=? WHERE project_id=?').run(JSON.stringify([unsafe]), project.id);
    assert.throws(() => saveProjectAsTemplate(db, project.id, { name: 'Unsafe' }), /inside|path|Path|refs/i);
    assert.deepEqual(listTemplates(), []);
  }
});
test('series template rejects missing and invalid images and cleans partial copies', t => {
  const { db, project } = fixture(t);
  const refs = listReferences(db, project.id);
  writeFileSync(refs[1].images[0], 'invalid');
  assert.throws(() => saveProjectAsTemplate(db, project.id, { name: 'Invalid' }), /không hợp lệ/);
  assert.deepEqual(listTemplates(), []);
  unlinkSync(refs[1].images[0]);
  assert.throws(() => saveProjectAsTemplate(db, project.id, { name: 'Missing' }), /không tồn tại/);
  assert.deepEqual(listTemplates(), []);
});
