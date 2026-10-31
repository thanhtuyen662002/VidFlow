import type { Completion, CompletionRequest, LlmClient } from './types.ts';

export const SAMPLE_SCRIPT = {
  logline: 'A gardener restores a dry garden.', audience: 'Families', value: 'Small acts help nature.',
  beats: [{ beat: 'Hook', durationUsed: 3 }],
  scenes: [{ index: 0, beat: 'Hook', durationUsed: 3, moment: 'Water reaches a seed', camera: 'Close up',
    action: 'A gardener waters the seed', dialogue: '', sfx: 'Water', charactersPresent: ['Gardener'],
    location: 'Garden', transition: 'cut', groupId: null, mode: 'text' }],
};
export type MockResponse = string | ((request: CompletionRequest, call: number) => string | Promise<string>);
export const SAMPLE_MOTION = {
  motion: 'Cooking with a pan', rhythm: 'Steady', composition: 'Kitchen close up',
  subjects: [
    { subject_key: 'person_1', kind: 'person', has_human_face: true, description: 'Cook' },
    { subject_key: 'hands', kind: 'hand', has_human_face: false, description: 'Stirring hands' },
    { subject_key: 'pan', kind: 'object', has_human_face: false, description: 'Pan' },
    { subject_key: 'kitchen', kind: 'scene', has_human_face: false, description: 'Kitchen' },
  ].map(s => ({ ...s, motion_description: 'Steady stirring', composition: 'Center frame' })),
};
export class MockLlm implements LlmClient {
  calls = 0;
  readonly responses: readonly MockResponse[];
  constructor(responses: readonly MockResponse[] = [request => JSON.stringify(request.prompt.includes('"task":"motion_subjects"') ? SAMPLE_MOTION : SAMPLE_SCRIPT)]) {
    if (!responses.length) throw new RangeError('Mock responses must not be empty');
    this.responses = [...responses];
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    request.signal?.throwIfAborted();
    const response = this.responses[Math.min(this.calls++, this.responses.length - 1)];
    return { text: typeof response === 'function' ? await response(request, this.calls) : response };
  }
}
