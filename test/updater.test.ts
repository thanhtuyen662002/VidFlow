import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater, compareVersions, fetchUpdate, githubRedirect } from '../src/app/updater.ts';
import { withUpdates } from '../src/app/update-service.ts';
import { createMcpTools } from '../src/app/mcp/tools.ts';
import { createIpcHandlers } from '../src/app/ipc.ts';

test('dev updater: loopback manifest, download, integrity and owner gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vidflow-update-'));
  const previous = process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME = directory;
  const binary = Buffer.from('fake Windows installer');
  let manifest = { version: '1.2.0-dev.3', url: '/installer.exe', sha256: createHash('sha256').update(binary).digest('hex').toUpperCase(), size: binary.length, releaseNotes: 'Bản thử nghiệm' };
  const server = createServer((req, res) => {
    if (req.url === '/dev.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifest)); }
    else if (req.url === '/installer.exe') res.end(binary);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous;
  });
  const sourceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/dev.json`;
  let spawned: string[] = [];
  const make = (confirm?: () => Promise<boolean>) => createUpdater({ config: () => ({ channel: 'dev', sourceUrl }),
    currentVersion: '1.2.0-dev.2', directory, confirm, install: async file => { spawned.push(file); } });
  await t.test('newer version, verified download, missing confirmation', async () => {
    const updater = make();
    assert.equal((await updater.check())?.version, manifest.version);
    const result = await updater.download();
    assert.equal(result.state, 'downloaded');
    assert.deepEqual(await readFile(result.file!), binary);
    assert.equal(updater.status().received, binary.length);
    assert.equal((await updater.check())?.version, manifest.version);
    assert.equal(updater.status().file, result.file, 'rechecking the same release keeps the verified installer');
    await updater.install(); assert.deepEqual(spawned, []);
    assert.equal(updater.status().state, 'downloaded');
  });
  await t.test('same and older versions are ignored', async () => {
    for (const remote of ['1.2.0-dev.2', '1.2.0-dev.1', '1.1.9']) {
      manifest.version = remote; assert.equal(await make().check(), null);
    }
    manifest.version = '1.2.0-dev.3';
  });
  await t.test('wrong checksum removes partial file and refuses installation', async () => {
    const before = await readdir(directory), original = manifest.sha256;
    manifest.sha256 = '0'.repeat(64);
    const updater = make(async () => true); await updater.check();
    await assert.rejects(updater.download(), { code: 'CHECKSUM_MISMATCH' });
    assert.deepEqual(await readdir(directory), before);
    await assert.rejects(updater.install(), { code: 'UPDATE_NOT_READY' });
    assert.deepEqual(spawned, []); manifest.sha256 = original;
  });
  await t.test('refusal via IPC and MCP cannot bypass owner confirmation', async () => {
    const updater = make(async () => false); await updater.check(); await updater.download();
    const services = withUpdates({ listCommands: () => [], execute: async () => { throw new Error('unexpected'); } }, updater);
    const ipc = createIpcHandlers(services), mcp = createMcpTools(services);
    assert.equal((await ipc.handleInvoke('update:install', {})).ok, true);
    assert.equal((await mcp.call('update_install', {}))?.isError, false);
    assert.equal((await ipc.handleInvoke('update:install', { confirmed: true })).ok, false);
    assert.deepEqual(spawned, []); assert.equal(updater.status().state, 'downloaded');
  });
  await t.test('confirmation launches exactly once', async () => {
    const updater = make(async () => true); await updater.check(); const downloaded = await updater.download();
    await updater.install(); assert.deepEqual(spawned, [downloaded.file]);
    await assert.rejects(updater.install(), { code: 'UPDATE_NOT_READY' }); spawned = [];
  });
  await t.test('changed artifact is rechecked before launch', async () => {
    const updater = make(async () => true); await updater.check(); const downloaded = await updater.download();
    await writeFile(downloaded.file!, 'tampered');
    await assert.rejects(updater.install(), { code: 'CHECKSUM_MISMATCH' }); assert.deepEqual(spawned, []);
  });
  await t.test('size mismatch and HTTP failure clean up', async () => {
    const before = await readdir(directory);
    manifest.size++; let updater = make(); await updater.check();
    await assert.rejects(updater.download(), { code: 'SIZE_MISMATCH' }); manifest.size--;
    manifest.url = '/missing'; updater = make(); await updater.check();
    await assert.rejects(updater.download(), { code: 'HTTP_ERROR' }); manifest.url = '/installer.exe';
    assert.deepEqual(await readdir(directory), before);
  });
});

test('semver numeric prereleases, release precedence and invalid versions', () => {
  assert.equal(compareVersions('1.2.0-dev.10', '1.2.0-dev.3'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0-dev.99'), 1);
  assert.equal(compareVersions('1.2.0+build', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-1', '1.2.0-dev'), -1);
  assert.throws(() => compareVersions('1.2.0-dev.01', '1.2.0'));
});

test('redirects are followed only to trusted hosts', async t => {
  const server = createServer((req, res) => {
    const hop = (location: string) => { res.writeHead(302, { Location: location }); res.end(); };
    if (req.url === '/latest') hop('/asset');
    else if (req.url === '/asset') res.end('installer');
    else if (req.url === '/away') hop('http://example.invalid/installer');
    else if (req.url === '/loop') hop('/loop');
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const loopback = (url: URL) => url.hostname === '127.0.0.1';
  let body = ''; for await (const chunk of await fetchUpdate(`${base}/latest`, loopback)) body += chunk;
  assert.equal(body, 'installer');
  await assert.rejects(fetchUpdate(`${base}/latest`), { code: 'UNTRUSTED_REDIRECT' });
  await assert.rejects(fetchUpdate(`${base}/away`, loopback), { code: 'UNTRUSTED_REDIRECT' });
  await assert.rejects(fetchUpdate(`${base}/loop`, loopback), { code: 'TOO_MANY_REDIRECTS' });
  assert.equal(githubRedirect(new URL('https://release-assets.githubusercontent.com/x')), true);
  assert.equal(githubRedirect(new URL('https://github.com/thanhtuyen662002/VidFlow/releases')), true);
  assert.equal(githubRedirect(new URL('http://github.com/x')), false);
  assert.equal(githubRedirect(new URL('https://github.com.example.net/x')), false);
});
