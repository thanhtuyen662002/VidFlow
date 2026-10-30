import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveInside } from '../paths.ts';

// Relative to the module, not cwd; preserve prompts/ beside src/ when packaging.
export const defaultPromptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url));
export async function loadSystemPrompt(name: 'script-writer' | 'script-editor', options: { promptsDir?: string } = {}): Promise<string> {
  const text = await readFile(resolveInside(options.promptsDir ?? defaultPromptsDir, `${name}.system.md`), 'utf8');
  if (!text.trim()) throw new Error(`Empty system prompt: ${name}`);
  return text;
}
