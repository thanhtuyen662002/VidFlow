import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { resolveFfmpeg, resolveFfprobe, runFfmpeg } from '../../src/media/index.ts';

export function detectFfmpeg(): { available: boolean; reason?: string } {
  try { resolveFfmpeg(); resolveFfprobe(); return { available: true }; }
  catch (error) { return { available: false, reason: `ffmpeg/ffprobe not found: ${(error as Error).message}` }; }
}
export function mediaHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'vidflow-media-'));
  const previous = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.VIDFLOW_HOME;
    else process.env.VIDFLOW_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
export async function makeTestVideo(directory: string): Promise<string> {
  const file = join(directory, 'test-video.mp4');
  await runFfmpeg(['-n', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', file], { timeoutMs: 15000 });
  return file;
}
export async function makeTestAudio(directory: string): Promise<string> {
  const file = join(directory, 'test-audio.wav');
  await runFfmpeg(['-n', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file], { timeoutMs: 15000 });
  return file;
}
