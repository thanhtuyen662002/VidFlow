import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProjectDirectories, dataDirectory, resolveInside } from '../src/paths.ts';

test('data root is read at call time and project creation is repeatable', t => {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-paths-'));
  const originalHome = process.env.VIDFLOW_HOME;
  const originalAppdata = process.env.APPDATA;
  t.after(() => {
    if (originalHome === undefined) delete process.env.VIDFLOW_HOME;
    else process.env.VIDFLOW_HOME = originalHome;
    if (originalAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppdata;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.APPDATA = join(home, 'appdata');
  process.env.VIDFLOW_HOME = '';
  assert.equal(dataDirectory(), resolve(home, 'appdata', 'VidFlow'));
  delete process.env.APPDATA;
  assert.equal(dataDirectory(), join(homedir(), '.vidflow'));
  process.env.APPDATA = join(home, 'appdata');
  process.env.VIDFLOW_HOME = join(home, 'new data root');
  assert.equal(dataDirectory(), resolve(home, 'new data root'));
  const id = '12345678-1234-1234-1234-123456789abc';
  const directory = createProjectDirectories(id);
  assert.equal(createProjectDirectories(id), directory);
  for (const child of ['refs', 'assets', 'renders', 'frames', 'audio', 'exports']) {
    assert.ok(statSync(join(directory, child)).isDirectory());
  }
});

test('containment accepts new children and rejects unsafe path segments', t => {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-paths-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const child of ['refs/new.png', 'new/nested/file.png', 'a..b', '..foo']) {
    assert.equal(resolveInside(home, child), resolve(home, child));
  }
  for (const child of ['..', '../escape', 'refs/../image', 'refs\\..\\image', '/root', '\\root', 'C:\\root', 'C:root', '\\\\server\\share']) {
    assert.throws(() => resolveInside(home, child));
  }
});

test('containment canonicalizes both base and target and blocks redirected children', t => {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-paths-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, 'project');
  const outside = join(home, 'project-sibling');
  mkdirSync(base);
  mkdirSync(outside);
  const alias = join(home, 'alias');
  try {
    symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, join(base, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink creation is not permitted'); return; }
    throw error;
  }
  assert.equal(resolveInside(alias, 'new/file.png'), join(alias, 'new', 'file.png'));
  assert.throws(() => resolveInside(alias, 'escape'));
  assert.throws(() => resolveInside(alias, 'escape/new/file.png'));
});
