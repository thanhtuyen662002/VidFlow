import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';
import { UnsafePathError } from './errors.ts';
import { assertInsideDataDir, assertSafeOutputPath } from './paths.ts';
import { MediaInputError, probe } from './probe.ts';
import { runMediaFiles } from './runner.ts';

export interface ExtractFrameOptions { fileName?: string }
export interface ExtractedFrame { path: string; timeSec: number; width: number; height: number }

export async function extractFrame(projectDir: string, videoPath: string, timeSec: number,
  options: ExtractFrameOptions = {}): Promise<ExtractedFrame> {
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new MediaInputError('MEDIA_INVALID_TIME', 'Thời điểm cắt khung phải hữu hạn và không âm');
  }
  const dataDir = dataDirectory();
  const project = assertInsideDataDir(projectDir, dataDir);
  const input = assertInsideDataDir(videoPath, dataDir);
  const base = basename(input, extname(input)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'frame';
  const fileName = options.fileName ?? `${base}_t${String(Math.round(timeSec * 1000)).padStart(6, '0')}.png`;
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_. -]*\.png$/i.test(fileName)) {
    throw new UnsafePathError('Frame name must be a safe PNG filename');
  }
  const frames = resolveInside(project, 'frames');
  const output = resolveInside(frames, fileName);
  const paths = { dataDir, projectDir: project, inputPaths: [input] };
  assertSafeOutputPath(output, paths);
  const info = await probe(input);
  if (timeSec >= info.durationSec) throw new MediaInputError('MEDIA_INVALID_TIME', 'Thời điểm cắt khung phải nhỏ hơn thời lượng video');
  await mkdir(frames, { recursive: true });
  await runMediaFiles('ffmpeg', (inputs, out) => [
    '-ss', String(timeSec), '-i', inputs[0], '-frames:v', '1', out!,
  ], { ...paths, outputPath: output, timeoutMs: 30000 });
  try {
    if (!(await stat(output)).isFile() || (await stat(output)).size === 0) throw new Error();
  } catch { throw new MediaInputError('MEDIA_FRAME_MISSING', 'Không tạo được ảnh khung hình'); }
  return { path: output, timeSec, width: info.width, height: info.height };
}
