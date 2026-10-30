import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCoreService } from '../src/service/index.ts';
import { sanitize } from '../src/service/sanitize.ts';

import { setup } from './service-fixture.ts';

function scan(value: unknown) {
  if (Array.isArray(value)) value.forEach(scan);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /cookie|token|authorization|password|secret|apikey/i); scan(child);
  }
  assert.doesNotMatch(JSON.stringify(value), /SECRET_COOKIE_VALUE|SECRET_TOKEN_VALUE/);
}

test('all registered commands validate inputs; unknown and not-found errors have fixed codes', async t => {
  const { service } = setup(t);
  for (const command of service.listCommands()) {
    for (const input of [null, [], 'wrong', 42]) {
      const result = await service.execute(command.name, input);
      assert.equal(result.ok, false, command.name);
      if (!result.ok) { assert.equal(result.error.code, 'VALIDATION_ERROR'); assert.ok(result.error.details.length); }
    }
    if (command.inputSchema.required?.length) {
      const result = await service.execute(command.name, {});
      assert.equal(result.ok, false, command.name);
      if (!result.ok) { assert.equal(result.error.code, 'VALIDATION_ERROR'); assert.ok(result.error.details.length); }
    }
    scan(command.outputSchema);
  }
  assert.deepEqual(await service.execute('missing', {}), { ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command', details: [] } });
  const missing = await service.execute('project.get', { projectId: 'missing' });
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.error.code, 'NOT_FOUND');
});

test('service-only project to package flow, every command returns safe data', async t => {
  const { service, db, deps } = setup(t);
  const called = new Set<string>();
  async function run<T = Record<string, unknown>>(name: string, input: unknown): Promise<T> {
    called.add(name);
    const result = await service.execute(name, input); scan(result);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error('Failed command');
    const schema = service.listCommands().find(c => c.name === name)!.outputSchema;
    assert.ok(schema.type);
    return result.data as T;
  }
  const p = await run<{ id: string; directory: string }>('project.create', { name: 'Garden', aspect: '16:9', budget: 1000 });
  await run('project.list', {}); await run('project.get', { projectId: p.id });
  await run('reference.add', { projectId: p.id, name: 'Lan', kind: 'character', images: ['refs/lan.png'], description: 'Original gardener', priority: 1 });
  await run('reference.list', { projectId: p.id });
  await run('bible.update', { projectId: p.id, fields: { style: 'Cinematic' } });
  const variants = await run<{ id: string }[]>('script.generate', { projectId: p.id, brief: 'Garden', count: 1 });
  const scriptId = variants[0].id;
  await run('script.score', { projectId: p.id, reviewerModel: 'fake' });
  const revision = await run<{ version: { id: string } }>('script.revise', { scriptId, baseVersionId: scriptId, feedback: ['Improve'], reviewerModel: 'fake' });
  const versionId = revision.version.id;
  const warnings = await run<{ id: string }[]>('script.review', { scriptId, versionId });
  assert.ok(warnings.length);
  for (const warning of warnings) await run('script.override', { scriptId, versionId, warningId: warning.id, reason: 'Rights cleared for this test' });
  await run('script.approve', { scriptId, versionId });
  const board = await run<{ id: string; planId: string }>('storyboard.generate', { variantId: versionId });
  await run('storyboard.get', { storyboardId: board.id });
  const shots = await run<{ shots: { sceneId: string }[] }>('storyboard.get', { storyboardId: board.id });
  const preview = await run<{ args: string[] }>('storyboard.preview', { storyboardId: board.id, images: shots.shots.map(s => ({ sceneId: s.sceneId, path: join(p.directory, 'refs', 'lan.png'), duration: 3 })) });
  assert.ok(preview.args.includes('-loop'));
  const refused = await service.execute('render.enqueue', { storyboardId: board.id });
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.error.code, 'PRECONDITION_FAILED');
  await run('storyboard.approve', { storyboardId: board.id });
  // Approval persists through service recreation with the same storage.
  const reopened = createCoreService(deps);
  assert.equal((await reopened.execute('render.enqueue', { storyboardId: board.id })).ok, true);
  const plan = await run<{ id: string; steps: { id: string; sceneId: string }[] }>('render.enqueue', { storyboardId: board.id });
  const account = await run<{ id: string }>('account.create', { label: 'Fake' });
  // Adversarial stored fields must not escape the safe account metadata projection.
  db.prepare('UPDATE flow_accounts SET status_reason=? WHERE id=?').run(JSON.stringify({ cookie: 'SECRET_COOKIE_VALUE', token: 'SECRET_TOKEN_VALUE' }), account.id);
  await run('account.list', {});
  await run('account.status', { accountId: account.id, status: 'ready' });
  await run('credit.add', { accountId: account.id, amount: 500, reason: 'Owner funding' });
  await run('credit.list', { accountId: account.id });
  await run('render.run', { planId: plan.id, storyboardId: board.id, takesPerScene: 2 });
  await run('render.status', { planId: plan.id }); await run('queue.list', {});
  db.prepare('UPDATE takes SET metadata=?').run(JSON.stringify({ Cookie: 'SECRET_COOKIE_VALUE', accessToken: 'SECRET_TOKEN_VALUE', nested: [{ safe: 'SECRET_TOKEN_VALUE', authorization: 'SECRET_COOKIE_VALUE' }], content: JSON.stringify({ refreshToken: 'SECRET_TOKEN_VALUE' }) }));
  const takes = await run<{ id: string; sceneId: string }[]>('take.list', { planId: plan.id });
  assert.equal(takes.length, 4);
  for (const step of plan.steps) await run('take.select', { stepId: step.id, takeId: takes.find(take => take.sceneId === step.sceneId)!.id, inPoint: 0.5, outPoint: 2.5 });
  const timeline = await run<{ id: string; tracks: { kind: string; clips: unknown[] }[] }>('edit.assemble', { projectId: p.id });
  assert.equal(timeline.tracks.find(track => track.kind === 'video')!.clips.length, 2);
  await run('edit.capcut', { timelineId: timeline.id, aspect: '16:9' });
  const audio = await run<{ path: string }>('audio.mix', { projectId: p.id, durationSec: 4, output: join(p.directory, 'exports', 'mixed.wav') });
  const video = await run<{ path: string }>('edit.export', { timelineId: timeline.id, aspect: '16:9', mixedAudioPath: audio.path });
  const coverPath = join(p.directory, 'frames', 'cover.png'); writeFileSync(coverPath, 'fake image');
  const packaged = await run<{ directory: string; manifest: { files: unknown[] } }>('export.package', { timelineId: timeline.id, videos: [{ aspect: '16:9', path: video.path }], coverPath, llmModel: 'fake' });
  assert.ok(packaged.manifest.files.length);
  assert.ok(JSON.parse(readFileSync(join(packaged.directory, 'manifest.json'), 'utf8')).files.length);
  await run('bible.get', { projectId: p.id });
  assert.equal(await run('reference.remove', { projectId: p.id, refId: 'missing' }), false);
  const gate = await run<{ options: { versionId: string; risks: unknown[] }[]; canApprove: boolean }>('script.getGate', { projectId: p.id });
  assert.ok(gate.options.some(option => option.versionId === versionId));
  const blankSkip = await service.execute('script.skip', { projectId: p.id, reason: '   ' });
  assert.equal(blankSkip.ok, false);
  await run('script.skip', { projectId: p.id, reason: 'Owner reason' });
  assert.deepEqual([...called].sort(), service.listCommands().map(c => c.name).sort());
  await run('bible.update', { projectId: p.id, fields: { style: 'Changed lighting' } });
  const stale = await service.execute('render.run', { planId: plan.id, storyboardId: board.id });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, 'PRECONDITION_FAILED');
  const regenerated = await run<{ id: string; status: string }>('storyboard.generate', { variantId: versionId });
  assert.notEqual(regenerated.id, board.id); assert.equal(regenerated.status, 'draft');
  const pending = await service.execute('render.enqueue', { storyboardId: regenerated.id });
  assert.equal(pending.ok, false); if (!pending.ok) assert.equal(pending.error.code, 'PRECONDITION_FAILED');
  const traversal = await service.execute('audio.mix', { projectId: p.id, durationSec: 4, output: '../outside.wav' });
  scan(traversal); assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.error.code, 'VALIDATION_ERROR');
  deps.llm.complete = async () => { throw new Error('cookie=SECRET_COOKIE_VALUE token=SECRET_TOKEN_VALUE'); };
  const failure = await service.execute('script.generate', { projectId: p.id, brief: 'Fail', count: 1 });
  scan(failure); assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.code, 'INTERNAL_ERROR');
  deps.media!.exportFinal = async () => ({ path: 42 as unknown as string, srtPath: 'unused', width: 1, height: 1,
    loudness: { integratedLufs: -14, truePeak: -1 }, capcutDraft: { ok: true, path: 'unused' }, warnings: [] });
  const invalidOutput = await service.execute('edit.export', { timelineId: timeline.id, aspect: '16:9', mixedAudioPath: audio.path });
  scan(invalidOutput); assert.equal(invalidOutput.ok, false);
  if (!invalidOutput.ok) assert.equal(invalidOutput.error.code, 'INTERNAL_ERROR');
});

test('sanitization removes nested sensitive keys, serialized data and echoed values', () => {
  scan(sanitize({ Cookie: 'SECRET_COOKIE_VALUE', nested: [{ accessToken: 'SECRET_TOKEN_VALUE', safe: 'SECRET_TOKEN_VALUE' }], content: JSON.stringify({ authorization: 'SECRET_TOKEN_VALUE', safe: 'ok' }) }, ['SECRET_COOKIE_VALUE','SECRET_TOKEN_VALUE']));
});

test('service sources and their transitive imports have no Electron dependency', () => {
  const visited = new Set<string>();
  function inspect(path: string) {
    if (visited.has(path)) return; visited.add(path);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:node:)?electron(?:\/[^'"]*)?['"]/i);
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+\.ts)['"]/g)) inspect(join(path, '..', match[1]));
  }
  for (const name of readdirSync('src/service')) if (name.endsWith('.ts')) inspect(join('src/service', name));
});
