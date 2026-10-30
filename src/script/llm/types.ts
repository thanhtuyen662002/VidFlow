export interface CompletionRequest { system?: string; prompt: string; signal?: AbortSignal; timeoutMs?: number }
export interface Completion { text: string; raw?: unknown }
export interface LlmClient { complete(request: CompletionRequest): Promise<Completion> }
