import type { ScriptIssue, ScriptScene } from '../types.ts';

export function checkDialogueLength(scene: ScriptScene, { wordsPerSecond = 2.5 }: { wordsPerSecond?: number } = {}): ScriptIssue | undefined {
  if (!Number.isFinite(wordsPerSecond) || wordsPerSecond <= 0) throw new RangeError('wordsPerSecond must be positive');
  if (!Number.isFinite(scene.durationSec) || scene.durationSec <= 0) throw new RangeError('durationSec must be positive');
  const words = scene.dialogue.reduce((count, line) => count + (line.text.trim().match(/\S+/gu)?.length ?? 0), 0);
  const seconds = words / wordsPerSecond;
  if (seconds <= scene.durationSec) return undefined;
  return { sceneIndex: scene.sceneIndex, type: 'dialogue_too_long', severity: 'warning',
    message: `Cảnh ${scene.sceneIndex}: lời thoại ${words} từ ≈ ${Number(seconds.toFixed(2))}s, vượt thời lượng cảnh ${scene.durationSec}s` };
}
