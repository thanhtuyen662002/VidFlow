import { mockApi } from './mockApi.ts';
import type { WorkflowApi, WorkflowControls } from '../../renderer/src/workflow.ts';

export function workflowFake() {
  const base = mockApi();
  const calls: { name: string; input: unknown }[] = [];
  const record = (name: string, input: unknown) => calls.push({ name, input });
  for (const [group, method, name] of [['projects', 'create', 'project.create'], ['references', 'add', 'reference.add'], ['script', 'approve', 'script.approve']] as const) {
    const fn = base[group][method] as any;
    // Keep the M8.4 mock contract and record mutations in the shared call log.
    const implementation = fn.mock;
    if (group === 'projects') implementation.mockImplementation(async input => {
      record(name, input); const project = { id: 'p2', name: input.name };
      base.projects.list.mock.mockImplementation(async () => [project]); return project;
    });
    if (group === 'references') implementation.mockImplementation(async (projectId, input) => {
      record(name, { projectId, ...input }); const ref = { id: 'ref', project_id: projectId, ...input };
      base.references.list.mock.mockImplementation(async () => [ref]); return ref;
    });
    if (group === 'script') implementation.mockImplementation(async (projectId, input) => {
      record(name, { projectId, ...input });
      const previous = await base.script.getGate(projectId);
      base.script.getGate.mock.mockImplementation(async () => ({ ...previous, status: 'Đã duyệt', canApprove: false }));
    });
  }
  const shot = { id: 'step', sceneId: 'scene', chainId: 'chain', compiledPrompt: 'Lan đi qua khu vườn, ánh sáng buổi sáng', status: 'ready' };
  let board = { id: 'board', planId: 'plan', status: 'draft', shots: [shot] };
  let plan = { id: 'plan', status: 'ready', estimatedCredits: 20, steps: [shot] };
  let selected = false;
  let settings = { enabled: false, credentialConfigured: false, credentialLocation: 'Cơ sở dữ liệu riêng của VidFlow' };
  let budget = { used: 0, limit: 100 as number | null };
  const listeners = new Set<(event: { jobId: string; status: string }) => void>();
  let finish: (() => void) | undefined;
  const reply = async <T,>(name: string, input: unknown, data: T) => { record(name, input); return { ok: true as const, data: structuredClone(data) }; };
  const workflow: WorkflowApi & WorkflowControls = {
    storyboard: {
      generate: input => reply('storyboard.generate', input, board),
      approve: input => { board = { ...board, status: 'approved' }; return reply('storyboard.approve', input, board); },
      reject: input => { board = { ...board, status: 'draft' }; return reply('storyboard.reject', input, board); },
    },
    render: {
      enqueue: input => reply('render.enqueue', input, plan),
      async run(input) {
        record('render.run', input); plan = { ...plan, status: 'running', steps: [{ ...shot, status: 'running' }] };
        listeners.forEach(listener => listener({ jobId: 'job', status: 'running' }));
        await new Promise<void>(resolve => { finish = resolve; });
        plan = { ...plan, status: 'completed', steps: [{ ...shot, status: 'done' }] }; budget.used = 20;
        listeners.forEach(listener => listener({ jobId: 'job', status: 'completed' }));
        return { ok: true, data: structuredClone(plan) };
      },
      status: input => reply('render.status', input, plan),
      cancel: input => { plan = { ...plan, status: 'paused' }; finish?.(); return reply('render.cancel', input, plan); },
      redo: input => reply('render.redo', input, { id: 'rework', sceneIds: ['scene', 'next-scene'], estimatedCredits: 40, state: 'awaiting_owner_approval' }),
      decideRedo: input => reply('render.decideRedo', input, { id: 'rework', state: input.accept ? 'accepted' : 'rejected' }),
    },
    take: {
      list: input => reply('take.list', input, [{ id: 'take', sceneId: 'scene', file: 'preview.mp4', durationSec: 5, selected }]),
      select: async input => {
        record('take.select', input);
        if (input.outPoint <= input.inPoint) return { ok: false, error: { message: 'Điểm ra phải lớn hơn điểm vào' } };
        selected = true; return { ok: true, data: input };
      },
    },
    edit: {
      assemble: input => reply('edit.assemble', input, { id: 'timeline' }),
      capcut: input => reply('edit.capcut', input, { path: 'exports/cc' }),
      export: input => reply('edit.export', input, { path: 'exports/final.mp4' }),
    },
    export: { package: input => reply('export.package', input, { directory: 'exports/publish' }) },
    account: { list: input => reply('account.list', input, [{ id: 'owner', label: 'Tài khoản Flow', status: 'needs_owner', remainingCredits: 0, cookie: 'PRIVATE_COOKIE_SENTINEL', token: 'PRIVATE_TOKEN_SENTINEL', session: 'PRIVATE_SESSION_SENTINEL' }]) },
    queue: { list: input => reply('queue.list', input, []) },
    budget: {
      get: input => reply('budget.get', input, budget),
      set: input => { budget = { ...budget, limit: input.limit }; return reply('budget.set', input, budget); },
    },
    settings: {
      get: input => reply('settings.get', input, { ...settings, token: 'PRIVATE_MCP_SENTINEL' }),
      configure: input => { settings = { ...settings, enabled: input.enabled, credentialConfigured: true }; return reply('settings.configure', input, settings); },
      rotate: input => { settings = { ...settings, enabled: true, credentialConfigured: true }; return reply('settings.rotate', input, { ...settings, token: 'PRIVATE_ROTATED_SENTINEL' }); },
      revoke: input => { settings = { ...settings, enabled: false, credentialConfigured: false }; return reply('settings.revoke', input, settings); },
    },
    onRenderProgress(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { api: Object.assign(base, workflow), calls, finishRender: () => finish?.(), listeners };
}

