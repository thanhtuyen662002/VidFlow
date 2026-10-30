import { redactSensitive } from './redaction.ts';

export type MediaTool = 'ffmpeg' | 'ffprobe';
export class MediaToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(redactSensitive(message));
    this.name = new.target.name;
    this.code = code;
  }
}
export class MediaToolNotFoundError extends MediaToolError {
  readonly tool: MediaTool;
  readonly source: 'env' | 'PATH';
  constructor(tool: MediaTool, source: 'env' | 'PATH') {
    super('FFMPEG_NOT_FOUND', `${tool} not found: ${source === 'env' ? `VIDFLOW_${tool.toUpperCase()}` : 'PATH'}`);
    this.tool = tool;
    this.source = source;
  }
}
export class MediaToolExitError extends MediaToolError {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
  constructor(exitCode: number | null, signal: string | null, stderr: string) {
    const tail = redactSensitive(stderr);
    super('FFMPEG_EXIT_NONZERO', `Media tool exited (${exitCode ?? signal}): ${tail}`);
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrTail = tail;
  }
}
export class MediaToolTimeoutError extends MediaToolError {
  readonly timeoutMs: number;
  readonly stderrTail: string;
  constructor(timeoutMs: number, stderr: string) {
    super('FFMPEG_TIMEOUT', `Media tool timed out after ${timeoutMs}ms: ${stderr}`);
    this.timeoutMs = timeoutMs;
    this.stderrTail = redactSensitive(stderr);
  }
}
export class UnsafePathError extends MediaToolError {
  readonly reason: string;
  constructor(reason: string) {
    super('UNSAFE_PATH', reason);
    this.reason = reason;
  }
}
