import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server, request } from 'node:http';
import { connect } from 'node:net';
import { createMcpServer } from '../src/app/mcp/server.ts';
import { createMcpLifecycle } from '../src/app/mcp/lifecycle.ts';
import { configureMcp, createMcpSettingsStore } from '../src/app/mcp/settings.ts';
import { temporaryDatabase } from './helpers.ts';
import type { McpSettings } from '../src/app/mcp/settings.ts';
import type { Services } from '../src/app/ipc.ts';

const privateValue = 'private-value-never-return';
const services: Services = {
  listCommands: () => [{ name: 'project.list', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: {} }],
  async execute() { return { ok: true, data: { nested: [{ token: privateValue, cookie: privateValue, session: privateValue, storageState: privateValue, apiKey: privateValue, safe: privateValue }] } }; },
};
const payload = (method = 'ping', params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
async function refused(port: number) {
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
}

test('real MCP HTTP enforces authentication, Origin, Host, transport and JSON-RPC', async t => {
  let settings: McpSettings = { mcp: { enabled: true, port: 0, token: privateValue } };
  const listen = t.mock.method(Server.prototype, 'listen');
  const server = createMcpServer({ services, getSettings: () => settings });
  t.after(() => server.stop());
  const { port } = await server.start();
  assert.equal(listen.mock.calls[0].arguments[1], '127.0.0.1');
  // Successful start also asserts server.address().address inside the server.
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = { authorization: `Bearer ${privateValue}`, 'content-type': 'application/json' };
  const post = (body: string, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  const missing = await fetch(url, { method: 'POST' });
  assert.equal(missing.status, 401); assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await post('', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post('', { authorization: `Bearer ${'x'.repeat(privateValue.length)}` })).status, 401);
  for (const origin of ['', 'null', 'https://example.com']) assert.equal((await post('', { origin })).status, 403);
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { host: `attacker.test:${port}` } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await post(payload(), { host: `localhost:${port}` })).status, 200);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url + '/other', { method: 'POST', headers })).status, 404);
  assert.equal((await post('', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
  for (const [body, code] of [['{', -32700], ['[]', -32600], [payload('unknown'), -32601], [payload('tools/call', { name: 'project_list', arguments: [] }), -32602]] as const) {
    assert.equal((await (await post(body)).json()).error.code, code);
  }
  assert.equal((await (await post(payload())).json()).result.constructor, Object);
  const initialized = await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(initialized.status, 202); assert.equal(await initialized.text(), '');
  const init = await (await post(payload('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }))).json();
  assert.equal(init.result.serverInfo.name, 'vidflow');
  const output = await (await post(payload('tools/call', { name: 'project_list', arguments: {} }))).text();
  assert.doesNotMatch(output, /private-value-never-return|cookie|token|session|storageState|apiKey/i);
  settings = { mcp: { ...settings.mcp, enabled: false } };
  assert.equal((await post(payload())).status, 503);
  await server.stop(); assert.equal(server.isRunning(), false); await refused(port);
  settings = { mcp: { enabled: false, port } };
  assert.deepEqual(await server.start(), { port: 0 }); await refused(port);
});

test('settings generate, persist and rotate tokens and drive serialized start/stop', async t => {
  let settings: McpSettings = {};
  const listeners = new Set<() => void>();
  const store = { getSettings: () => settings, saveSettings(next: McpSettings) { settings = next; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const lifecycle = createMcpLifecycle(services, store);
  t.after(() => lifecycle.stop());
  await lifecycle.start(); assert.equal(lifecycle.isRunning(), false);
  await configureMcp(store, true);
  await lifecycle.settled(); assert.equal(lifecycle.isRunning(), true);
  const previous = settings.mcp!.token!;
  assert.equal(Buffer.from(previous, 'base64url').length, 32);
  await configureMcp(store, true, 0, true); await lifecycle.settled();
  assert.notEqual(settings.mcp!.token, previous);
  await configureMcp(store, false); await lifecycle.settled();
  assert.equal(lifecycle.isRunning(), false);
  await lifecycle.stop(); assert.equal(listeners.size, 0);
});

test('MCP settings persist in the existing database with disabled defaults', async t => {
  const db = temporaryDatabase(t);
  const store = createMcpSettingsStore(db);
  assert.equal(store.getSettings().mcp?.enabled, false);
  await configureMcp(store, true, 0);
  const restored = createMcpSettingsStore(db);
  assert.deepEqual(restored.getSettings(), store.getSettings());
  const old = store.getSettings().mcp!.token;
  await configureMcp(store, true, 0, true);
  assert.notEqual(restored.getSettings().mcp!.token, old);
});
