import type { Bible as CoreBible, Project as CoreProject, Reference as CoreReference } from '../../src/types.ts';

export type Project = Pick<CoreProject, 'id' | 'name'>;
export type Bible = Omit<CoreBible, 'id' | 'project_id'>;
export type ReferenceInput = Omit<CoreReference, 'id' | 'project_id'>;
export type Reference = CoreReference;
export type Gate = {
  status: string;
  options: { id: string; scriptId: string; versionId: string; title: string; score: number | null; notes: string; risks: { id?: string; level: string; message: string; suggestedFix?: string }[] }[];
  canApprove: boolean;
  canSkip: boolean;
  lockReason?: string;
  comments?: string[];
  blockingReasons?: string[];
};
export interface VidFlowApi {
  projects: { list(): Promise<Project[]>; create(input: { name: string }): Promise<Project> };
  bible: { get(projectId: string): Promise<Bible>; update(projectId: string, patch: Partial<Bible>): Promise<Bible> };
  references: { list(projectId: string): Promise<Reference[]>; add(projectId: string, input: ReferenceInput): Promise<Reference>; remove(projectId: string, refId: string): Promise<void> };
  script: { override(projectId: string, input: import('../../src/types.ts').ScriptOverrideInput): Promise<void>; getGate(projectId: string): Promise<Gate>; approve(projectId: string, input: import('../../src/types.ts').ScriptApprovalInput): Promise<void>; skip(projectId: string, input: { reason: string }): Promise<void> };
}

export type VidflowApi = VidFlowApi;

// Mirrors the existing sandbox preload; the core supplies all gate permissions.
export function getApi(): VidFlowApi {
  const api = (window as Window & { vidflow?: VidFlowApi }).vidflow;
  if (!api) throw new Error('Không tìm thấy API VidFlow. Vui lòng mở giao diện từ ứng dụng VidFlow.');
  return api;
}
