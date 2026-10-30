import type { WorkflowBudget, WorkflowSettings, WorkflowRework } from '../../src/types.ts';
export type Shot = { id: string; sceneId: string; chainId: string; compiledPrompt: string; status: string };
export type Board = { id: string; planId: string; status: string; shots: Shot[] };
export type Plan = { id: string; status: string; estimatedCredits: number; steps: Shot[] };
export type Take = { id: string; sceneId: string; file: string; durationSec: number; selected: boolean };
export type Account = { id: string; label: string; status: string; remainingCredits: number };
export function statusLabel(status: string): string {
  return ({ draft: 'Bản nháp', approved: 'Đã duyệt', pending: 'Đang chờ', ready: 'Sẵn sàng', queued: 'Trong hàng đợi', busy: 'Đang bận', out_of_credit: 'Hết credit', disabled: 'Đã tắt', running: 'Đang chạy', completed: 'Hoàn tất', done: 'Hoàn tất', succeeded: 'Hoàn tất', failed: 'Thất bại', blocked: 'Đang bị chặn', needs_owner: 'Cần chủ sở hữu', paused: 'Tạm dừng', cancelled: 'Đã hủy', cho_duyet_ngan_sach: 'Chờ duyệt ngân sách' } as Record<string, string>)[status] ?? 'Chưa có thông tin trạng thái';
}
type Reply<T> = Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>;
export interface WorkflowApi {
  storyboard: { generate(input: { variantId: string }): Reply<Board>; approve(input: { storyboardId: string }): Reply<Board> };
  render: { enqueue(input: { storyboardId: string }): Reply<Plan>; run(input: { storyboardId: string; planId: string }): Reply<Plan>; status(input: { planId: string }): Reply<Plan> };
  take: { list(input: { planId: string }): Reply<Take[]>; select(input: { stepId: string; takeId: string; inPoint: number; outPoint: number }): Reply<unknown> };
  edit: { assemble(input: { projectId: string }): Reply<{ id: string }>; capcut(input: { timelineId: string; aspect: string }): Reply<{ path: string }>; export(input: { timelineId: string; aspect: string; mixedAudioPath: string }): Reply<{ path: string }> };
  account: { list(input: Record<string, never>): Reply<Account[]> };
  queue: { list(input: Record<string, never>): Reply<{ id: string; status: string }[]> };
}
export interface WorkflowControls {
  storyboard: { reject(input: { storyboardId: string }): Reply<Board> };
  render: {
    cancel(input: { planId: string }): Reply<Plan>;
    redo(input: { planId: string; sceneId: string }): Reply<WorkflowRework>;
    decideRedo(input: { requestId: string; accept: boolean }): Reply<{ id: string; state: string }>;
  };
  budget: { get(input: { projectId: string }): Reply<WorkflowBudget>; set(input: { projectId: string; limit: number | null }): Reply<WorkflowBudget> };
  settings: {
    get(input: Record<string, never>): Reply<WorkflowSettings>;
    configure(input: { enabled: boolean }): Reply<WorkflowSettings>;
    rotate(input: Record<string, never>): Reply<WorkflowSettings>;
    revoke(input: Record<string, never>): Reply<WorkflowSettings>;
  };
  export: { package(input: { timelineId: string; videos: { aspect: string; path: string }[]; coverPath: string; llmModel: string }): Reply<{ directory: string }> };
  onRenderProgress(callback: (event: { jobId: string; status: string }) => void): () => void;
}
export type WorkflowClient = Omit<WorkflowApi, 'storyboard' | 'render'> &
  Partial<Omit<WorkflowControls, 'storyboard' | 'render'>> & {
    storyboard: WorkflowApi['storyboard'] & Partial<WorkflowControls['storyboard']>;
    render: WorkflowApi['render'] & Partial<WorkflowControls['render']>;
  };
// Defense in depth for fake/older preload clients. Service remains the security boundary.
export function publicData<T>(value: T): T {
  const secrets = new Set<string>();
  function collect(item: unknown) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/cookie|token|session|secret|password|authorization|storageState/i.test(key) && typeof child === 'string') secrets.add(child);
      collect(child);
    }
  }
  collect(value);
  function clean(item: unknown): unknown {
    if (typeof item === 'string') { for (const secret of secrets) if (secret) item = (item as string).split(secret).join('[Đã ẩn]'); return item; }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !/cookie|token|session|secret|password|authorization|storageState/i.test(key)).map(([key, child]) => [key, clean(child)]));
    return item;
  }
  return clean(value) as T;
}
export async function unwrap<T>(reply: Reply<T>): Promise<T> {
  const result = publicData(await reply);
  if (!result.ok) throw new Error(/cookie|token|session|secret|authorization/i.test(result.error.message) ? 'Không thể hoàn tất thao tác.' : result.error.message);
  return result.data;
}

