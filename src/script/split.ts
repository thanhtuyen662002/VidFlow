import type { DatabaseSync } from 'node:sqlite';
import type { Scene } from '../types.ts';
import { getScriptVariant } from '../repo/scripts.ts';
import { replaceScenes } from '../repo/scenes.ts';
import { BibleService, lookupBibleEntry, validatePromptRefs } from '../prompt/bible.ts';
import { parsePrompt } from '../prompt/parse-refs.ts';
import { validateScenes } from './variants.ts';

export class ScriptReferenceError extends Error {
  readonly references: string[];
  constructor(references: string[]) {
    super(`Unknown script references or speakers: ${references.join(', ')}`);
    this.references = references;
  }
}

export function split(db: DatabaseSync, variantId: string): Scene[] {
  const variant = getScriptVariant(db, variantId);
  if (!variant || variant.status !== 'approved') throw new Error('Split requires an approved script');
  validateScenes(variant.scenes);
  const entries = new BibleService(db).list(variant.projectId);
  const errors: string[] = [];
  const inputs = [...variant.scenes].sort((a, b) => a.sceneIndex - b.sceneIndex).map(scene => {
    const characters = new Set<string>();
    for (const field of [scene.description, ...scene.dialogue.flatMap(line => [line.speaker, line.text])]) {
      errors.push(...validatePromptRefs(db, variant.projectId, field).map(error => error.name));
      for (const token of parsePrompt(field)) {
        if (token.kind !== 'ref') continue;
        const entry = lookupBibleEntry(entries, token.name);
        if (entry?.kind === 'character') characters.add(entry.name);
      }
    }
    for (const line of scene.dialogue) {
      const name = line.speaker.trim().replace(/^@/, '');
      const entry = lookupBibleEntry(entries, name);
      if (!entry || entry.kind !== 'character') errors.push(line.speaker);
      else characters.add(entry.name);
    }
    // Keep the description in one compiler section so identities are not duplicated in action.
    return { prompt: scene.description, moment: scene.description, durationUsed: scene.durationSec,
      charactersPresent: [...characters], transition: 'cut' as const,
      dialogue: scene.dialogue.map(line => `${line.speaker}: ${line.text}`).join('\n') };
  });
  if (errors.length) throw new ScriptReferenceError([...new Set(errors)]);
  return replaceScenes(db, variant.projectId, variant.id, inputs);
}
