import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { backup, restore, readBackupManifest, BACKUP_MAGIC, isBackupExcluded } from '../src/service/archive.ts';
import { deleteTakes, listUnselectedTakes, createMaintenanceService } from '../src/service/maintenance.ts';
import { openDatabase } from '../src/db.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createRenderJob, createTake, selectTake, updateTake } from '../src/repo/renders.ts';
import { createAccount } from '../src/repo/accounts.ts';
import { createMcpSettingsStore } from '../src/app/mcp/settings.ts';

function fixture(t: TestContext) {
  const base = mkdtempSync(join(process.cwd(), 'test', '.maintenance-'));
  const home = join(base, 'source'); mkdirSync(home);
  const previous = process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME = home;
  const closers: (() => void)[] = [];
  t.after(() => { closers.forEach(close => close()); if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous; rmSync(base, { recursive: true, force: true }); });
  const put = (path: string, value: string | Buffer) => { const file = join(home, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value); return file; };
  return { base, home, put, closers };
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function handcrafted(path: string, content = Buffer.from('abc'), sha256 = hash(content), version = 1) {
  const json = Buffer.from(JSON.stringify({ version, sourceDir: '/absent-source', createdAt: '', files: [{ path, size: content.length, sha256, mode: 0o600 }] }));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return gzipSync(Buffer.concat([Buffer.from(BACKUP_MAGIC), length, json, content]));
}

test('backup/restore preserves nested Unicode, binary and empty files; excludes profiles and secrets', async t => {
  const { base, home, put } = fixture(t);
  const expected = ['a.txt', 'projects/dự án/ảnh nhị phân.bin', 'projects/dự án/trống'];
  put(expected[0], 'Xin chào Việt Nam'); put(expected[1], Buffer.from(Array.from({ length: 300000 }, (_, i) => i % 256))); put(expected[2], '');
  const excluded = ['profiles/a/cookies', 'projects/p/profiles/x', '.env', '.env.local', 'credentials.json', 'pool/tokens.json', 'private.key', 'x/my-secret.json', 'account-pool/accounts.json', 'evidence/login.png'];
  for (const file of excluded) { assert.equal(isBackupExcluded(file), true); put(file, 'KHÔNG_ĐƯỢC_SAO_LƯU_123'); }
  const archive = join(base, 'backup.vfb'), target = join(base, 'restored');
  const manifest = await backup(home, archive);
  assert.deepEqual(manifest.files.map(f => f.path).sort(), [...expected].sort());
  assert.deepEqual(await readBackupManifest(archive), manifest);
  const raw = gunzipSync(readFileSync(archive));
  assert.equal(raw.includes(Buffer.from('KHÔNG_ĐƯỢC_SAO_LƯU_123')), false);
  assert.equal(raw.includes(Buffer.from('profiles/')), false);
  assert.deepEqual(await restore(archive, target), manifest);
  const restored = await backup(target, join(base, 'second.vfb'));
  assert.deepEqual(restored.files, manifest.files);
  for (const file of expected) assert.equal(hash(readFileSync(join(home, file))), hash(readFileSync(join(target, file))));
  for (const file of excluded) assert.equal(existsSync(join(target, file)), false);
  await assert.rejects(restore(archive, home, { allowNonEmpty: true }), /khác/);
  await assert.rejects(restore(archive, target), /trống/);
  await assert.rejects(backup(home, archive), /EEXIST/);
});

test('SQLite backup includes committed WAL data and removes MCP tokens and account secret paths', async t => {
  const { base, home, put, closers } = fixture(t), db = openDatabase();
  closers.push(() => { if (db.isOpen) db.close(); });
  const secretFile = put('pool/opaque-value.dat', 'ACCOUNT_SECRET_7788');
  createAccount(db, { label: 'Chủ sở hữu', secretRef: secretFile });
  const project = createProject(db, 'Dự án còn nguyên', '16:9', null);
  createMcpSettingsStore(db).saveSettings({ mcp: { enabled: true, token: 'MCP_SECRET_9900' } });
  const file = join(base, 'sqlite.vfb'), target = join(base, 'restored');
  const manifest = await backup(home, file);
  assert.equal(manifest.files.some(f => f.path.includes('opaque-value')), false);
  const raw = gunzipSync(readFileSync(file));
  for (const value of ['MCP_SECRET_9900', 'ACCOUNT_SECRET_7788', secretFile]) assert.equal(raw.includes(Buffer.from(value)), false);
  await restore(file, target);
  const restored = new DatabaseSync(join(target, 'vidflow.db'));
  try {
    assert.equal(restored.prepare('SELECT name FROM projects WHERE id=?').get(project.id)!.name, project.name);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM app_mcp_settings').get()!.n, 0);
    assert.equal(restored.prepare('SELECT secret_ref FROM accounts').get()!.secret_ref, null);
    assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { restored.close(); }
});

test('restore rejects traversal, Windows aliases, excluded entries, bad version, truncation and hash mismatch', async t => {
  const { base } = fixture(t);
  let index = 0;
  for (const path of ['../x', '/x', 'a/../../x', 'C:/x', '\\server\\x', 'a\\..\\x', 'x:stream', 'CON', 'x.', 'profiles/x', 'x/token.json']) {
    const file = join(base, `bad-${index}.vfb`); writeFileSync(file, handcrafted(path));
    await assert.rejects(restore(file, join(base, `target-${index++}`)));
  }
  const file = join(base, 'bad.vfb'), target = join(base, 'hash-target');
  writeFileSync(file, handcrafted('x', Buffer.from('abc'), '0'.repeat(64)));
  await assert.rejects(restore(file, target), /Hash/); assert.equal(existsSync(join(target, 'x')), false);
  writeFileSync(file, handcrafted('x', Buffer.from('abc'), hash(Buffer.from('abc')), 2)); await assert.rejects(restore(file, target), /Phiên bản/);
  writeFileSync(file, gzipSync(Buffer.from('INVALID'))); await assert.rejects(restore(file, target));
  writeFileSync(file, handcrafted('x').subarray(0, -5)); await assert.rejects(restore(file, target));
});

function takesFixture(t: TestContext) {
  const fs = fixture(t), db = openDatabase();
  fs.closers.push(() => { if (db.isOpen) db.close(); });
  const project = createProject(db, 'Dọn take', '16:9', null), scene = createScene(db, { projectId: project.id });
  const job = createRenderJob(db, { projectId: project.id, sceneId: scene.id });
  const takes = Array.from({ length: 6 }, (_, index) => {
    const file = join(project.directory, 'renders', `take-${index}.mp4`); writeFileSync(file, `VIDEO-${index}`);
    return createTake(db, { renderJobId: job.id, sceneId: scene.id, file, durationSec: 8 });
  });
  updateTake(db, takes[0].id, { selected: true }); selectTake(db, scene.id, takes[1].id);
  // Historical edit/CapCut source and M6 review take remain in use.
  db.exec(`CREATE TABLE render_reviews(step_id TEXT, scene_id TEXT, suggestion TEXT, owner_override TEXT)`);
  db.prepare('INSERT INTO render_reviews VALUES (?,?,?,NULL)').run('step', scene.id, JSON.stringify({ takeId: takes[2].id }));
  const dir = join(project.directory, 'exports', 'capcut'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'draft_content.json'), JSON.stringify({ materials: { videos: [{ path: takes[3].file }] } }));
  return { ...fs, db, project, scene, takes };
}
test('cleanup lists only unused takes, requires exact owner confirmation and preserves selected files', t => {
  const { db, home, project, takes } = takesFixture(t), service = createMaintenanceService(db, home);
  const plan = service.listUnselectedTakes(project.id);
  assert.deepEqual(plan.takes.map(t => t.takeId).sort(), takes.slice(4).map(t => t.id).sort());
  assert.equal(plan.totalSize, 14);
  const allExist = () => takes.forEach(t => assert.equal(existsSync(t.file), true)); allExist();
  assert.throws(() => service.deleteTakes(plan), /xác nhận/); allExist();
  assert.throws(() => service.deleteTakes(plan, 'sai')); allExist();
  const altered = { ...plan, takes: plan.takes.slice(1) };
  assert.throws(() => service.deleteTakes(altered, plan.confirmation), /thay đổi/); allExist();
  const anotherProject = createProject(db, 'Khác', '16:9', null);
  const another = service.listUnselectedTakes(anotherProject.id);
  assert.throws(() => service.deleteTakes(plan, another.confirmation)); allExist();
  assert.deepEqual(service.deleteTakes(plan, plan.confirmation), { deleted: 2, bytes: 14 });
  takes.forEach((take, i) => assert.equal(existsSync(take.file), i < 4));
  assert.equal(service.listUnselectedTakes(project.id).takes.length, 0);
  assert.throws(() => service.deleteTakes(plan, plan.confirmation), /thay đổi/);
});
test('cleanup rechecks selection and file content before deleting any file', t => {
  const { db, home, project, takes } = takesFixture(t);
  const plan = listUnselectedTakes(db, project.id, home);
  updateTake(db, takes[4].id, { selected: true });
  assert.throws(() => deleteTakes(db, plan, plan.confirmation, home), /thay đổi/);
  takes.forEach(t => assert.equal(existsSync(t.file), true));
  updateTake(db, takes[4].id, { selected: false });
  writeFileSync(takes[5].file, 'CHANGED');
  assert.throws(() => deleteTakes(db, plan, plan.confirmation, home), /thay đổi/);
  takes.forEach(t => assert.equal(existsSync(t.file), true));
});

test('timeline references, including source paths without a take ID, protect takes', t => {
  const { db, home, project, takes } = takesFixture(t);
  db.prepare('INSERT INTO timeline(id,project_id,created_at,revision) VALUES (?,?,?,1)').run('tl', project.id, '');
  db.prepare('INSERT INTO timeline_track(id,timeline_id,kind,"order") VALUES (?,?,?,0)').run('tr', 'tl', 'video');
  const insert = db.prepare(`INSERT INTO timeline_clip(id,track_id,take_id,source_path,in_point,out_point,timeline_start,duration,"order")
    VALUES (?,'tr',?,?,0,1,?,1,?)`);
  insert.run('clip4', takes[4].id, takes[4].file, 0, 0);
  insert.run('clip5', null, takes[5].file, 1, 1);
  assert.equal(listUnselectedTakes(db, project.id, home).takes.length, 0);
  takes.forEach(take => assert.equal(existsSync(take.file), true));
});

test('restore into nonempty directory requires explicit option and never overwrites files', async t => {
  const { base, home, put } = fixture(t);
  put('data', 'original'); const archive = join(base, 'a.vfb'), target = join(base, 'target');
  await backup(home, archive); mkdirSync(target); writeFileSync(join(target, 'unrelated'), 'keep');
  await assert.rejects(restore(archive, target), /trống/);
  await restore(archive, target, { allowNonEmpty: true });
  assert.equal(readFileSync(join(target, 'data'), 'utf8'), 'original');
  await assert.rejects(restore(archive, target, { allowNonEmpty: true }), /tồn tại/);
  assert.equal(readFileSync(join(target, 'unrelated'), 'utf8'), 'keep');
});

test('backup skips symlinks with a log and restore rejects target symlink escape', async t => {
  const { base, home, put } = fixture(t);
  const outside = join(base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private'), 'private');
  try { symlinkSync(outside, join(home, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Không có quyền tạo liên kết tượng trưng'); return; }
    throw error;
  }
  put('data', 'ok'); const logs: string[] = [], archive = join(base, 'a.vfb');
  const manifest = await backup(home, archive, { onSkip: message => logs.push(message) });
  assert.deepEqual(manifest.files.map(f => f.path), ['data']); assert.equal(logs.length, 1);
  const target = join(base, 'target'); mkdirSync(target);
  symlinkSync(outside, join(target, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(archive, handcrafted('link/escaped'));
  await assert.rejects(restore(archive, target, { allowNonEmpty: true }));
  assert.equal(existsSync(join(outside, 'escaped')), false);
});
