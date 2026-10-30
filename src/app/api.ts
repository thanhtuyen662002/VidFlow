import type { createIpcHandlers } from './ipc.ts';
import type { RenderProgress } from '../service/progress.ts';
type Result = Awaited<ReturnType<ReturnType<typeof createIpcHandlers>['handleInvoke']>>;
export interface VidflowApi {
  project: { create(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result>; get(input: Record<string, unknown>): Promise<Result> };
  reference: { add(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result> };
  bible: { update(input: Record<string, unknown>): Promise<Result> };
  script: { generate(input: Record<string, unknown>): Promise<Result>; score(input: Record<string, unknown>): Promise<Result>; revise(input: Record<string, unknown>): Promise<Result>; review(input: Record<string, unknown>): Promise<Result>; override(input: Record<string, unknown>): Promise<Result>; approve(input: Record<string, unknown>): Promise<Result> };
  storyboard: { generate(input: Record<string, unknown>): Promise<Result>; approve(input: Record<string, unknown>): Promise<Result>; get(input: Record<string, unknown>): Promise<Result>; preview(input: Record<string, unknown>): Promise<Result> };
  render: { enqueue(input: Record<string, unknown>): Promise<Result>; run(input: Record<string, unknown>): Promise<Result>; status(input: Record<string, unknown>): Promise<Result> };
  take: { list(input: Record<string, unknown>): Promise<Result>; select(input: Record<string, unknown>): Promise<Result> };
  edit: { assemble(input: Record<string, unknown>): Promise<Result>; capcut(input: Record<string, unknown>): Promise<Result>; export(input: Record<string, unknown>): Promise<Result> };
  audio: { mix(input: Record<string, unknown>): Promise<Result> };
  export: { package(input: Record<string, unknown>): Promise<Result> };
  account: { create(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result>; status(input: Record<string, unknown>): Promise<Result> };
  credit: { add(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result> };
  queue: { list(input: Record<string, unknown>): Promise<Result> };
  onRenderProgress(callback: (payload: RenderProgress) => void): () => void;
}
declare global { interface Window { vidflow: VidflowApi } }
