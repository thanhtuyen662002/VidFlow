import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { run } from '../src/cli.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, invoke: (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, VIDFLOW_HOME: home }, encoding: 'utf8', timeout: 15000,
      cwd: tmpdir(),
    });
    assert.ifError(result.error);
    return result;
  } };
}

test('init, create, list, show and repeated migrations preserve project', t => {
  const { home, invoke } = fixture(t);
  assert.equal(invoke('init').status, 0);
  assert.ok(existsSync(join(home, 'vidflow.db')));
  const created = invoke('project', 'create', ' Demo ', '--aspect', '16:9', '--budget', '12.5');
  assert.equal(created.status, 0, created.stderr);
  const id = /^ID: (.+)$/m.exec(created.stdout)![1];
  for (const part of ['', 'refs', 'renders', 'frames', 'audio', 'exports']) {
    assert.ok(existsSync(join(home, 'projects', id, part)));
  }
  for (let i = 0; i < 3; i++) assert.equal(invoke('init').status, 0);
  const listed = invoke('project', 'list');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /Demo/);
  for (const key of [id, 'Demo']) {
    const shown = invoke('project', 'show', key);
    assert.equal(shown.status, 0, shown.stderr);
    for (const detail of [id, 'Demo', '16:9', '12.5', 'draft', home]) assert.ok(shown.stdout.includes(detail));
    assert.match(shown.stdout, /\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal(invoke('project', 'create', 'Demo', '--aspect', '9:16').status, 1);
  const db = new DatabaseSync(join(home, 'vidflow.db'));
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get()!.count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM migrations').get()!.count, 1);
  } finally { db.close(); }
});

test('create automatically initializes data directory', t => {
  const { invoke } = fixture(t);
  const result = invoke('project', 'create', 'Demo', '--aspect', '16:9');
  assert.equal(result.status, 0, result.stderr);
});

test('invalid inputs fail without creating projects', t => {
  const { invoke } = fixture(t);
  const cases = [
    ...['', '   ', '../bad', 'a/b', 'a\\b', 'a:b', 'NUL', 'x'.repeat(121)].map(name => ['project', 'create', name, '--aspect', '16:9']),
    ...['16-9', '0:9', '9:0', 'abc'].map(aspect => ['project', 'create', 'Demo', '--aspect', aspect]),
    ['project', 'create', 'Demo'],
    ...['-1', 'abc', 'Infinity', ''].map(budget => ['project', 'create', 'Demo', '--aspect', '16:9', '--budget', budget]),
    ['project', 'create', 'Demo', '--aspect', '16:9', '--unknown'],
    ['project', 'list', '--budget', '1'], ['init', 'extra'],
    ['project', 'show'], ['unknown'], ['ref', 'list'],
  ];
  for (const args of cases) {
    const result = invoke(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /vidflow: /);
  }
  const empty = invoke('project', 'list');
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /chưa có dự án/);
  const missing = invoke('project', 'show', 'missing');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /vidflow: /);
  for (const args of [[], ['--help'], ['project', 'create', '--help']]) {
    const help = invoke(...args);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage/);
  }
});

test('run reads VIDFLOW_HOME each time and reports database failures', t => {
  const { home } = fixture(t);
  const previous = process.env.VIDFLOW_HOME;
  t.after(() => { if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous; });
  let output = '';
  let errors = '';
  const io = { stdout: { write: (value: string) => { output += value; return true; } }, stderr: { write: (value: string) => { errors += value; return true; } } };
  for (const name of ['one', 'two']) {
    process.env.VIDFLOW_HOME = join(home, name);
    assert.equal(run(['init'], io), 0);
    assert.ok(output.includes(join(home, name)));
  }
  process.env.VIDFLOW_HOME = join(home, 'one', 'vidflow.db');
  assert.equal(run(['init'], io), 1);
  assert.match(errors, /vidflow: /);
});
