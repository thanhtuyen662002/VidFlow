import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './service-fixture.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createRenderJob, createTake } from '../src/repo/renders.ts';
import { createMcpServer } from '../src/app/mcp/server.ts';
import { withUpdates } from '../src/app/update-service.ts';
import { createUpdater } from '../src/app/updater.ts';
import { backup } from '../src/service/archive.ts';
import { runM9Command } from '../src/service/m9-cli.ts';
import { createMaintenanceService } from '../src/service/maintenance.ts';
import { DatabaseSync } from 'node:sqlite';

test('every M9 tool rejects missing/wrong tokens before dispatch; prune requires reviewed plan and exact true', async t => {
  const { service, db } = setup(t);
  const home = process.env.VIDFLOW_HOME!;
  const project = createProject(db, 'Prune', '16:9', null);
  const scene = createScene(db, { projectId: project.id });
  const job = createRenderJob(db, { projectId: project.id, sceneId: scene.id });
  const file = join(project.directory, 'renders', 'unused.mp4');
  writeFileSync(file, 'original');
  const take = createTake(db, { sceneId: scene.id, renderJobId: job.id, file });
  const wrapped = withUpdates(service, createUpdater({ config: () => ({ channel: 'dev', sourceUrl: '' }), currentVersion: '0.1.0', directory: join(home, 'updates') }));
  let dispatched = 0;
  const execute = wrapped.execute.bind(wrapped);
  const server = createMcpServer({ services: { ...wrapped, execute: async (name, input) => { dispatched++; return execute(name, input); } }, getSettings: () => ({ mcp: { enabled: true, token: 'm9-private', port: 0 } }) });
  t.after(() => server.stop());
  const { port } = await server.start();
  const call = (name: string, input: unknown, token?: string) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) });
  const names = wrapped.listCommands().filter(c => /^(analytics|template|archive|takes|update)\./.test(c.name)).map(c => c.name.replaceAll('.', '_'));
  for (const name of names) for (const token of [undefined, 'wrong']) assert.equal((await call(name, {}, token)).status, 401, name);
  assert.equal(dispatched, 0);
  const rpc = async (name: string, input: unknown) => {
    const body = await (await call(name, input, 'm9-private')).json();
    assert.equal(body.result.isError, false, JSON.stringify(body));
    return JSON.parse(body.result.content[0].text);
  };
  const plan = await rpc('takes_prunePreview', { projectId: project.id });
  assert.deepEqual(plan.takes.map((v: { takeId: string }) => v.takeId), [take.id]);
  for (const confirm of [undefined, false]) {
    const result = await rpc('takes_pruneApply', { projectId: project.id, planId: plan.planId, ...(confirm === undefined ? {} : { confirm }) });
    assert.equal(result.deleted, 0); assert.equal(existsSync(file), true); assert.equal(readFileSync(file, 'utf8'), 'original');
  }
  for (const input of [{ projectId: project.id, confirm: true }, { projectId: project.id, planId: 'wrong', confirm: true }]) {
    const body = await (await call('takes_pruneApply', input, 'm9-private')).json();
    assert.equal(body.result.isError, true);
    assert.equal(existsSync(file), true);
  }
  assert.equal((await rpc('takes_pruneApply', { projectId: project.id, planId: plan.planId, confirm: true })).deleted, 1);
  assert.equal(existsSync(file), false);
});

test('service restore refuses existing files, including allowNonEmpty, and preserves bytes', async t => {
  const { service } = setup(t), home = process.env.VIDFLOW_HOME!;
  const source = join(home, 'source'), targetDir = join(home, 'restored');
  mkdirSync(source); mkdirSync(targetDir);
  writeFileSync(join(source, 'original.txt'), 'backup');
  writeFileSync(join(targetDir, 'original.txt'), 'old bytes');
  await backup(source, join(home, 'copy.vfb'));
  for (const allowNonEmpty of [false, true]) {
    const result = await service.execute('archive.restore', { file: 'copy.vfb', targetDir, allowNonEmpty });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /Thư mục đích/);
    assert.equal(readFileSync(join(targetDir, 'original.txt'), 'utf8'), 'old bytes');
  }
});

test('CLI prune without --yes only previews', async t => {
  const { db } = setup(t);
  const project = createProject(db, 'Preview CLI', '16:9', null);
  let output = '';
  const io = { stdout: { write: (s: string) => { output += s; return true; } }, stderr: { write: (s: string) => { output += s; return true; } } };
  assert.equal(await runM9Command(['takes', 'prune', project.id], io), 0);
  assert.match(output, /Chưa xóa take/);
});

test('cleanup service and CLI require confirmation plus a valid reviewed plan; reopening keeps plan IDs valid', async t => {
  const { db } = setup(t);
  const project = createProject(db, 'Confirmed cleanup', '16:9', null);
  const scene = createScene(db, { projectId: project.id });
  const job = createRenderJob(db, { projectId: project.id, sceneId: scene.id });
  const file = join(project.directory, 'renders', 'unused.mp4');
  writeFileSync(file, 'keep until confirmed');
  createTake(db, { sceneId: scene.id, renderJobId: job.id, file });
  const maintenance = createMaintenanceService(db);
  const plan = maintenance.planTakeCleanup(project.id);
  for (const confirm of [undefined, false]) {
    assert.throws(() => maintenance.executeTakeCleanup({ projectId: project.id, planId: plan.planId, confirm }), /CONFIRMATION_REQUIRED/);
    assert.equal(existsSync(file), true);
  }
  let output = '';
  const io = { stdout: { write: (s: string) => { output += s; return true; } }, stderr: { write: (s: string) => { output += s; return true; } } };
  for (const flags of [['--yes'], ['--yes', '--plan-id', 'wrong'], ['--plan-id', plan.planId]]) {
    await runM9Command(['cleanup-takes', project.id, ...flags], io);
    assert.equal(existsSync(file), true);
  }
  assert.equal(await runM9Command(['cleanup-takes', project.id, '--yes', '--plan-id', plan.planId], io), 0, output);
  assert.equal(existsSync(file), false);
});

test('service backup and restore round-trip project data without overwriting the source', async t => {
  const { service } = setup(t);
  const sourceHome = process.env.VIDFLOW_HOME!;
  const project = await service.execute('project.create', { name: 'Round-trip', aspect: '16:9' });
  assert.equal(project.ok, true);
  assert.equal((await service.execute('archive.backup', { file: 'round-trip.vfb' })).ok, true);
  // Restore into an independent sibling of the backed-up source.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const targetDir = mkdtempSync(join(tmpdir(), 'vidflow-roundtrip-'));
  t.after(() => rmSync(targetDir, { recursive: true, force: true }));
  assert.equal((await service.execute('archive.restore', { file: 'round-trip.vfb', targetDir })).ok, true);
  const restored = new DatabaseSync(join(targetDir, 'vidflow.db'));
  try { assert.equal(restored.prepare('SELECT name FROM projects').get()!.name, 'Round-trip'); }
  finally { restored.close(); }
  assert.equal(existsSync(join(sourceHome, 'vidflow.db')), true);
});
