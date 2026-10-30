import type { LlmClient } from './llm/types.ts';
import { MockLlm } from './llm/mock.ts';
import { claudeLlm, codexLlm } from './llm/cli.ts';

/** Fake responses live in the environment so CLI tests need neither network nor login. */
export function configuredLlm(): LlmClient {
  switch (process.env.VIDFLOW_LLM) {
    case 'fake': {
      const responses: unknown = JSON.parse(process.env.VIDFLOW_LLM_RESPONSES ?? '[]');
      if (!Array.isArray(responses) || !responses.length || responses.some(value => typeof value !== 'string'))
        throw new Error('VIDFLOW_LLM_RESPONSES must be a non-empty JSON array of strings');
      return new MockLlm(responses);
    }
    case 'claude': return claudeLlm();
    case 'codex': return codexLlm();
    default: throw new Error('Set VIDFLOW_LLM to fake, claude or codex');
  }
}
