import { compileScene } from '../prompt/compiler.ts';
import type { CompilerBible } from '../prompt/compiler.ts';
import type { SourceSegment } from './source-import.ts';
import type { MotionAnalysis, MotionMapping, MotionSubject } from './subjects.ts';
import type { MotionPreset, MotionPricing } from './preset-config.ts';

export interface AnalyzedMotionSegment {
  segment: SourceSegment; analysis: MotionAnalysis; subjects: MotionSubject[];
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const FACELESS_CLAUSE = 'No face visible. No visible human faces.';
export const AI_DISCLOSURE = 'This content is AI-generated.';
/** No I/O, clock, locale, randomness or input mutation. */
export function compileMotionPrompts(analysis: readonly AnalyzedMotionSegment[], mapping: readonly MotionMapping[],
  preset: MotionPreset, bible: CompilerBible) {
  if (!Number.isSafeInteger(preset.maxReferenceImages) || preset.maxReferenceImages < 0) throw new Error('Invalid motion reference image limit');
  const orderedBible = { ...bible, entries: [...bible.entries].sort((a,b) => compare(a.id,b.id))
    .map(e => ({ ...e, images: [...e.images].sort(compare) })) };
  return [...analysis].sort((a,b) => a.segment.idx-b.segment.idx || compare(a.segment.id,b.segment.id)).map(({ segment, analysis: data, subjects }) => {
    const lines = [...subjects].sort((a,b) => compare(a.subject_key,b.subject_key) || compare(a.id,b.id)).map(s => {
      const matches = mapping.filter(m => m.subject_id === s.id);
      if (matches.length !== 1) throw new Error(`Missing or ambiguous mapping: ${s.subject_key}`);
      const m = matches[0];
      return `${s.subject_key}: ${m.target_ref ?? m.target_type}; ${s.description}; ${s.motion_description}; ${s.composition}`;
    });
    const compiled = compileScene({ prompt: [preset.style,...preset.fragments,...lines,
      `Preserve motion, rhythm, composition, camera angle and duration (${segment.end_sec-segment.start_sec}s).`,
      data.motion,data.rhythm,data.composition,...preset.required,
      preset.faceless ? FACELESS_CLAUSE : '',...preset.forbidden.map(s => `Avoid: ${s}`),preset.disclosure,
      AI_DISCLOSURE].filter(Boolean).join('\n'), charactersPresent: [], location: '', camera: '', action: '' },
    orderedBible,{ maxReferenceImages: Number.MAX_SAFE_INTEGER });
    const references = compiled.references.sort((a,b) => compare(a.kind,b.kind) || compare(a.id,b.id) || compare(a.image,b.image) || compare(a.name,b.name))
      .slice(0,preset.maxReferenceImages);
    return { segmentId: segment.id, prompt: compiled.prompt, references };
  });
}
/** Each attempt costs ceil(duration seconds × configured integer credits/second). */
export function estimateMotionCredits(segments: readonly SourceSegment[], pricing: MotionPricing): number {
  if (!Number.isSafeInteger(pricing.variants) || pricing.variants < 1 ||
    !Number.isSafeInteger(pricing.creditsPerSecond) || pricing.creditsPerSecond < 0) throw new Error('Invalid motion pricing');
  const total = segments.reduce((sum,s) => {
    const duration = s.end_sec-s.start_sec;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid segment duration');
    return sum + Math.ceil(duration*pricing.creditsPerSecond)*pricing.variants;
  },0);
  if (!Number.isSafeInteger(total)) throw new Error('Credit estimate overflow');
  return total;
}
