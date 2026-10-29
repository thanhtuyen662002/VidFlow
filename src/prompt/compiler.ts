import type { Bible, Scene } from '../types.ts';
import type { BibleEntry, BibleKind } from './bible.ts';
import { lookupBibleEntry, UnregisteredReferenceError } from './bible.ts';
import { parsePrompt } from './parse-refs.ts';

export type CompilerBible = Pick<Bible, 'style' | 'lighting' | 'palette' | 'lens' | 'safe_area' | 'avoid'> & {
  entries: readonly BibleEntry[];
};
export type CompilerScene = Pick<Scene, 'prompt' | 'charactersPresent' | 'location' | 'camera' | 'action'> & {
  wardrobe?: readonly string[];
};
export type CompileOptions = { maxReferenceImages: number };
export type ReferenceImage = { id: string; name: string; kind: BibleKind; image: string; priority: number };
export type CompiledScene = { prompt: string; references: ReferenceImage[] };
const ranks: Record<BibleKind, number> = { character: 0, location: 1, prop: 2, style: 3 };

/** M2 specifies no whitespace rewriting: preserve each section verbatim and join with LF.
 * Every mention uses description, including repeats. No implicit translation or NFC of prose.
 */
export function compileScene(scene: CompilerScene, bible: CompilerBible, options: CompileOptions): CompiledScene {
  if (!Number.isSafeInteger(options.maxReferenceImages) || options.maxReferenceImages < 0) {
    throw new RangeError('maxReferenceImages must be a nonnegative safe integer');
  }
  const selected: { entry: BibleEntry; first: number }[] = [];
  function resolve(name: string, offset: number, line: number, column: number): BibleEntry {
    const entry = lookupBibleEntry(bible.entries, name);
    if (!entry) throw new UnregisteredReferenceError(name, offset, line, column);
    if (!selected.some(item => item.entry.id === entry.id)) selected.push({ entry, first: offset });
    return entry;
  }
  function replace(text: string): string {
    return parsePrompt(text).map(token => token.kind === 'text' ? token.value
      : resolve(token.raw, token.start, token.line, token.column).description).join('');
  }
  const description = replace(scene.prompt);
  const implicit: string[] = [];
  for (const name of scene.charactersPresent) {
    const entry = lookupBibleEntry(bible.entries, name);
    const mentioned = entry && selected.some(item => item.entry.id === entry.id);
    const resolved = resolve(name, Number.MAX_SAFE_INTEGER, 1, 1);
    if (!mentioned) implicit.push(resolved.description);
  }
  if (scene.location) {
    const entry = lookupBibleEntry(bible.entries, scene.location);
    const mentioned = entry && selected.some(item => item.entry.id === entry.id);
    const resolved = resolve(scene.location, Number.MAX_SAFE_INTEGER, 1, 1);
    if (!mentioned) implicit.push(resolved.description);
  }
  const wardrobe = (scene.wardrobe ?? []).map(replace);
  const camera = replace(scene.camera);
  const action = replace(scene.action);
  selected.sort((a, b) => ranks[a.entry.kind] - ranks[b.entry.kind]
    // M2 does not define direction: higher priority wins within a kind.
    || b.entry.priority - a.entry.priority || a.first - b.first
    || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  return {
    prompt: [bible.style, bible.lighting, bible.palette, bible.lens, description, ...implicit,
      ...wardrobe, camera, action, bible.safe_area, bible.avoid].filter(part => part !== '').join('\n'),
    references: selected.filter(item => item.entry.images.length > 0).slice(0, options.maxReferenceImages)
      .map(({ entry }) => ({ id: entry.id, name: entry.name, kind: entry.kind, image: entry.images[0], priority: entry.priority })),
  };
}
