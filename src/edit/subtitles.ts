import type { Timeline } from './timeline.ts';

export interface SubtitleCue { text: string; startMs: number; endMs: number }
export function timelineFps(timeline: Timeline): number {
  const fps = timeline.fps ?? 24;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Invalid timeline fps');
  return fps;
}
export function videoClips(timeline: Timeline) {
  return timeline.tracks.filter(t => t.kind === 'video' && !t.muted).flatMap(t => t.clips)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.order - b.order);
}
/** Convert seconds once to integer microseconds; never accumulate floating offsets. */
export function subtitleCues(timeline: Timeline): SubtitleCue[] {
  const fps = timelineFps(timeline);
  const us = (n: number) => {
    if (!Number.isFinite(n) || n < 0) throw new Error('Invalid subtitle time');
    return Math.round(n * 1_000_000);
  };
  const snap = (n: number) => Math.round(n * fps / 1_000_000);
  const clips = videoClips(timeline);
  const raw: { text: string; start: number; end: number }[] = [];
  for (const clip of clips) {
    const offset = us(clip.timelineStart), trim = us(clip.inPoint), out = us(clip.outPoint);
    const lines = clip.dialogueLines;
    if (lines) for (const line of lines) raw.push({ text: line.text,
      start: snap(offset + Math.max(trim, us(line.start)) - trim),
      end: snap(offset + Math.min(out, us(line.end)) - trim) });
    else for (const track of timeline.tracks.filter(t => t.kind === 'subtitle' && !t.muted)) {
      for (const line of track.subtitles.filter(s => s.sceneId === clip.sceneId)) raw.push({ text: line.text,
        start: snap(Math.max(offset, us(line.start))),
        end: snap(Math.min(offset + out - trim, us(line.end))) });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  let last = 0;
  return raw.flatMap(cue => {
    const start = Math.max(last, cue.start, 0), end = cue.end;
    if (end <= start || !cue.text.trim()) return [];
    last = end;
    return [{ text: cue.text.trim().replace(/\r?\n\s*\r?\n/g, '\n'),
      startMs: Math.round(start * 1000 / fps), endMs: Math.round(end * 1000 / fps) }];
  });
}
function timestamp(ms: number): string {
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function timelineSrt(timeline: Timeline): string {
  return subtitleCues(timeline).map((c, i) => `${i + 1}\n${timestamp(c.startMs)} --> ${timestamp(c.endMs)}\n${c.text}\n`).join('\n');
}
