import { redact } from './redact.ts';
import type { ValidationError } from './schema.ts';

export class LlmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(redact(message)); this.name = new.target.name; this.code = code; }
}
export class LlmCliError extends LlmError {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(code: string, exitCode: number | null = null, stderr = '') {
    super(code, `LLM CLI failed (${code}, ${exitCode}): ${stderr}`);
    this.exitCode = exitCode; this.stderr = redact(stderr);
  }
}
export class LlmValidationExhaustedError extends LlmError {
  readonly attempts: number;
  readonly errors: ValidationError[];
  constructor(attempts: number, errors: ValidationError[]) {
    super('LLM_VALIDATION_EXHAUSTED', `LLM output invalid after ${attempts} attempts`);
    this.attempts = attempts; this.errors = errors;
  }
}
