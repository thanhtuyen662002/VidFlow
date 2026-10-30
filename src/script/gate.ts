import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ScriptScene } from '../types.ts';
import type { JsonSchema } from './llm/schema.ts';
import type { Dependencies } from './variants.ts';
import { scriptScenesSchema, validateScenes, evaluateVariant } from './variants.ts';
import { generateValidated } from './llm/generate.ts';
import { LlmValidationExhaustedError } from './llm/errors.ts';
import { loadSystemPrompt } from './prompts.ts';
import { createScriptVariant, getScriptVariant, updateScriptVariant } from '../repo/scripts.ts';
import { createScriptReview } from '../repo/script-reviews.ts';
import { createScriptDecision, listScriptDecisions } from '../repo/script-decisions.ts';
import { transaction } from '../repo/records.ts';

export class ScriptGateError extends Error {
  readonly code: string;
  readonly warningIds: string[];
  constructor(code: string, message: string, warningIds: string[] = []) {
    super(message); this.name = 'ScriptGateError'; this.code = code; this.warningIds = warningIds;
  }
}

// scriptId is the root variant id; versionId is any descendant variant id.
function version(db: DatabaseSync, scriptId: string, versionId: string) {
  const result = getScriptVariant(db, versionId);
  let ancestor = result;
  const visited = new Set<string>();
  while (ancestor && ancestor.id !== scriptId && !visited.has(ancestor.id)) {
    visited.add(ancestor.id);
    ancestor = ancestor.parentVariantId ? getScriptVariant(db, ancestor.parentVariantId) : undefined;
  }
  if (!result || !ancestor || ancestor.id !== scriptId || ancestor.projectId !== result.projectId)
    throw new ScriptGateError('VERSION_NOT_FOUND', 'Không tìm thấy phiên bản thuộc kịch bản.');
  validateScenes(result.scenes);
  return result;
}
function unchanged(db: DatabaseSync, before: ReturnType<typeof version>) {
  if (JSON.stringify(getScriptVariant(db, before.id)) !== JSON.stringify(before))
    throw new ScriptGateError('VERSION_CHANGED', 'Phiên bản đã thay đổi trong khi xử lý.');
}

export async function revise(options: Dependencies & {
  scriptId: string; baseVersionId: string; feedback: string[]; reviewerModel: string;
}) {
  const base = version(options.db, options.scriptId, options.baseVersionId);
  if (!options.feedback.length || options.feedback.some(item => !item.trim()) || !options.reviewerModel.trim())
    throw new ScriptGateError('INVALID_FEEDBACK', 'Cần nhận xét sửa và tên mô hình chấm điểm.');
  const schema: JsonSchema = { type: 'object', additionalProperties: false, required: ['scenes'], properties: { scenes: scriptScenesSchema } };
  const { value } = await generateValidated<{ scenes: ScriptScene[] }>({
    llm: options.llm, maxAttempts: options.maxAttempts, schema,
    system: await loadSystemPrompt('script-writer', options),
    prompt: JSON.stringify({ operation: 'revise', base, feedback: options.feedback, schema }),
  });
  try { validateScenes(value.scenes); } catch {
    throw new LlmValidationExhaustedError(1, [{ path: '$.scenes', message: 'Chỉ số cảnh không hợp lệ hoặc trùng lặp.' }]);
  }
  const candidate = { ...base, scenes: value.scenes, content: JSON.stringify(value) };
  const score = await evaluateVariant(options, candidate);
  return transaction(options.db, () => {
    unchanged(options.db, base);
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = candidate;
    const revised = createScriptVariant(options.db, { ...copy, versionNumber: base.versionNumber + 1,
      parentVariantId: base.id, isActive: false, status: 'scored', scores: { overall: score.score }, feedback: score.comment });
    createScriptReview(options.db, { ...score, variantId: revised.id, reviewerModel: options.reviewerModel });
    createScriptDecision(options.db, { variantId: revised.id, kind: 'revision', data: {
      parentVersionId: base.id, feedback: options.feedback, score: score.score, actor: 'owner', source: 'llm',
      decision: 'requested_revision',
    } });
    return { version: revised, scoreDelta: typeof base.scores.overall === 'number' ? score.score - base.scores.overall : null };
  });
}

export type RiskWarning = {
  id: string; category: string; severity: 'warning' | 'error';
  location: { sceneIndex: number; field: string; start: number; end: number; text: string };
  message: string; suggestedFix: string;
};
const rules: [string, RegExp, string][] = [
  ['real_person', /Taylor Swift|Elon Musk|người thật|giống hệt người nổi tiếng/giu, 'Thay bằng nhân vật hư cấu với diện mạo riêng.'],
  ['trademark', /Coca-Cola|Nike|Disney|thương hiệu/giu, 'Dùng nhãn hiệu hư cấu và bỏ logo nhận diện.'],
  ['violence', /máu me|chặt đầu|gore|beheading/giu, 'Thay bằng xung đột nhẹ, không mô tả thương tích.'],
  ['minors', /trẻ em|vị thành niên|minor/giu, 'Soát bối cảnh bảo vệ trẻ em; cân nhắc nhân vật trưởng thành.'],
  ['sexual', /khỏa thân|khiêu dâm|nude|porn/giu, 'Thay bằng nhân vật mặc trang phục phù hợp.'],
  ['claims', /chữa khỏi|cam kết lợi nhuận|cure cancer|guaranteed returns/giu, 'Bỏ cam kết y tế hoặc tài chính chưa được kiểm chứng.'],
  ['copyright', /Mickey Mouse|Harry Potter|nhạc có bản quyền/giu, 'Thay bằng nhân vật hoặc âm nhạc nguyên gốc được cấp phép.'],
  ['flow_policy', /vượt CAPTCHA|bypass safety|bỏ qua kiểm duyệt/giu, 'Bỏ yêu cầu vượt cơ chế kiểm duyệt.'],
  ['text_in_image', /chữ trong hình|text overlay/giu, 'Chuyển chữ sang bước dựng hậu kỳ.'],
];
function warningId(warning: Omit<RiskWarning, 'id'>) {
  return createHash('sha256').update(JSON.stringify([warning.category, warning.location])).digest('hex').slice(0, 24);
}
export async function reviewRisks(options: { db: DatabaseSync; scriptId: string; versionId: string;
  llm?: Dependencies['llm']; maxAttempts?: number }) {
  const current = version(options.db, options.scriptId, options.versionId);
  const warnings: RiskWarning[] = [];
  for (const scene of current.scenes as ScriptScene[]) {
    const fields = [['description', scene.description], ...scene.dialogue.flatMap((line, i) =>
      [[`dialogue.${i}.speaker`, line.speaker], [`dialogue.${i}.text`, line.text]])];
    for (const [field, text] of fields) for (const [category, pattern, suggestedFix] of rules) {
      for (const match of text.matchAll(pattern)) {
        const warning: Omit<RiskWarning, 'id'> = { category, severity: 'warning',
          location: { sceneIndex: scene.sceneIndex, field, start: match.index, end: match.index + match[0].length, text: match[0] },
          message: `Cần chủ sở hữu soát nội dung rủi ro: ${match[0]}.`, suggestedFix };
        warnings.push({ ...warning, id: warningId(warning) });
      }
    }
  }
  if (options.llm) {
    const text: JsonSchema = { type: 'string', minLength: 1 };
    const schema: JsonSchema = { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['category', 'severity', 'sceneIndex', 'text', 'message', 'suggestedFix'], properties: {
        category: text, severity: { type: 'string', enum: ['warning', 'error'] }, sceneIndex: { type: 'integer', minimum: 1 },
        text, message: text, suggestedFix: text,
      } } };
    const { value } = await generateValidated<{ category: string; severity: 'warning' | 'error'; sceneIndex: number; text: string; message: string; suggestedFix: string }[]>({
      llm: options.llm, maxAttempts: options.maxAttempts, schema,
      system: 'Soát rủi ro. Chỉ trả JSON theo schema; thông báo và đề xuất sửa bằng tiếng Việt.',
      prompt: JSON.stringify({ scenes: current.scenes, schema }),
    });
    for (const item of value) {
      const scene = (current.scenes as ScriptScene[]).find(scene => scene.sceneIndex === item.sceneIndex);
      const fields = scene && [['description', scene.description], ...scene.dialogue.map((line, i) => [`dialogue.${i}.text`, line.text])];
      const found = fields?.find(([, text]) => text.includes(item.text));
      if (!found || !item.message.trim() || !item.suggestedFix.trim())
        throw new LlmValidationExhaustedError(1, [{ path: '$', message: 'Cảnh báo không có vị trí hoặc đề xuất hợp lệ.' }]);
      const start = found[1].indexOf(item.text);
      const warning: Omit<RiskWarning, 'id'> = { category: item.category, severity: item.severity, message: item.message,
        suggestedFix: item.suggestedFix, location: { sceneIndex: item.sceneIndex, field: found[0], start, end: start + item.text.length, text: item.text } };
      warnings.push({ ...warning, id: warningId(warning) });
    }
  }
  const unique = [...new Map(warnings.map(w => [w.id, w])).values()];
  transaction(options.db, () => {
    unchanged(options.db, current);
    createScriptDecision(options.db, { variantId: current.id, kind: 'risk_review', data: {
      warnings: unique, contentHash: contentHash(current),
    } });
  });
  return unique;
}
function latestReview(db: DatabaseSync, versionId: string) {
  return listScriptDecisions(db, versionId).filter(record => record.kind === 'risk_review').at(-1);
}
function contentHash(current: ReturnType<typeof version>) {
  return createHash('sha256').update(JSON.stringify([current.content, current.scenes])).digest('hex');
}
export function overrideWarning(db: DatabaseSync, scriptId: string, versionId: string, warningId: string, reason: string) {
  return transaction(db, () => {
    const current = version(db, scriptId, versionId);
    if (!reason.trim()) throw new ScriptGateError('REASON_REQUIRED', 'Phải ghi lý do bỏ qua cảnh báo.');
    const review = latestReview(db, versionId);
    if (review?.data.contentHash !== contentHash(current))
      throw new ScriptGateError('RISK_REVIEW_REQUIRED', 'Cần soát lại rủi ro cho nội dung hiện tại.');
    const warnings = review?.data.warnings as RiskWarning[] | undefined;
    if (!warnings?.some(w => w.id === warningId)) throw new ScriptGateError('WARNING_NOT_FOUND', 'Không tìm thấy cảnh báo.');
    return createScriptDecision(db, { variantId: versionId, kind: 'override', data: { warningId, reason: reason.trim(), actor: 'owner', timestamp: new Date().toISOString() } });
  });
}
export function acceptRevision(db: DatabaseSync, scriptId: string, versionId: string) {
  return transaction(db, () => {
    const current = version(db, scriptId, versionId);
    if (!current.parentVariantId) throw new ScriptGateError('NOT_REVISION', 'Phiên bản này không phải bản sửa.');
    return createScriptDecision(db, { variantId: versionId, kind: 'accept_revision', data: { actor: 'owner', versionId } });
  });
}
export function approve(db: DatabaseSync, scriptId: string, versionId: string) {
  return transaction(db, () => {
    const current = version(db, scriptId, versionId);
    const review = latestReview(db, versionId);
    if (!review) throw new ScriptGateError('RISK_REVIEW_REQUIRED', 'Chưa soát rủi ro; cần soát trước khi duyệt.');
    if (review.data.contentHash !== contentHash(current))
      throw new ScriptGateError('RISK_REVIEW_REQUIRED', 'Nội dung đã thay đổi; cần soát lại rủi ro trước khi duyệt.');
    const overrides = listScriptDecisions(db, versionId).filter(record => record.kind === 'override' && String(record.data.reason ?? '').trim());
    const warnings = review.data.warnings as RiskWarning[];
    const unresolved = warnings.filter(w => !overrides.some(record => record.data.warningId === w.id)).map(w => w.id);
    if (unresolved.length) throw new ScriptGateError('UNRESOLVED_WARNINGS', `Còn cảnh báo chưa xử lý: ${unresolved.join(', ')}.`, unresolved);
    const record = createScriptDecision(db, { variantId: versionId, kind: 'approval', data: {
      versionId, approvedAt: new Date().toISOString(), actor: 'owner', overrides: overrides.map(record => record.data),
    } });
    // setActive owns a transaction; perform its equivalent inside this transaction.
    db.prepare('UPDATE script_variants SET is_active=0 WHERE project_id=(SELECT project_id FROM script_variants WHERE id=?)').run(versionId);
    updateScriptVariant(db, versionId, { status: 'approved', isActive: true });
    return record;
  });
}
