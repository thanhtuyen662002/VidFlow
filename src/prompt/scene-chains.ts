import type { Scene } from '../types.ts';

export type ChainSceneInput = Pick<Scene, 'id' | 'transition'>;
export type ComputedChain = { index: number; scene_ids: string[] };

export class SceneNotFoundError extends Error {
  readonly code = 'SCENE_NOT_FOUND';
  constructor(editedSceneIndexOrId: number | string) {
    super(`Scene not found: ${editedSceneIndexOrId}`);
    this.name = 'SceneNotFoundError';
  }
}

/** Input order defines scene order; persisted Scene.index is not used. */
export function computeChains(scenes: readonly ChainSceneInput[]): ComputedChain[] {
  const chains: ComputedChain[] = [];
  for (const scene of scenes) {
    // docs/milestones/M2.md, goal (Chain), omits the first-continue rule:
    // normalize it to cut by opening the initial chain without changing input.
    if (chains.length === 0 || scene.transition === 'cut') {
      chains.push({ index: chains.length, scene_ids: [] });
    }
    chains[chains.length - 1].scene_ids.push(scene.id);
  }
  return chains;
}

/** A number selects a zero-based input position; a string selects a scene id. */
export function computeRedoScope(
  scenes: readonly ChainSceneInput[], editedSceneIndexOrId: number | string,
): string[] {
  const index = typeof editedSceneIndexOrId === 'number'
    ? editedSceneIndexOrId : scenes.findIndex(scene => scene.id === editedSceneIndexOrId);
  if (!Number.isSafeInteger(index) || index < 0 || index >= scenes.length) {
    throw new SceneNotFoundError(editedSceneIndexOrId);
  }
  let end = index + 1;
  while (end < scenes.length && scenes[end].transition === 'continue') end++;
  return scenes.slice(index, end).map(scene => scene.id);
}
