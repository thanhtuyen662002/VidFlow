export interface WorkerJob { id: string; payload: string; project_id: string | null; attempts: number }
export interface WorkerAccount { id: string; status: string }
export interface FlowMedia { path: string; kind: 'image' | 'video'; bytes: number }
export type FlowJobResult =
  | { kind: 'success'; media: FlowMedia[] }
  | { kind: 'out_of_credit' }
  | { kind: 'refused'; reason: string }
  | { kind: 'verification_required' }
  | { kind: 'transient_error'; message: string };
export interface JobContext { timeoutMs: number }
export interface FlowJobDriver {
  run(job: WorkerJob, account: WorkerAccount, ctx: JobContext): Promise<FlowJobResult>;
}
