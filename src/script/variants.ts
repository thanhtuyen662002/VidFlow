import type { DatabaseSync } from 'node:sqlite';
import type { ScriptIssue, ScriptReview, ScriptScene, ScriptVariant } from '../types.ts';
import type { LlmClient } from './llm/types.ts';
import type { JsonSchema } from './llm/schema.ts';
import { validateSchema } from './llm/schema.ts';
import { generateValidated } from './llm/generate.ts';
import { LlmValidationExhaustedError } from './llm/errors.ts';
import { getProject } from '../repo/projects.ts';
import { createScriptVariant, getScriptVariant, listScriptVariants, updateScriptVariant } from '../repo/scripts.ts';
import { createScriptReview } from '../repo/script-reviews.ts';
import { transaction } from '../repo/records.ts';
import { loadSystemPrompt } from './prompts.ts';
import { checkDialogueLength } from './dialogue.ts';
export { revise, reviewRisks, overrideWarning, approve, acceptRevision, ScriptGateError } from './gate.ts';
export type { RiskWarning } from './gate.ts';

const text: JsonSchema = { type: 'string', minLength: 1 };
const index: JsonSchema = { type: 'integer', minimum: 1 };
export const scriptScenesSchema: JsonSchema = { type: 'array', minItems: 1, items: {
  type: 'object', additionalProperties: false, required: ['sceneIndex', 'durationSec', 'description', 'dialogue'],
  properties: { sceneIndex: index, durationSec: { type: 'number', minimum: 0.001 }, description: text,
    dialogue: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['speaker', 'text'], properties: { speaker: text, text: { type: 'string' } } } } },
} };
const reviewSchema: JsonSchema = { type: 'object', additionalProperties: false,
  required: ['score', 'comment', 'issues'], properties: {
    score: { type: 'number', minimum: 0, maximum: 10 }, comment: text,
    issues: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['sceneIndex', 'type', 'severity', 'message'], properties: {
        sceneIndex: index, type: text, severity: { type: 'string', enum: ['info', 'warning', 'error'] }, message: text,
      } } },
  } };
export type Dependencies = { db: DatabaseSync; llm: LlmClient; promptsDir?: string; maxAttempts?: number };

export function validateScenes(scenes: unknown): asserts scenes is ScriptScene[] {
  if (!validateSchema(scenes, scriptScenesSchema).valid) throw new Error('Invalid script scenes');
  const indices = (scenes as ScriptScene[]).map(scene => scene.sceneIndex);
  if (new Set(indices).size !== indices.length) throw new Error('Duplicate sceneIndex');
}

export async function generateVariants(options: Dependencies & {
  projectId: string; brief: string; references?: unknown; count: number; sceneDurations?: number[];
}): Promise<ScriptVariant[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 1) throw new RangeError('count must be a positive integer');
  if (!getProject(options.db, options.projectId)) throw new Error('Project not found');
  if (options.sceneDurations?.some(duration => !Number.isFinite(duration) || duration <= 0)) throw new RangeError('Invalid sceneDurations');
  const schema: JsonSchema = { type: 'object', additionalProperties: false, required: ['variants'], properties: {
    variants: { type: 'array', minItems: options.count, maxItems: options.count, items: {
      type: 'object', additionalProperties: false, required: ['scenes'], properties: { scenes: scriptScenesSchema },
    } },
  } };
  const { value } = await generateValidated<{ variants: { scenes: ScriptScene[] }[] }>({
    llm: options.llm, maxAttempts: options.maxAttempts,
    system: await loadSystemPrompt('script-writer', options),
    prompt: JSON.stringify({ brief: options.brief, references: options.references, count: options.count,
      sceneDurations: options.sceneDurations, schema }),
    schema,
  });
  value.variants.forEach(variant => validateScenes(variant.scenes));
  return transaction(options.db, () => value.variants.map(variant => createScriptVariant(options.db, {
    projectId: options.projectId, scenes: variant.scenes, content: JSON.stringify(variant), status: 'draft',
  })));
}

/** Content edits create a draft child; the original and its reviews remain intact. */
export function editVariant(db: DatabaseSync, variantId: string, scenes: ScriptScene[]): ScriptVariant {
  validateScenes(scenes);
  return transaction(db, () => {
    const previous = getScriptVariant(db, variantId);
    if (!previous) throw new Error('Script variant not found');
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = previous;
    return createScriptVariant(db, { ...copy, scenes, content: JSON.stringify({ scenes }),
      versionNumber: previous.versionNumber + 1, parentVariantId: previous.id,
      status: 'draft', isActive: false, scores: {}, feedback: '' });
  });
}

export async function scoreVariants(options: Dependencies & {
  variantIds?: string[]; projectId?: string; reviewerModel: string; wordsPerSecond?: number;
}): Promise<ScriptReview[]> {
  if (options.wordsPerSecond !== undefined && (!Number.isFinite(options.wordsPerSecond) || options.wordsPerSecond <= 0)) throw new RangeError('wordsPerSecond must be positive');
  if (!options.reviewerModel.trim()) throw new Error('reviewerModel is required');
  if ((options.variantIds === undefined) === (options.projectId === undefined)) throw new Error('Provide variantIds or projectId');
  if (options.projectId !== undefined && !getProject(options.db, options.projectId)) throw new Error('Project not found');
  const variants = options.variantIds === undefined ? listScriptVariants(options.db, options.projectId!) :
    [...new Set(options.variantIds)].map(id => {
      const variant = getScriptVariant(options.db, id);
      if (!variant) throw new Error(`Script variant not found: ${id}`);
      return variant;
    });
  variants.forEach(variant => validateScenes(variant.scenes));
  const pending: { variant: ScriptVariant; review: { score: number; comment: string; issues: ScriptIssue[] } }[] = [];
  for (const variant of variants) {
    pending.push({ variant, review: await evaluateVariant(options, variant) });
  }
  return transaction(options.db, () => pending.map(({ variant, review }) => {
    // An asynchronous LLM request must not attach a review to content edited in the meantime.
    if (JSON.stringify(getScriptVariant(options.db, variant.id)) !== JSON.stringify(variant)) throw new Error('Variant changed while scoring');
    const saved = createScriptReview(options.db, { ...review, variantId: variant.id, reviewerModel: options.reviewerModel });
    updateScriptVariant(options.db, variant.id, { status: 'scored', scores: { overall: review.score }, feedback: review.comment });
    return saved;
  }));
}

export async function evaluateVariant(options: Dependencies & { wordsPerSecond?: number }, variant: ScriptVariant) {
    const system = await loadSystemPrompt('script-editor', options);
    const { value } = await generateValidated<{ score: number; comment: string; issues: ScriptIssue[] }>({
      llm: options.llm, maxAttempts: options.maxAttempts, system,
      prompt: JSON.stringify({ variant, schema: reviewSchema }), schema: reviewSchema,
    });
    const scenes = variant.scenes as ScriptScene[];
    if (value.issues.some(issue => !scenes.some(scene => scene.sceneIndex === issue.sceneIndex)))
      throw new LlmValidationExhaustedError(1, [{ path: '$.issues', message: 'Nhận xét tham chiếu cảnh không tồn tại.' }]);
    const issues = scenes.map(scene => checkDialogueLength(scene, options)).filter((issue): issue is ScriptIssue => issue !== undefined);
    return { ...value, issues: [...value.issues, ...issues] };
}
