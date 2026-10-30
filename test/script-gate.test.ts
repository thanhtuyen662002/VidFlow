import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createScriptVariant, getScriptVariant, listScriptVariants } from '../src/repo/scripts.ts';
import { listScriptDecisions } from '../src/repo/script-decisions.ts';
import { revise, reviewRisks, overrideWarning, approve, acceptRevision, ScriptGateError } from '../src/script/variants.ts';
import { LlmValidationExhaustedError } from '../src/script/llm/errors.ts';
import { MockLlm } from '../src/script/llm/mock.ts';
import type { TestContext } from 'node:test';

const scene = { sceneIndex: 1, durationSec: 5, description: 'Khu vườn yên bình', dialogue: [] };
function setup(t: TestContext, description = scene.description) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Kịch bản', '16:9', null);
  const base = createScriptVariant(db, { projectId: project.id, scenes: [{ ...scene, description }],
    content: JSON.stringify({ scenes: [{ ...scene, description }] }), scores: { overall: 3 }, isActive: true });
  return { db, base, scriptId: base.id, baseVersionId: base.id, reviewerModel: 'fake' };
}
const improved = JSON.stringify({ scenes: [scene] });
const score = JSON.stringify({ score: 9, comment: 'Nhịp rõ và gọn hơn', issues: [] });
test('needs revision: immutable child, improved score and readable owner decision', async t => {
  const deps = setup(t); const before = getScriptVariant(deps.db, deps.base.id);
  const result = await revise({ ...deps, llm: new MockLlm([improved, score]), feedback: ['Làm rõ nhịp cảnh'] });
  assert.notEqual(result.version.id, deps.base.id);
  assert.equal(result.version.parentVariantId, deps.base.id);
  assert.equal(result.version.versionNumber, 2);
  assert.equal(result.scoreDelta, 6);
  assert.deepEqual(getScriptVariant(deps.db, deps.base.id), before);
  assert.equal(getScriptVariant(deps.db, deps.base.id)?.isActive, true);
  assert.equal(listScriptDecisions(deps.db, result.version.id)[0].data.source, 'llm');
  acceptRevision(deps.db, deps.scriptId, result.version.id);
  assert.equal(listScriptDecisions(deps.db, result.version.id).at(-1)?.kind, 'accept_revision');
});
test('risky content blocks gate, requires reason, persists override and approval', async t => {
  const deps = setup(t, 'Mickey Mouse xuất hiện');
  assert.throws(() => approve(deps.db, deps.scriptId, deps.base.id), error => error instanceof ScriptGateError && error.code === 'RISK_REVIEW_REQUIRED');
  const warnings = await reviewRisks({ ...deps, versionId: deps.base.id });
  assert.ok(warnings.length); assert.ok(warnings[0].suggestedFix.trim());
  assert.equal(warnings[0].location.text, 'Mickey Mouse');
  const again = await reviewRisks({ ...deps, versionId: deps.base.id });
  assert.equal(again[0].id, warnings[0].id);
  assert.throws(() => approve(deps.db, deps.scriptId, deps.base.id), error => error instanceof ScriptGateError && error.warningIds.includes(warnings[0].id));
  for (const reason of ['', '   ']) assert.throws(() => overrideWarning(deps.db, deps.scriptId, deps.base.id, warnings[0].id, reason), ScriptGateError);
  overrideWarning(deps.db, deps.scriptId, deps.base.id, warnings[0].id, 'Đã có quyền sử dụng');
  const saved = listScriptDecisions(deps.db, deps.base.id).find(r => r.kind === 'override')!;
  assert.equal(saved.data.reason, 'Đã có quyền sử dụng'); assert.equal(saved.data.actor, 'owner'); assert.ok(saved.data.timestamp);
  const file = deps.db.prepare('PRAGMA database_list').get()!.file as string;
  const reopened = new DatabaseSync(file);
  try {
    assert.deepEqual(listScriptDecisions(reopened, deps.base.id).find(r => r.kind === 'override'), saved);
  } finally { reopened.close(); }
  const content = getScriptVariant(deps.db, deps.base.id)?.content;
  approve(deps.db, deps.scriptId, deps.base.id);
  assert.equal(getScriptVariant(deps.db, deps.base.id)?.status, 'approved');
  assert.equal(getScriptVariant(deps.db, deps.base.id)?.content, content);
  const approval = listScriptDecisions(deps.db, deps.base.id).at(-1)!;
  assert.equal(approval.kind, 'approval');
  assert.equal((approval.data.overrides as { reason: string }[])[0].reason, saved.data.reason);
});
test('fix via revise then review permits approval without inheriting overrides', async t => {
  const deps = setup(t, 'Mickey Mouse xuất hiện');
  await reviewRisks({ ...deps, versionId: deps.base.id });
  const { version } = await revise({ ...deps, llm: new MockLlm([improved, score]), feedback: ['Thay bằng nhân vật nguyên gốc'] });
  assert.throws(() => approve(deps.db, deps.scriptId, version.id), ScriptGateError);
  assert.deepEqual(await reviewRisks({ ...deps, versionId: version.id }), []);
  const approval = approve(deps.db, deps.scriptId, version.id);
  assert.deepEqual(approval.data.overrides, []);
  assert.equal(getScriptVariant(deps.db, deps.base.id)?.isActive, false);
  assert.equal(getScriptVariant(deps.db, version.id)?.isActive, true);
});
function snapshot(db: ReturnType<typeof temporaryDatabase>) {
  return ['script_variants', 'script_reviews', 'script_decisions'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
test('invalid revisions and invalid scores leave every record and active pointer unchanged', async t => {
  const deps = setup(t);
  const before = snapshot(deps.db);
  for (const responses of [['{"scenes":'], ['{}'], [JSON.stringify({ scenes: [{ ...scene, durationSec: -2 }] })],
    [JSON.stringify({ scenes: [scene, scene] })], [improved, '{bad score']]) {
    await assert.rejects(revise({ ...deps, llm: new MockLlm(responses), maxAttempts: 1, feedback: ['Sửa nhịp'] }), LlmValidationExhaustedError);
    assert.deepEqual(snapshot(deps.db), before);
    assert.equal(listScriptVariants(deps.db, deps.base.projectId).length, 1);
  }
});
test('transaction failure rolls back child and review', async t => {
  const deps = setup(t); const before = snapshot(deps.db);
  deps.db.exec("CREATE TRIGGER reject_decision BEFORE INSERT ON script_decisions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(revise({ ...deps, llm: new MockLlm([improved, score]), feedback: ['Sửa nhịp'] }), /test failure/);
  assert.deepEqual(snapshot(deps.db), before);
});
test('AI checker is optional, validated and cannot approve or persist partial review', async t => {
  const deps = setup(t);
  const flag = { category: 'custom', severity: 'warning', sceneIndex: 1, text: 'Khu vườn', message: 'Cần kiểm tra quyền sử dụng.', suggestedFix: 'Dùng bối cảnh nguyên gốc.' };
  const warnings = await reviewRisks({ ...deps, versionId: deps.base.id, llm: new MockLlm([JSON.stringify([flag])]) });
  assert.equal(warnings.length, 1);
  const before = snapshot(deps.db);
  await assert.rejects(reviewRisks({ ...deps, versionId: deps.base.id, llm: new MockLlm([JSON.stringify([{ ...flag, text: 'không tồn tại' }])]), maxAttempts: 1 }), LlmValidationExhaustedError);
  assert.deepEqual(snapshot(deps.db), before);
  assert.throws(() => approve(deps.db, deps.scriptId, deps.base.id), ScriptGateError);
});
