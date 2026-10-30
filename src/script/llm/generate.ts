import type { CompletionRequest, LlmClient } from './types.ts';
import { validateSchema } from './schema.ts';
import type { JsonSchema, ValidationError } from './schema.ts';
import { LlmValidationExhaustedError } from './errors.ts';

function parseOutput(text: string): unknown {
  try { return JSON.parse(text); } catch { /* Locate a fenced or surrounded JSON object/array. */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) return JSON.parse(fence[1]);
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) return JSON.parse(text.slice(start, end + 1));
    }
  }
  throw new SyntaxError('Invalid JSON');
}
export async function generateValidated<T = unknown>(options: CompletionRequest & {
  llm: LlmClient; schema: JsonSchema; maxAttempts?: number; persist?: (value: T) => void | Promise<void>;
}): Promise<{ value: T; attempts: number }> {
  const max = options.maxAttempts ?? 3;
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10');
  let errors: ValidationError[] = [];
  for (let attempts = 1; attempts <= max; attempts++) {
    options.signal?.throwIfAborted();
    const feedback = errors.length ? `\nReturn corrected JSON. Validation errors: ${JSON.stringify(errors)}` : '';
    const result = await options.llm.complete({ system: options.system, prompt: options.prompt + feedback,
      signal: options.signal, timeoutMs: options.timeoutMs });
    let value: unknown;
    try { value = parseOutput(result.text); } catch { errors = [{ path: '$', message: 'Invalid JSON' }]; continue; }
    const validation = validateSchema(value, options.schema);
    errors = validation.errors;
    if (!validation.valid) continue;
    options.signal?.throwIfAborted();
    await options.persist?.(value as T);
    return { value: value as T, attempts };
  }
  throw new LlmValidationExhaustedError(max, errors);
}
