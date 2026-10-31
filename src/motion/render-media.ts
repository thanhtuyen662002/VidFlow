import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { probe } from '../media/probe.ts';
import { runMediaFiles } from '../media/runner.ts';

/** Lossless spatial crop only: retained pixels, including AI marks, are unchanged.
 * The configured Flow logo is in the bottom band; never inpaint or blur it. */
export function motionMedia(root: string) {
  assertInsideDataDir(root, dataDirectory());
  async function output(inputs: string[], args: (files: string[], out: string) => string[], ext = 'png') {
    const directory = resolveInside(root, 'frames/motion/derived');
    await mkdir(directory, { recursive: true });
    const path = resolveInside(directory, `${randomUUID()}.${ext}`);
    await runMediaFiles('ffmpeg', (files, out) => args(files, out!), {
      dataDir: dataDirectory(), projectDir: root, inputPaths: inputs.map(p => assertInsideDataDir(p, root)),
      outputPath: path, timeoutMs: 120000,
    });
    return path;
  }
  return {
    async frame(file: string, time: number | 'last') {
      const info = await probe(file);
      const seconds = time === 'last' ? Math.max(0, info.durationSec - 1 / info.fps) : time;
      return output([file], (f, out) => ['-ss', String(seconds), '-i', f[0], '-frames:v', '1', out]);
    },
    async crop(file: string) {
      const info = await probe(file);
      const height = Math.floor(info.height * 0.90);
      return output([file], (f, out) => ['-i', f[0], '-map_metadata', '0', '-vf',
        `crop=${info.width}:${height}:0:0:exact=1`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-metadata', 'comment=This content is AI-generated.', out]);
    },
    async comparison(original: string, transformed: string) {
      return output([original, transformed], (f, out) => ['-i', f[0], '-i', f[1], '-filter_complex',
        '[0:v][1:v]scale2ref[original][styled];[original][styled]hstack', '-frames:v', '1',
        '-metadata', 'comment=This content is AI-generated.', out]);
    },
    async clip(file: string, start: number, end: number) {
      return output([file], (f, out) => ['-ss', String(start), '-i', f[0], '-t', String(end - start),
        '-c:v', 'libx264', '-an', out], 'mp4');
    },
  };
}
