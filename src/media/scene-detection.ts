import { dataDirectory } from '../paths.ts';
import { runMediaFiles } from './runner.ts';

/** metadata on stdout avoids the runner's deliberately bounded stderr log. */
export async function detectSceneCuts(file: string, threshold = 0.3): Promise<number[]> {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError('Invalid scene threshold');
  const dataDir = dataDirectory();
  const result = await runMediaFiles('ffmpeg', inputs => [
    '-i', inputs[0], '-an', '-vf', `select='gt(scene,${threshold})',metadata=mode=print:file=-`,
    '-f', 'null', '-',
  ], { dataDir, projectDir: dataDir, inputPaths: [file], timeoutMs: 600000 });
  return Array.from(result.stdout.matchAll(/pts_time:([\d.eE+-]+)/g), match => Number(match[1])).filter(Number.isFinite);
}
