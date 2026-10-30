import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { unwrap } from '../../renderer/src/workflow.ts';
import type { WorkflowApi } from '../../renderer/src/workflow.ts';

test('workflow uses the existing sandbox preload channels and preserves core results', async () => {
  let api: WorkflowApi;
  const calls: unknown[][] = [];
  runInNewContext(readFileSync('src/app/preload.cjs', 'utf8'), {
    require() { return {
      contextBridge: { exposeInMainWorld(_name: string, value: WorkflowApi) { api = value; } },
      ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true, data: { id: 'core-id' } }; } },
    }; },
  });
  assert.equal((await unwrap(api!.storyboard.generate({ variantId: 'approved-version' }))).id, 'core-id');
  await unwrap(api!.storyboard.approve({ storyboardId: 'board' }));
  await unwrap(api!.render.enqueue({ storyboardId: 'board' }));
  await unwrap(api!.render.run({ storyboardId: 'board', planId: 'plan' }));
  await unwrap(api!.render.status({ planId: 'plan' }));
  await unwrap(api!.take.list({ planId: 'plan' }));
  await unwrap(api!.take.select({ stepId: 'step', takeId: 'take', inPoint: 1, outPoint: 4 }));
  await unwrap(api!.edit.assemble({ projectId: 'project' }));
  await unwrap(api!.edit.capcut({ timelineId: 'timeline', aspect: '9:16' }));
  await unwrap(api!.edit.export({ timelineId: 'timeline', aspect: '16:9', mixedAudioPath: 'exports/audio.wav' }));
  await unwrap(api!.account.list({}));
  await unwrap(api!.queue.list({}));
  assert.deepEqual(calls.map(call => call[0]), ['storyboard:generate', 'storyboard:approve', 'render:enqueue', 'render:run', 'render:status', 'take:list', 'take:select', 'edit:assemble', 'edit:capcut', 'edit:export', 'account:list', 'queue:list']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[6])), ['take:select', { stepId: 'step', takeId: 'take', inPoint: 1, outPoint: 4 }]);
});

test('workflow failures do not forward dependency messages containing secrets', async () => {
  await assert.rejects(unwrap(Promise.resolve({ ok: false, error: { message: 'sample-cookie-secret sample-token-secret' } })), error => {
    assert.doesNotMatch(String(error), /sample-cookie-secret|sample-token-secret/);
    return true;
  });
});
