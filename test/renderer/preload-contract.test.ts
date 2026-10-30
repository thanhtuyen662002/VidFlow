import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { VidFlowApi } from '../../renderer/src/api.ts';
import { mockApi } from './mockApi.ts';

test('real sandbox preload covers the typed renderer mock and named IPC channels', async () => {
  let api: VidFlowApi;
  const calls: unknown[][] = [];
  let failure = false;
  runInNewContext(readFileSync('src/app/preload.cjs', 'utf8'), {
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(key: string, value: VidFlowApi) { assert.equal(key, 'vidflow'); api = value; } },
        ipcRenderer: { invoke: async (...args: unknown[]) => {
          calls.push(args);
          return failure ? { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Chưa hỗ trợ' } } : { ok: true, data: [] };
        } },
      };
    },
  });
  const mock: VidFlowApi = mockApi();
  for (const [group, methods] of Object.entries(mock)) {
    for (const method of Object.keys(methods)) assert.equal(typeof api![group][method], 'function', `${group}.${method}`);
  }
  await api!.projects.list();
  await api!.projects.create({ name: 'Phim' });
  await api!.bible.get('p');
  await api!.bible.update('p', { style: 'Mực' });
  await api!.references.list('p');
  await api!.references.add('p', { name: 'Lan', role: 'character', images: ['refs/lan.png'], description: 'Lan', priority: 0 });
  await api!.references.remove('p', 'r');
  await api!.script.getGate('p');
  await api!.script.approve('p', { scriptId: 's', versionId: 'v' });
  await api!.script.skip('p', { reason: 'Có quyền sử dụng' });
  assert.deepEqual(calls.map(c => c[0]), ['project:list','project:create','bible:get','bible:update','reference:list','reference:add','reference:remove','script:getGate','script:approve','script:skip']);
  // Serialize VM objects before checking their fields across realms.
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['script:skip', { projectId: 'p', reason: 'Có quyền sử dụng' }]);
  failure = true;
  await assert.rejects(api!.script.getGate('p'), error => error.code === 'NOT_SUPPORTED');
});
