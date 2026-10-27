import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { referenceFilename } from '../src/validate.ts';
import { resolveInside } from '../src/paths.ts';
import { createReference, findReferenceByName, listReferences } from '../src/repo/references.ts';

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-ref-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const invoke = (...args: string[]) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], {
      env: { ...process.env, VIDFLOW_HOME: home }, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    return result;
  };
  const image = join(home, 'hero.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  return { home, image, invoke };
}

test('CLI add, duplicate name, exclusive destination, ordered list and project isolation', t => {
  const { home, image, invoke } = fixture(t);
  const created = invoke('project', 'create', 'Demo', '--aspect', '16:9');
  assert.equal(created.status, 0, created.stderr);
  const id = /^ID: (.+)$/m.exec(created.stdout)![1];
  const refs = join(home, 'projects', id, 'refs');
  const add = (name: string, priority: string, source = image, project = 'Demo') => invoke('ref', 'add', project, source, '--name', name, '--role', 'character', '--description', 'Hero description', '--priority', priority);
  assert.match(invoke('ref', 'list', 'Demo').stdout, /No references/);
  assert.equal(add('Zed', '2').status, 0);
  assert.deepEqual(readFileSync(join(refs, 'hero.png')), readFileSync(image));
  const second = join(home, 'second.png');
  writeFileSync(second, readFileSync(image));
  assert.notEqual(add('Zed', '1', second).status, 0);
  assert.notEqual(add('Other', '1').status, 0);
  assert.deepEqual(readdirSync(refs), ['hero.png']);
  assert.equal(add('Alpha', '1', second).status, 0);
  const third = join(home, 'third.png');
  writeFileSync(third, readFileSync(image));
  assert.equal(add('Beta', '1', third).status, 0);
  const listed = invoke('ref', 'list', 'Demo');
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.indexOf('Alpha') < listed.stdout.indexOf('Beta'));
  assert.ok(listed.stdout.indexOf('Beta') < listed.stdout.indexOf('Zed'));
  const db = new DatabaseSync(join(home, 'vidflow.db'));
  try {
    const rows = listReferences(db, id);
    assert.equal(rows.length, 3);
    assert.deepEqual({ ...rows[2], id: '' }, { id: '', project_id: id, name: 'Zed', role: 'character', images: [join(refs, 'hero.png')], description: 'Hero description', priority: 2 });
  } finally { db.close(); }
  assert.equal(invoke('project', 'create', 'Other', '--aspect', '16:9').status, 0);
  assert.equal(add('Zed', '1', image, 'Other').status, 0);
});

test('CLI rejects missing flags, invalid inputs, missing projects and unsafe filenames', t => {
  const { home, image, invoke } = fixture(t);
  assert.equal(invoke('project', 'create', 'Demo', '--aspect', '16:9').status, 0);
  const flags = ['--name', 'Hero', '--role', 'character', '--description', 'Description', '--priority', '1'];
  const cases = [
    ...[0, 2, 4, 6].map(i => ['ref', 'add', 'Demo', image, ...flags.filter((_, index) => index !== i && index !== i + 1)]),
    ['ref', 'add', 'missing', image, ...flags], ['ref', 'list', 'missing'],
    ['ref', 'add', 'Demo', join(home, 'missing.png'), ...flags],
    ['ref', 'add', 'Demo', home, ...flags],
    ...['', 'bad role'].map(role => ['ref', 'add', 'Demo', image, ...flags.slice(0, 2), '--role', role, ...flags.slice(4)]),
    ...['1.5', 'NaN', '9007199254740992'].map(priority => ['ref', 'add', 'Demo', image, ...flags.slice(0, 6), '--priority', priority]),
  ];
  const unsafe = join(home, 'bad..png');
  writeFileSync(unsafe, 'image');
  cases.push(['ref', 'add', 'Demo', unsafe, ...flags]);
  for (const args of cases) {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /vidflow: /);
  }
});

test('filename and containment validation rejects traversal and Windows reserved names', t => {
  const { home } = fixture(t);
  for (const name of ['', '..', 'a..png', '../a.png', 'a/b.png', 'a\\b.png', 'NUL.png', 'COM1.png', 'x.']) assert.throws(() => referenceFilename(name));
  assert.equal(referenceFilename('a?.png'), 'a_.png');
  assert.throws(() => resolveInside(home, '../escape'));
});

test('reference repository enforces names per project and orders priority then name', t => {
  const { home } = fixture(t);
  const db = new DatabaseSync(join(home, 'repo.db'));
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES (\'one\'), (\'two\')');
    const input = { project_id: 'one', name: 'Zed', role: 'prop', images: ['image.png'], description: 'A prop', priority: 2 };
    createReference(db, input);
    assert.equal(findReferenceByName(db, 'one', 'Zed'), true);
    assert.throws(() => createReference(db, input));
    createReference(db, { ...input, project_id: 'two' });
    createReference(db, { ...input, name: 'Beta', priority: 1 });
    createReference(db, { ...input, name: 'Alpha', priority: 1 });
    assert.deepEqual(listReferences(db, 'one').map(r => r.name), ['Alpha', 'Beta', 'Zed']);
  } finally { db.close(); }
});
