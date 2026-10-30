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

/** Single-render limit specified by docs/milestones/M2.md. */
export const GROUP_RENDER_DURATION_LIMIT = 8;
export type GroupCompilerScene = CompilerScene & Pick<Scene, 'id'> &
  Partial<Pick<Scene, 'groupId' | 'durationUsed'>>;
export type GroupSegment = { scene_id: string; start: number; end: number };
export type CompiledGroup = CompiledScene & {
  group_id: string; scene_ids: string[]; segments: GroupSegment[]; total_duration: number;
};

export class InvalidSceneDurationError extends Error {
  readonly code = 'INVALID_SCENE_DURATION';
  readonly scene_id: string;
  readonly duration_used: unknown;
  constructor(scene: GroupCompilerScene) {
    super(`Invalid duration_used for scene ${scene.id}`);
    this.name = 'InvalidSceneDurationError';
    this.scene_id = scene.id;
    this.duration_used = scene.durationUsed;
  }
}

export class GroupDurationExceededError extends Error {
  readonly code = 'GROUP_DURATION_EXCEEDED';
  readonly group_id: string;
  readonly scene_ids: string[];
  readonly total: number;
  readonly limit = GROUP_RENDER_DURATION_LIMIT;
  constructor(groupId: string, sceneIds: string[], total: number) {
    super(`Group ${groupId} duration ${total}s exceeds ${GROUP_RENDER_DURATION_LIMIT}s`);
    this.name = 'GroupDurationExceededError';
    this.group_id = groupId;
    this.scene_ids = sceneIds;
    this.total = total;
  }
}

const time = (value: number): string => value.toFixed(1).replace(/\.0$/, '');
const range = (segment: GroupSegment): string => `${time(segment.start)}–${time(segment.end)}s`;
// Shared layout for every merged segment, with LF separators independent of platform.
const GROUP_SEGMENT_TEMPLATE = (segment: GroupSegment, prompt: string): string => `${range(segment)}\n${prompt}`;

/** Select the requested render unit without compiling unrelated scenes. */
export function compileSceneUnit(
  scenes: readonly GroupCompilerScene[], sceneId: string, bible: CompilerBible, options: CompileOptions,
): CompiledScene | CompiledGroup {
  const index = scenes.findIndex(scene => scene.id === sceneId);
  if (index < 0) throw new Error(`Không tìm thấy cảnh: ${sceneId}`);
  let start = index;
  let end = index + 1;
  const groupId = scenes[index].groupId;
  if (groupId) {
    while (start > 0 && scenes[start - 1].groupId === groupId) start--;
    while (end < scenes.length && scenes[end].groupId === groupId) end++;
  }
  return compileScenes(scenes.slice(start, end), bible, options)[0];
}

/** Only adjacent nonempty group ids merge. Singletons retain the exact M2.3 result. */
export function compileScenes(
  scenes: readonly GroupCompilerScene[], bible: CompilerBible, options: CompileOptions,
): (CompiledScene | CompiledGroup)[] {
  const results: (CompiledScene | CompiledGroup)[] = [];
  for (let i = 0; i < scenes.length;) {
    const first = scenes[i];
    let end = i + 1;
    if (first.groupId) {
      while (end < scenes.length && scenes[end].groupId === first.groupId) end++;
    }
    const group = scenes.slice(i, end);
    i = end;
    let total = 0;
    const segments: GroupSegment[] = [];
    if (first.groupId) {
      for (const scene of group) {
        const duration = scene.durationUsed;
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
          throw new InvalidSceneDurationError(scene);
        }
        const start = total;
        total += duration;
        segments.push({ scene_id: scene.id, start, end: total });
      }
      if (total > GROUP_RENDER_DURATION_LIMIT) {
        throw new GroupDurationExceededError(first.groupId, group.map(scene => scene.id), total);
      }
    }
    if (group.length === 1) {
      results.push(compileScene(first, bible, options));
      continue;
    }
    const compiled = group.map(scene => compileScene(scene, bible, options));
    const references = compiled.flatMap(scene => scene.references)
      .filter((ref, index, all) => all.findIndex(item => item.id === ref.id) === index)
      .sort((a, b) => ranks[a.kind] - ranks[b.kind] || b.priority - a.priority)
      .slice(0, options.maxReferenceImages);
    results.push({
      prompt: [segments.map(range).join(' / '),
        ...compiled.map((scene, index) => GROUP_SEGMENT_TEMPLATE(segments[index], scene.prompt))].join('\n\n'),
      references,
      group_id: first.groupId!,
      scene_ids: group.map(scene => scene.id),
      segments,
      total_duration: total,
    });
  }
  return results;
}

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
