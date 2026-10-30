import { stat } from 'node:fs/promises';
import { dataDirectory } from '../paths.ts';
import { MediaToolError } from './errors.ts';
import { assertInsideDataDir } from './paths.ts';
import { runMediaFiles } from './runner.ts';

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export class MediaInputError extends MediaToolError {}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}
interface ProbeDocument { format?: { duration?: string }; streams?: ProbeStream[] }

function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  if (parts.length > 2) return undefined;
  const numerator = nonnegative(parts[0]);
  const denominator = parts.length === 2 ? nonnegative(parts[1]) : 1;
  if (!numerator || !denominator) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

export async function probe(videoPath: string): Promise<MediaInfo> {
  const dataDir = dataDirectory();
  const input = assertInsideDataDir(videoPath, dataDir);
  try {
    if (!(await stat(input)).isFile()) throw new Error();
  } catch {
    throw new MediaInputError('MEDIA_FILE_MISSING', 'Không tìm thấy tệp media');
  }
  const result = await runMediaFiles('ffprobe', inputs => [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputs[0],
  ], { dataDir, projectDir: dataDir, inputPaths: [input], timeoutMs: 15000 });
  let info: ProbeDocument | null;
  try { info = JSON.parse(result.stdout); }
  catch { throw new MediaInputError('MEDIA_INVALID_METADATA', 'Thông số media không hợp lệ'); }
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video');
  if (!video) throw new MediaInputError('MEDIA_NO_VIDEO', 'Tệp không có luồng video');
  if (typeof video.width !== 'number' || typeof video.height !== 'number' ||
    !Number.isInteger(video.width) || video.width <= 0 || !Number.isInteger(video.height) || video.height <= 0) {
    throw new MediaInputError('MEDIA_INVALID_METADATA', 'Kích thước video không hợp lệ');
  }
  return {
    // Still images have no duration; report zero so they can also be inspected.
    durationSec: nonnegative(info?.format?.duration) ?? nonnegative(video.duration) ?? 0,
    width: video.width, height: video.height,
    fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate) ?? 0,
    hasAudio: streams.some(stream => stream?.codec_type === 'audio'),
  };
}
