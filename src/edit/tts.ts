import { runMediaFiles } from '../media/runner.ts';
import type { AudioContext } from './audio.ts';

export interface TtsResult { path: string; durationSec: number }
/** Future providers must run locally or use a free service; no paid SDK or API key. */
export interface TtsProvider {
  name: string;
  synthesize(text: string, voice: string, lang: string, outPath: string, context: AudioContext): Promise<TtsResult>;
}
export class MockTtsProvider implements TtsProvider {
  name = 'mock';
  async synthesize(text: string, voice: string, lang: string, outPath: string, context: AudioContext): Promise<TtsResult> {
    const durationSec = Math.max(0.25, [...text.trim()].length * 0.06);
    let hash = 0;
    for (const char of `${voice}:${lang}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    await runMediaFiles('ffmpeg', (_, output) => ['-f', 'lavfi', '-i',
      `sine=frequency=${220 + hash % 220}:duration=${durationSec}:sample_rate=48000`, '-c:a', 'pcm_s16le', '-f', 'wav', output!],
    { ...context, inputPaths: [], outputPath: outPath, timeoutMs: context.timeoutMs ?? 30000 });
    return { path: outPath, durationSec };
  }
}
export class TtsRegistry {
  private providers = new Map<string, TtsProvider>();
  constructor() { this.register(new MockTtsProvider()); }
  register(provider: TtsProvider): void {
    if (!provider.name || this.providers.has(provider.name)) throw new Error('Tên cổng TTS bị trùng hoặc trống');
    this.providers.set(provider.name, provider);
  }
  get(name: string): TtsProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error('Không tìm thấy cổng TTS');
    return provider;
  }
}
