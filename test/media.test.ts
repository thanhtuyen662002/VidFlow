import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { assertInsideDataDir, assertSafeOutputPath, MediaToolExitError, redactSensitive,
  resetMediaToolCache, resolveFfmpeg, runFfmpeg, runFfprobe, runMediaFiles } from '../src/media/index.ts';
import { detectFfmpeg, makeTestAudio, makeTestVideo, mediaHome } from './helpers/media.ts';

test('redacts headers, query secrets, JWTs and home names', () => {
  const text = 'Authorization: Bearer auth-secret\nCookie: cookie-secret; session=session-secret\nSet-Cookie: another-secret\nBearer bearer-secret\n?token=token-secret&access_token=access-secret&key=key-secret&sig=sig-secret&signature=signature-secret&session=session-secret\nabcdefgh.ijklmnop.qrstuvwx\nC:\\Users\\SomeName\\file /home/someone/file /Users/OtherName/file';
  const result = redactSensitive(text);
  for (const secret of ['auth-secret', 'cookie-secret', 'another-secret', 'bearer-secret', 'token-secret', 'access-secret', 'key-secret', 'sig-secret', 'signature-secret', 'session-secret', 'abcdefgh', 'SomeName', 'someone', 'OtherName']) assert.ok(!result.includes(secret), secret);
  assert.ok(result.includes('[REDACTED]'));
});

test('discovery honors invalid overrides and empty PATH', t => {
  const home = mediaHome(t);
  const previous = { ...process.env };
  t.after(() => { process.env = previous; resetMediaToolCache(); });
  process.env.VIDFLOW_FFMPEG = join(home, 'missing');
  resetMediaToolCache();
  assert.throws(resolveFfmpeg, { code: 'FFMPEG_NOT_FOUND', source: 'env' });
  delete process.env.VIDFLOW_FFMPEG;
  process.env.PATH = '';
  resetMediaToolCache();
  assert.throws(resolveFfmpeg, { code: 'FFMPEG_NOT_FOUND', source: 'PATH' });
});

test('fake executable redacts diagnostics and times out without ffmpeg', async t => {
  const home = mediaHome(t);
  const previous = { ...process.env };
  const originalSpawn = childProcess.spawn;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); process.env = previous; resetMediaToolCache(); });
  const preload = join(home, 'fake.cjs');
  process.env.VIDFLOW_FFMPEG = process.execPath;
  // A Node script is the fake tool. Adapt only its executable entry point;
  // Windows cannot execute a shebang script directly without a shell.
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    if (binary === process.execPath) {
      assert.equal(options?.shell, false);
      assert.ok(args?.includes('-hide_banner'));
      assert.ok(args?.includes('-nostdin'));
      return originalSpawn(process.execPath, [preload], options);
    }
    return originalSpawn(binary, args, options);
  });
  syncBuiltinESMExports();
  resetMediaToolCache();
  writeFileSync(preload, "process.stderr.write('token=private-secret\\nCookie: cookie-secret\\n'); process.exit(7);");
  await assert.rejects(runFfmpeg([], { timeoutMs: 5000 }), error => {
    assert.ok(error instanceof MediaToolExitError);
    assert.equal(error.code, 'FFMPEG_EXIT_NONZERO');
    assert.equal(error.exitCode, 7);
    assert.ok(!JSON.stringify(error).includes('private-secret'));
    assert.ok(!error.message.includes('cookie-secret'));
    return true;
  });
  writeFileSync(preload, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); process.exit(0);');
  await assert.rejects(runFfmpeg([], { timeoutMs: 200 }), { code: 'FFMPEG_TIMEOUT', timeoutMs: 200 });
});

test('path safety rejects escapes, originals and existing outputs', async t => {
  const home = mediaHome(t);
  const project = join(home, 'projects', 'example');
  for (const directory of ['exports', 'frames', 'refs']) mkdirSync(join(project, directory), { recursive: true });
  const options = { dataDir: home, projectDir: project, inputPaths: [join(project, 'refs', 'original')] };
  for (const path of ['../escape', join(home, '..', 'outside'), 'Z:\\outside']) assert.throws(() => assertInsideDataDir(path, home), { code: 'UNSAFE_PATH' });
  assert.throws(() => assertSafeOutputPath(join(project, 'refs', 'out'), options), { code: 'UNSAFE_PATH' });
  const original = join(project, 'exports', 'original');
  writeFileSync(original, 'source');
  assert.throws(() => assertSafeOutputPath(original, { ...options, inputPaths: [original] }), { code: 'UNSAFE_PATH' });
  if (process.platform === 'win32') assert.throws(() => assertSafeOutputPath(original.toUpperCase(), { ...options, inputPaths: [original] }), { code: 'UNSAFE_PATH' });
  assert.throws(() => assertSafeOutputPath(original, options), { code: 'UNSAFE_PATH' });
  for (const part of ['exports', 'frames']) assert.equal(assertSafeOutputPath(join(project, part, 'new'), options), join(project, part, 'new'));
  assert.throws(() => runMediaFiles('ffmpeg', () => [], { ...options, inputPaths: ['../escape'], timeoutMs: 100 }), { code: 'UNSAFE_PATH' });
  await t.test('symlink escape', child => {
    try { symlinkSync(home, join(project, 'frames', 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { child.skip(`Symlink unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
    assert.throws(() => assertSafeOutputPath(join(project, 'frames', 'escape', 'out'), options), { code: 'UNSAFE_PATH' });
  });
});

test('real ffmpeg reports typed failures', async t => {
  mediaHome(t);
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  await assert.rejects(runFfmpeg(['-invalid_vidflow_option'], { timeoutMs: 10000 }), error => {
    assert.ok(error instanceof MediaToolExitError);
    assert.equal(error.code, 'FFMPEG_EXIT_NONZERO');
    assert.ok(error.exitCode !== 0);
    assert.ok(error.stderrTail.length > 0);
    return true;
  });
});

test('generated testsrc and sine can be probed', async t => {
  const home = mediaHome(t);
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  for (const file of [await makeTestVideo(home), await makeTestAudio(home)]) {
    const result = await runFfprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeoutMs: 10000 });
    const info = JSON.parse(result.stdout);
    assert.ok(Number(info.format.duration) >= 0.9);
    assert.equal(info.streams.length, 1);
  }
});
