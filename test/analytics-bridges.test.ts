import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setup } from './service-fixture.ts';
import { createIpcHandlers } from '../src/app/ipc.ts';
import { createMcpTools } from '../src/app/mcp/tools.ts';
import { createMcpServer } from '../src/app/mcp/server.ts';
import type { VidflowApi } from '../src/app/api.ts';

test('sandbox preload, IPC and MCP expose all registry commands including analytics and templates', async t => {
  const { service } = setup(t);
  const expected = service.listCommands().map(c => c.name).sort();
  assert.ok(expected.includes('template.save'));
  const source = readFileSync(new URL('../src/app/preload.cjs', import.meta.url), 'utf8');
  const channels = [...new Set([...source.matchAll(/(?:invoke|unwrap)\('([\w]+:[\w]+)'/g)].map(m => m[1]))];
  assert.deepEqual(channels.map(c => c.replace(':', '.')).sort(), expected);
  assert.deepEqual(createIpcHandlers(service).channels.map(c => c.replace(':', '.')).sort(), expected);
  const tools = createMcpTools(service);
  assert.deepEqual(tools.list().map(c => c.name.replace('_', '.')).sort(), expected);
  for (const command of service.listCommands()) {
    assert.deepEqual(tools.list().find(tool => tool.name === command.name.replace('.', '_'))!.inputSchema, command.inputSchema);
  }

  let api!: VidflowApi;
  const calls: unknown[][] = [];
  runInNewContext(source, { require(name: string) {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld(_key: string, value: VidflowApi) { api = value; } },
      ipcRenderer: { async invoke(...args: unknown[]) { calls.push(args); return { ok: true, data: [] }; } },
    };
  } });
  await api.analytics.import({ projectId: 'p', timelineId: 't', csvPath: 'analytics.csv' });
  await api.analytics.list({ projectId: 'p' });
  await api.analytics.accept({ id: 'proposal' });
  await api.analytics.reject({ id: 'proposal' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['analytics:import', { projectId: 'p', timelineId: 't', csvPath: 'analytics.csv' }],
    ['analytics:list', { projectId: 'p' }],
    ['analytics:accept', { id: 'proposal' }],
    ['analytics:reject', { id: 'proposal' }],
  ]);
});

test('analytics bridge validation uses structured service errors for missing and invalid fields', async t => {
  const { service } = setup(t);
  const tools = createMcpTools(service);
  const ipc = createIpcHandlers(service);
  for (const name of ['analytics.import', 'analytics.list', 'analytics.accept', 'analytics.reject', 'storyboard.reject']) {
    for (const input of [{}, { id: 123 }, { token: 'PRIVATE_SENTINEL' }]) {
      const expected = await service.execute(name, input);
      assert.equal(expected.ok, false);
      const result = await tools.call(name.replace('.', '_'), input);
      assert.equal(result!.isError, true);
      assert.deepEqual(JSON.parse(result!.content[0].text), expected.ok ? undefined : expected.error);
      const response = await ipc.handleInvoke(name.replace('.', ':'), input);
      assert.equal(response.ok, false);
      assert.doesNotMatch(JSON.stringify([result, response]), /PRIVATE_SENTINEL|stack|[A-Z]:\\/);
    }
  }
});

test('MCP HTTP lists all registry commands and safely calls every analytics command', async t => {
  const { service } = setup(t);
  const token = 'analytics-test-private-value';
  const server = createMcpServer({ services: service, getSettings: () => ({ mcp: { enabled: true, port: 0, token } }) });
  t.after(() => server.stop());
  const { port } = await server.start();
  const rpc = async (method: string, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined);
    assert.doesNotMatch(JSON.stringify(body), /analytics-test-private-value|[A-Z]:\\/);
    return body.result;
  };
  const listed = await rpc('tools/list');
  assert.equal(listed.tools.length, service.listCommands().length);
  assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name.replace('_', '.')).sort(), service.listCommands().map(c => c.name).sort());
  for (const method of ['accept', 'import', 'list', 'reject']) {
    const result = await rpc('tools/call', { name: `analytics_${method}` });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'VALIDATION_ERROR');
  }
});
