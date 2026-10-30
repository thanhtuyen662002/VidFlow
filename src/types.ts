export type Project = { id: string; name: string; aspect: string; budget: number | null; status: string; directory: string; created_at: string };
export type Reference = { id: string; project_id: string; name: string; role: string; images: string[]; description: string; priority: number };
export type Bible = { id: string; project_id: string; style: string; lighting: string; palette: string; lens: string; avoid: string; safe_area: string };

export class DuplicateError extends Error {
  constructor(message: string) {
    super(`DuplicateError: ${message}`);
    this.name = 'DuplicateError';
  }
}

export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ScriptStatus = 'draft' | 'scored' | 'approved' | 'rejected';
export type ScriptScene = { sceneIndex: number; durationSec: number; description: string; dialogue: { speaker: string; text: string }[] };
export type ScriptIssue = { sceneIndex: number; type: string; severity: 'info' | 'warning' | 'error'; message: string };
export type ScriptReview = { id: string; variantId: string; score: number; comment: string; issues: ScriptIssue[]; reviewerModel: string; createdAt: string };
export type ScriptVariant = { id: string; projectId: string; versionNumber: number; parentVariantId: string | null; name: string; content: string; isActive: boolean; logline: string; audience: string; value: string; beats: unknown[]; scenes: unknown[]; scores: Record<string, unknown>; feedback: string; status: ScriptStatus; createdAt: string; updatedAt: string };
export type Scene = { id: string; projectId: string; scriptVariantId: string | null; chainId: string | null; index: number; title: string; prompt: string; status: string; beat: string; durationUsed: number; moment: string; camera: string; action: string; dialogue: string; sfx: string; charactersPresent: string[]; location: string; transition: 'continue' | 'cut'; groupId: string | null; mode: 'frames' | 'image-to-video' | 'text'; createdAt: string; updatedAt: string };
export type Chain = { id: string; projectId: string; scriptVariantId: string | null; name: string; status: string; createdAt: string };
export type RenderJob = { id: string; projectId: string; sceneId: string; accountId: string | null; provider: string; type: string; model: string; prompt: string; inputImages: string[]; status: RenderJobStatus; credits: number; error: string | null; attempts: number; paramsJson: Record<string, unknown>; createdAt: string; updatedAt: string };
export type Take = { id: string; renderJobId: string; sceneId: string; assetId: string | null; file: string; metadata: Record<string, unknown>; qualityScore: number | null; selected: boolean; durationSec: number; createdAt: string };
export type Selection = { id: string; sceneId: string; takeId: string; in: number; out: number; crop: Record<string, unknown>; exitFrame: string | null; isCurrent: boolean; createdAt: string };
export type ChainScene = { chainId: string; sceneId: string; position: number };

export type ScriptApprovalInput = { scriptId: string; versionId: string };
export type ScriptOverrideInput = ScriptApprovalInput & { warningId: string; reason: string };
