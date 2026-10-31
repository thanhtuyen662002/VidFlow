import type { createIpcHandlers } from './ipc.ts';
import type { RenderProgress } from '../service/progress.ts';
type Result = Awaited<ReturnType<ReturnType<typeof createIpcHandlers>['handleInvoke']>>;
export interface LegacyApi {
  template: {
    save(input: { projectId: string; name: string }): Promise<Result>;
    createProject(input: { templateId: string; name: string }): Promise<Result>;
    list(input: Record<string, never>): Promise<Result>;
    get(input: { id: string }): Promise<Result>;
    delete(input: { id: string }): Promise<Result>;
  };
  analytics: {
    import(input: { projectId: string; timelineId: string; csvPath: string }): Promise<Result>;
    list(input: { projectId: string }): Promise<Result>;
    accept(input: { id: string }): Promise<Result>;
    reject(input: { id: string }): Promise<Result>;
  };
  budget: import('../../renderer/src/workflow.ts').WorkflowControls['budget'];
  settings: import('../../renderer/src/workflow.ts').WorkflowControls['settings'];
  project: { create(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result>; get(input: Record<string, unknown>): Promise<Result> };
  reference: { remove(input: Record<string, unknown>): Promise<Result>; add(input: Record<string, unknown>): Promise<Result>; list(input: Record<string, unknown>): Promise<Result> };
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
export type { VidFlowApi } from './renderer-contract.ts';
import type { VidFlowApi } from './renderer-contract.ts';
export type VidflowApi = Omit<LegacyApi, 'bible' | 'script'> & VidFlowApi & Pick<import('../../renderer/src/workflow.ts').WorkflowControls, 'storyboard' | 'render'> & {
  bible: LegacyApi['bible'] & VidFlowApi['bible'];
  script: LegacyApi['script'] & VidFlowApi['script'];
};
declare global { interface Window { vidflow: VidflowApi } }
