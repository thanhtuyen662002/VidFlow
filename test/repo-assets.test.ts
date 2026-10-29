import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createAsset, getAsset, listAssets, updateAsset, deleteAsset } from '../src/repo/assets.ts';
import { DuplicateError } from '../src/types.ts';

test('asset CRUD normalizes relative paths and rejects escapes without changing rows', t => {
  const db = temporaryDatabase(t); migrate(db);
  const p = createProject(db, 'Assets', '16:9', null);
  const input = { projectId: p.id, kind: 'image', relPath: 'refs/img.png' };
  const asset = createAsset(db, input);
  assert.deepEqual(getAsset(db, asset.id), asset);
  assert.deepEqual(listAssets(db, p.id, 'image'), [asset]);
  assert.deepEqual(listAssets(db, p.id, 'audio'), []);
  assert.throws(() => createAsset(db, input), DuplicateError);
  for (const relPath of ['../outside.png', 'a/../../x', join(p.directory, 'refs', 'absolute.png'), '/absolute.png', 'C:\\x', '..\\win.png']) {
    assert.throws(() => createAsset(db, { ...input, relPath }));
    assert.deepEqual(listAssets(db, p.id), [asset]);
    assert.throws(() => updateAsset(db, asset.id, { relPath }));
    assert.deepEqual(getAsset(db, asset.id), asset);
  }
  const changed = updateAsset(db, asset.id, { relPath: 'refs\\other.png', mime: 'image/png', sizeBytes: 42 });
  assert.equal(changed?.relPath, 'refs/other.png');
  assert.equal(changed?.sizeBytes, 42);
  assert.equal(db.prepare('SELECT rel_path FROM assets WHERE id=?').get(asset.id)!.rel_path, 'refs/other.png');
  assert.equal(deleteAsset(db, asset.id), true);
  assert.equal(getAsset(db, asset.id), undefined);
  assert.equal(deleteAsset(db, asset.id), false);
  assert.equal(updateAsset(db, asset.id, { kind: 'audio' }), undefined);
});
