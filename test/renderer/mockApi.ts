import { mock } from 'node:test';
import type { Gate, Project, Reference, VidFlowApi } from '../../renderer/src/api.ts';

export function mockApi(initial?: Partial<Gate>) {
  const projects: Project[] = [{ id: 'p1', name: 'Dự án mẫu' }];
  const references: Reference[] = [];
  let gate: Gate = { status: 'Chờ duyệt', canApprove: true, canSkip: true, options: [{ id: 'o1', scriptId: 's1', versionId: 'o1', title: 'Phương án một', score: 10, notes: 'Nhận xét mẫu', risks: [{ level: 'cao', message: 'Nội dung nhạy cảm' }] }], ...initial };
  let bible = { style: '', lighting: '', palette: '', lens: '', avoid: '', safe_area: '' };
  const api = {
    projects: { list: mock.fn(async () => [...projects]), create: mock.fn(async input => { const p = { id: 'p2', ...input }; projects.push(p); return p; }) },
    bible: { get: mock.fn(async () => bible), update: mock.fn(async (_id, patch) => { bible = { ...bible, ...patch }; return bible; }) },
    references: { list: mock.fn(async () => [...references]), add: mock.fn(async (id, input) => { const ref = { ...input, name: 'Tên từ lõi', id: 'r1', project_id: id }; references.push(ref); return ref; }), remove: mock.fn(async (_id, refId) => { references.splice(references.findIndex(r => r.id === refId), 1); }) },
    script: { override: mock.fn(async (_id, _input) => {}), getGate: mock.fn(async () => structuredClone(gate)), approve: mock.fn(async (_id, _input) => { gate = { ...gate, status: 'Đã duyệt từ lõi', canApprove: false }; }), skip: mock.fn(async (_id, _input) => { gate = { ...gate, status: 'Đã bỏ qua từ lõi', canSkip: false }; }) },
  } satisfies VidFlowApi;
  return api;
}
