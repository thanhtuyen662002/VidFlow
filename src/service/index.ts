import { getScriptGate, skipScriptGate } from '../script/gate.ts';
import { saveProjectAsTemplate, createProjectFromTemplate, listTemplates, getTemplate, deleteTemplate } from '../repo/templates.ts';
import { createProgressSource } from './progress.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { LlmClient } from '../script/llm/types.ts';
import type { FlowJobDriver } from '../flow/jobDriver.ts';
import type { JsonSchema, ValidationError } from '../script/llm/schema.ts';
import { validateSchema } from '../script/llm/schema.ts';
import { createProject, getProject, listProjects, updateProject } from '../repo/projects.ts';
import { projectCommittedCredits } from '../render/budget.ts';
import { requestSceneRework, decideRework } from '../render/rework.ts';
import { configureMcp, revokeMcp, createMcpSettingsStore } from '../app/mcp/settings.ts';
import { rejectStoryboard } from '../script/storyboard.ts';
import { BibleService } from '../prompt/bible.ts';
import { getBible, setBible } from '../repo/bibles.ts';
import { getScriptVariant } from '../repo/scripts.ts';
import { generateVariants, scoreVariants, revise, reviewRisks, approve, overrideWarning, ScriptGateError } from '../script/variants.ts';
import { generateStoryboard, getStoryboard, initializeStoryboards, approveStoryboard, approvedStoryboardPlan, StoryboardGateError } from '../script/storyboard.ts';
import { getRenderPlan } from '../render/plans.ts';
import { runRenderPlan, createLlmTakeReviewer, getReviewScene, resolveSelection } from '../render/orchestrator.ts';
import type { TakeReviewer } from '../render/orchestrator.ts';
import { setOwnerOverrideAndRefresh } from '../render/frameChain.ts';
import { listByScene } from '../repo/renders.ts';
import { createAccount, getAccount, listAccounts, setAccountStatus } from '../flow/accounts.ts';
import { addEntry, getBalance, listEntries } from '../flow/credits.ts';
import { listJobs } from '../flow/queue.ts';
import { buildTimelineFromSelectedTakes, getTimeline } from '../edit/timeline.ts';
import { importAnalyticsCsv, listProposals, acceptProposal, rejectProposal, ProposalConflictError } from '../script/analytics.ts';
import { CsvImportError } from '../script/analytics-csv.ts';
import { exportFinal } from '../edit/export.ts';
import { buildPublishPackage, collectMusicLicenses } from '../edit/package.ts';
import { buildCapcutDraft, writeCapcutDraft } from '../edit/capcut.ts';
import { mix } from '../edit/audio.ts';
import { probe } from '../media/probe.ts';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { sanitize, collectSecrets } from './sanitize.ts';
import { ValidationError as InputValidationError, projectName, referenceInput, referenceImages } from '../validate.ts';
import { UnsafePathError } from '../media/errors.ts';
import { DuplicateError } from '../types.ts';
import { NoSelectedTakeError, InvalidTimelineSelectionError } from '../edit/timeline.ts';
import { storyboardPreviewPlan } from '../script/storyboard.ts';

export type ErrorCode = 'VALIDATION_ERROR' | 'UNKNOWN_COMMAND' | 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_ERROR' | 'NOT_SUPPORTED';
export type ServiceResult = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode; message: string; details: ValidationError[] } };
class ServiceError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
export interface ServiceDependencies {
  db: DatabaseSync; llm: LlmClient; flowDriver: FlowJobDriver; clock?: () => Date; promptsDir?: string;
  reviewer?: TakeReviewer; duration?: (file: string) => Promise<number>;
  exitFrame?: Parameters<typeof runRenderPlan>[0]['exitFrame'];
  media?: { exportFinal?: typeof exportFinal; mix?: typeof mix };
  /** Trusted integration secrets to scrub even when echoed under innocent field names. */
  sensitiveValues?: readonly string[];
}
const text: JsonSchema = { type: 'string', minLength: 1, maxLength: 10000 };
const num: JsonSchema = { type: 'number', minimum: 0 };
const integer: JsonSchema = { type: 'integer', minimum: 1, maximum: 100 };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const output = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema =>
  ({ type: 'object', properties, required });
const identified = output({ id: text });
const array = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const projectInput = object({ projectId: text });
const planInput = object({ planId: text });
const versionInput = object({ scriptId: text, versionId: text });
const accountSchema = object({ id: text, label: text, status: text, remainingCredits: { type: 'number' } });
const projectSchema = object({ id: text, name: text, aspect: text, budget: { type: ['number', 'null'] }, status: text, directory: text, created_at: text });
const referenceSchema = object({ id: text, project_id: text, name: text, role: text, kind: text, images: array(text), description: text, priority: { type: 'integer' } });
const bibleSchema = object({ id: text, project_id: text, style: { type: 'string' }, lighting: { type: 'string' }, palette: { type: 'string' }, lens: { type: 'string' }, avoid: { type: 'string' }, safe_area: { type: 'string' } });
const scriptSchema = output({ id: text, projectId: text, versionNumber: integer, parentVariantId: { type: ['string', 'null'] },
  content: text, status: { type: 'string', enum: ['draft', 'scored', 'approved', 'rejected'] }, isActive: { type: 'boolean' },
  scenes: array(output({ sceneIndex: integer, durationSec: num, description: text, dialogue: array(output({ speaker: text, text: { type: 'string' } })) })),
  scores: { type: 'object' }, createdAt: text, updatedAt: text });
const stepSchema = output({ id: text, planId: text, sceneId: text, chainId: text, chainIndex: { type: 'integer' },
  dependsOnStepId: { type: ['string', 'null'] }, compiledPrompt: text, estimatedCredits: num, status: text, updatedAt: text });
const planSchema = output({ id: text, projectId: text, inputHash: text, status: text, estimatedCredits: num, steps: array(stepSchema), createdAt: text, updatedAt: text });
const storyboardSchema = object({ id: text, projectId: text, variantId: text, planId: text, inputHash: text,
  status: { type: 'string', enum: ['draft', 'approved'] }, createdAt: text, approvedAt: { type: ['string', 'null'] }, shots: array(stepSchema) });
const takeSchema = output({ id: text, sceneId: text, renderJobId: text, file: text, durationSec: num, selected: { type: 'boolean' }, metadata: { type: 'object' } });
export function createCoreService(deps: ServiceDependencies) {
  const { db } = deps;
  let mcpSettingsStore = createMcpSettingsStore(db);
  const activeRenders = new Map<string, AbortController>();
  const settingsView = () => {
    const config = mcpSettingsStore.getSettings().mcp;
    return { enabled: config?.enabled ?? false, credentialConfigured: Boolean(config?.token), credentialLocation: 'Cơ sở dữ liệu riêng của VidFlow (app_mcp_settings)' };
  };
  const progress = createProgressSource();
  const progressDriver: FlowJobDriver = { async run(job, account, ctx) {
    const event = (status: string) => progress.emit({ jobId: job.id, status, timestamp: (deps.clock?.() ?? new Date()).toISOString() });
    event('running');
    try {
      const result = await deps.flowDriver.run(job, account, ctx);
      event(result.kind === 'success' ? 'completed' : result.kind === 'verification_required' ? 'needs_owner' : 'failed');
      return result;
    } catch (error) { event('failed'); throw error; }
  } };
  initializeStoryboards(db);
  const secrets = new Set(deps.sensitiveValues ?? []);
  const registry = new Map<string, { name: string; inputSchema: JsonSchema; outputSchema: JsonSchema; handler: (input: unknown) => unknown | Promise<unknown> }>();
  function register<T>(name: string, inputSchema: JsonSchema, outputSchema: JsonSchema, handler: (input: T) => unknown | Promise<unknown>) {
    if (registry.has(name)) throw new Error('Duplicate command');
    registry.set(name, { name, inputSchema, outputSchema, handler: input => handler(input as T) });
  }
  function need<T>(value: T | undefined | null): T {
    if (value == null) throw new ServiceError('NOT_FOUND', 'Requested record does not exist');
    return value;
  }
  const project = (id: string) => need(getProject(db, id));
  register<{ projectId: string; name: string }>('template.save', object({ projectId: text, name: text }), identified, i => saveProjectAsTemplate(db, i.projectId, i));
  register<{ templateId: string; name: string }>('template.createProject', object({ templateId: text, name: text }), projectSchema, i => createProjectFromTemplate(db, i.templateId, i));
  register('template.list', object({}), array(identified), () => listTemplates());
  register<{ id: string }>('template.get', object({ id: text }), identified, i => getTemplate(i.id));
  register<{ id: string }>('template.delete', object({ id: text }), { type: 'boolean' }, i => deleteTemplate(i.id));
  register<{ projectId: string; timelineId: string; csvPath: string }>('analytics.import', object({ projectId: text, timelineId: text, csvPath: text }), output({}), i => importAnalyticsCsv(db, i.projectId, i.timelineId, i.csvPath));
  register<{ projectId: string }>('analytics.list', projectInput, array(output({})), i => { project(i.projectId); return listProposals(db, i.projectId); });
  register<{ id: string }>('analytics.accept', object({ id: text }), output({}), i => acceptProposal(db, i.id));
  register<{ id: string }>('analytics.reject', object({ id: text }), output({}), i => rejectProposal(db, i.id));
  const safeAccount = (a: NonNullable<ReturnType<typeof getAccount>>) => ({ id: a.id, label: a.label, status: a.status, remainingCredits: getBalance(db, String(a.id)) });
  const board = (id: string) => need(getStoryboard(db, id));
  const budgetView = (id: string) => ({ used: projectCommittedCredits(db, project(id).id), limit: project(id).budget });
  const budgetSchema = output({ used: num, limit: { type: ['number', 'null'] } });
  const settingsSchema = output({ enabled: { type: 'boolean' }, credentialConfigured: { type: 'boolean' }, credentialLocation: text });
  register('settings.get', object({}), settingsSchema, settingsView);
  register<{ enabled: boolean }>('settings.configure', object({ enabled: { type: 'boolean' } }), settingsSchema, async i => {
    await configureMcp(mcpSettingsStore, i.enabled, mcpSettingsStore.getSettings().mcp?.port ?? 0); return settingsView();
  });
  register('settings.rotate', object({}), settingsSchema, async () => {
    const config = mcpSettingsStore.getSettings().mcp;
    await configureMcp(mcpSettingsStore, true, config?.port ?? 0, true); return settingsView();
  });
  register('settings.revoke', object({}), settingsSchema, async () => { await revokeMcp(mcpSettingsStore); return settingsView(); });
  register<{ projectId: string }>('budget.get', projectInput, budgetSchema, i => budgetView(i.projectId));
  register<{ projectId: string; limit: number | null }>('budget.set', object({ projectId: text, limit: { type: ['number', 'null'], minimum: 0 } }), budgetSchema, i => {
    project(i.projectId); updateProject(db, i.projectId, { budget: i.limit }); return budgetView(i.projectId);
  });
  register<{ name: string; aspect: string; budget?: number }>('project.create', object({ name: { ...text, maxLength: 100 }, aspect: { type: 'string', enum: ['16:9', '9:16'] }, budget: num }, ['name', 'aspect']), projectSchema,
    i => createProject(db, i.name, i.aspect, i.budget ?? null));
  register('project.list', object({}), array(projectSchema), () => listProjects(db));
  register<{ projectId: string }>('project.get', projectInput, projectSchema, i => project(i.projectId));
  register<{ projectId: string; name: string; kind: 'character' | 'location' | 'prop' | 'style'; images: string[]; description: string; priority: number }>('reference.add', object({ projectId: text, name: text, kind: { type: 'string', enum: ['character', 'location', 'prop', 'style'] }, images: { ...array(text), minItems: 1 }, description: text, priority: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }), referenceSchema,
    i => { project(i.projectId); return new BibleService(db).add(i.projectId, i); });
  register<{ projectId: string }>('reference.list', projectInput, array(referenceSchema), i => { project(i.projectId); return new BibleService(db).list(i.projectId); });
  register<{ projectId: string }>('bible.get', projectInput, output({}), i => {
    project(i.projectId);
    const saved = getBible(db, i.projectId);
    return Object.fromEntries(['style', 'lighting', 'palette', 'lens', 'avoid', 'safe_area'].map(key => [key, saved?.[key] ?? '']));
  });
  register<{ projectId: string; refId: string }>('reference.remove', object({ projectId: text, refId: text }), { type: 'boolean' }, i => {
    project(i.projectId);
    return new BibleService(db).delete(i.projectId, i.refId, true);
  });
  register<{ projectId: string }>('script.getGate', projectInput, output({}), i => { project(i.projectId); return getScriptGate(db, i.projectId); });
  register<{ projectId: string; reason: string }>('script.skip', object({ projectId: text, reason: text }), output({}), i => { project(i.projectId); return skipScriptGate(db, i.projectId, i.reason); });
  const bibleFields = Object.fromEntries(['style','lighting','palette','lens','avoid','safe_area'].map(k => [k, { type: 'string' } as JsonSchema]));
  register<{ projectId: string; fields: Parameters<typeof setBible>[2] }>('bible.update', object({ projectId: text, fields: object(bibleFields, []) }), bibleSchema,
    i => { project(i.projectId); return setBible(db, i.projectId, i.fields); });
  register<{ projectId: string; brief: string; count: number }>('script.generate', object({ projectId: text, brief: text, count: integer }), array(scriptSchema),
    i => { project(i.projectId); return generateVariants({ ...deps, ...i, references: new BibleService(db).list(i.projectId) }); });
  register<{ projectId: string; reviewerModel: string }>('script.score', object({ projectId: text, reviewerModel: text }), array(identified), i => scoreVariants({ ...deps, ...i }));
  register<{ scriptId: string; baseVersionId: string; feedback: string[]; reviewerModel: string }>('script.revise', object({ scriptId: text, baseVersionId: text, feedback: { ...array(text), minItems: 1 }, reviewerModel: text }), output({ version: identified }), i => revise({ ...deps, ...i }));
  register<{ scriptId: string; versionId: string }>('script.review', versionInput, array(output({ id: text })), i => reviewRisks({ db, ...i }));
  register<{ scriptId: string; versionId: string; warningId: string; reason: string }>('script.override', object({ scriptId: text, versionId: text, warningId: text, reason: text }), identified, i => overrideWarning(db, i.scriptId, i.versionId, i.warningId, i.reason));
  register<{ scriptId: string; versionId: string }>('script.approve', versionInput, identified, async i => {
    need(getScriptVariant(db, i.versionId)); await reviewRisks({ db, ...i }); return approve(db, i.scriptId, i.versionId);
  });
  register<{ variantId: string }>('storyboard.generate', object({ variantId: text }), storyboardSchema, i => { need(getScriptVariant(db, i.variantId)); return generateStoryboard(db, i.variantId, deps.clock); });
  register<{ storyboardId: string }>('storyboard.approve', object({ storyboardId: text }), storyboardSchema, i => approveStoryboard(db, board(i.storyboardId), deps.clock));
  register<{ storyboardId: string }>('storyboard.reject', object({ storyboardId: text }), storyboardSchema, i => rejectStoryboard(db, board(i.storyboardId)));
  register<{ storyboardId: string }>('storyboard.get', object({ storyboardId: text }), storyboardSchema, i => board(i.storyboardId));
  register<{ storyboardId: string; images: { sceneId: string; path: string; duration: number }[] }>('storyboard.preview', object({ storyboardId: text, images: { ...array(object({ sceneId: text, path: text, duration: { type: 'number', minimum: 0.001 } })), minItems: 1 } }), output({ path: text, args: array(text), timeoutMs: num }), i => storyboardPreviewPlan(db, board(i.storyboardId), i.images));
  register<{ storyboardId: string }>('render.enqueue', object({ storyboardId: text }), planSchema, i => approvedStoryboardPlan(db, board(i.storyboardId)));
  register<{ planId: string; storyboardId: string; takesPerScene?: number }>('render.run', object({ planId: text, storyboardId: text, takesPerScene: integer }, ['planId','storyboardId']), planSchema, async i => {
    const plan = approvedStoryboardPlan(db, board(i.storyboardId));
    if (plan.id !== i.planId) throw new ServiceError('PRECONDITION_FAILED', 'Storyboard does not approve this plan');
    if (activeRenders.has(i.planId)) throw new ServiceError('PRECONDITION_FAILED', 'Render is already running');
    const controller = new AbortController(); activeRenders.set(i.planId, controller);
    try { await runRenderPlan({ db, planId: i.planId, signal: controller.signal, driver: progressDriver, reviewer: deps.reviewer ?? createLlmTakeReviewer(deps.llm),
      takesPerScene: i.takesPerScene, clock: deps.clock, exitFrame: deps.exitFrame,
      duration: deps.duration ?? (async file => (await probe(file)).durationSec) });
    } finally { activeRenders.delete(i.planId); }
    return need(getRenderPlan(db, i.planId));
  });
  register<{ planId: string }>('render.status', planInput, planSchema, i => need(getRenderPlan(db, i.planId)));
  register<{ planId: string }>('render.cancel', planInput, planSchema, i => {
    need(getRenderPlan(db, i.planId)); activeRenders.get(i.planId)?.abort(); return need(getRenderPlan(db, i.planId));
  });
  register<{ planId: string; sceneId: string }>('render.redo', object({ planId: text, sceneId: text }), output({ id: text, sceneIds: array(text), estimatedCredits: num, state: text }), i => requestSceneRework(db, i.planId, i.sceneId, {}));
  register<{ requestId: string; accept: boolean }>('render.decideRedo', object({ requestId: text, accept: { type: 'boolean' } }), output({ id: text, state: text }), i => decideRework(db, i.requestId, i.accept));
  register<{ planId: string }>('take.list', planInput, array(takeSchema), i => need(getRenderPlan(db, i.planId)).steps.flatMap(s => listByScene(db, s.sceneId)));
  register<{ stepId: string; takeId: string; inPoint: number; outPoint: number }>('take.select', object({ stepId: text, takeId: text, inPoint: num, outPoint: num }), output({ takeId: text, inPoint: num, outPoint: num }), async i => {
    need(db.prepare('SELECT id FROM render_plan_steps WHERE id=?').get(i.stepId));
    try { resolveSelection({ ...getReviewScene(db, i.stepId), override: i }); }
    catch { throw new ServiceError('VALIDATION_ERROR', 'Invalid take selection or interval'); }
    await setOwnerOverrideAndRefresh(db, i.stepId, { takeId: i.takeId, inPoint: i.inPoint, outPoint: i.outPoint });
    return { takeId: i.takeId, inPoint: i.inPoint, outPoint: i.outPoint };
  });
  register<{ projectId: string }>('edit.assemble', projectInput, identified, i => { project(i.projectId); return buildTimelineFromSelectedTakes(db, i.projectId); });
  register<{ timelineId: string; aspect: '16:9' | '9:16' }>('edit.capcut', object({ timelineId: text, aspect: { type: 'string', enum: ['16:9','9:16'] } }), output({ path: text }), async i => {
    const timeline = need(getTimeline(db, i.timelineId)), p = project(timeline.projectId);
    const path = await writeCapcutDraft(buildCapcutDraft(timeline, { projectDir: p.directory, aspect: i.aspect }), resolveInside(p.directory, 'exports/cc'), { projectDir: p.directory });
    return { path };
  });
  register<{ timelineId: string; aspect: '16:9' | '9:16'; mixedAudioPath: string }>('edit.export', object({ timelineId: text, aspect: { type: 'string', enum: ['16:9','9:16'] }, mixedAudioPath: text }), output({ path: text }), i => {
    const timeline = need(getTimeline(db, i.timelineId)), p = project(timeline.projectId);
    return (deps.media?.exportFinal ?? exportFinal)(timeline, { projectDir: p.directory, aspect: i.aspect, mixedAudioPath: assertInsideDataDir(i.mixedAudioPath, p.directory) });
  });
  register<{ projectId: string; output: string; durationSec: number }>('audio.mix', object({ projectId: text, output: text, durationSec: { type: 'number', minimum: 0.001 } }), output({ path: text }), i => {
    const p = project(i.projectId);
    return (deps.media?.mix ?? mix)(db, p.id, { dialogue: [], durationSec: i.durationSec }, assertInsideDataDir(i.output, resolveInside(p.directory, 'exports')), { dataDir: dataDirectory(), projectDir: p.directory });
  });
  register<{ timelineId: string; videos: { aspect: string; path: string }[]; coverPath: string; llmModel: string }>('export.package', object({ timelineId: text, videos: { ...array(object({ aspect: { type: 'string', enum: ['16:9','9:16'] }, path: text })), minItems: 1 }, coverPath: text, llmModel: text }), output({ directory: text, manifest: output({ projectId: text, state: text, files: array(output({ path: text })) }) }), i => {
    const timeline = need(getTimeline(db, i.timelineId)), p = project(timeline.projectId);
    i.videos.forEach(v => assertInsideDataDir(v.path, resolveInside(p.directory, 'exports')));
    return buildPublishPackage({ ...i, project: p, timeline, llm: deps.llm, licenses: collectMusicLicenses(db, p, timeline), coverPath: assertInsideDataDir(i.coverPath, p.directory) });
  });
  register<{ label: string }>('account.create', object({ label: text }), accountSchema, i => safeAccount(createAccount(db, i)));
  register('account.list', object({}), array(accountSchema), () => listAccounts(db).map(safeAccount));
  register<{ accountId: string; status: 'ready' | 'out_of_credit' | 'needs_owner' | 'disabled' }>('account.status', object({ accountId: text, status: { type: 'string', enum: ['ready','out_of_credit','needs_owner','disabled'] } }), accountSchema, i => { need(getAccount(db, i.accountId)); return safeAccount(setAccountStatus(db, i.accountId, i.status)); });
  register<{ accountId: string; amount: number; reason: string }>('credit.add', object({ accountId: text, amount: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, reason: text }), identified, i => { need(getAccount(db, i.accountId)); return addEntry(db, i); });
  register<{ accountId: string }>('credit.list', object({ accountId: text }), array(identified), i => { need(getAccount(db, i.accountId)); return listEntries(db, i.accountId); });
  register('queue.list', object({}), array(identified), () => listJobs(db).map(j => ({ id: j.id, status: j.status, projectId: j.project_id, attempts: j.attempts })));
  const service = {
    listCommands: () => structuredClone([...registry.values()].map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }))),
    async execute(name: string, input: unknown): Promise<ServiceResult> {
      const fail = (code: ErrorCode, message: string, details: ValidationError[] = []): ServiceResult => ({ ok: false, error: { code, message, details } });
      const command = registry.get(name);
      if (!command) return fail('UNKNOWN_COMMAND', 'Unknown command');
      try {
        const validation = validateSchema(input, command.inputSchema);
        if (!validation.valid) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid command input', details: validation.errors.map(e => ({ path: e.path.replace(/cookie|token|authorization|password|secret|apikey/gi, '[REDACTED]'), message: e.message })) } };
        const fields = input as Record<string, unknown>;
        for (const [key, value] of Object.entries(fields)) if (typeof value === 'string' && !value.trim())
          return fail('VALIDATION_ERROR', 'Nonempty text required', [{ path: `$.${key}`, message: 'Nonempty text required' }]);
        if (name === 'project.create') {
          try { projectName(fields.name as string); } catch { return fail('VALIDATION_ERROR', 'Invalid project name', [{ path: '$.name', message: 'Invalid project name' }]); }
        }
        if (name === 'reference.add') {
          try {
            referenceInput({ ...fields, role: fields.kind, priority: String(fields.priority) });
            const root = project(fields.projectId as string).directory;
            referenceImages(fields.images, root).forEach(image => assertInsideDataDir(image, root));
          } catch (error) {
            if (error instanceof ServiceError) throw error;
            return fail('VALIDATION_ERROR', 'Invalid reference', [{ path: '$.name', message: 'Invalid reference name or image path' }]);
          }
        }
        collectSecrets(input).forEach(s => secrets.add(s));
        const raw = await command.handler(structuredClone(input));
        collectSecrets(raw).forEach(s => secrets.add(s));
        const data = sanitize(raw, [...secrets]);
        if (!validateSchema(data, command.outputSchema).valid) return fail('INTERNAL_ERROR', 'Invalid command output');
        return { ok: true, data };
      } catch (error) {
        if (error instanceof CsvImportError) return fail('VALIDATION_ERROR', error.message, error.issues.map(i => ({ path: `$.csv.line${i.line}`, message: i.message })));
        if (error instanceof ProposalConflictError) return fail('PRECONDITION_FAILED', error.message);
        if (error instanceof ServiceError) return fail(error.code, error.message, error.code === 'VALIDATION_ERROR' ? [{ path: '$', message: error.message }] : []);
        if (error instanceof InputValidationError || error instanceof UnsafePathError)
          return fail('VALIDATION_ERROR', 'Invalid field or unsafe path', [{ path: '$', message: 'Invalid field or unsafe path' }]);
        if (error instanceof DuplicateError || error instanceof NoSelectedTakeError || error instanceof InvalidTimelineSelectionError)
          return fail('PRECONDITION_FAILED', 'Existing data does not permit this operation');
        if (error instanceof ScriptGateError || error instanceof StoryboardGateError) return fail('PRECONDITION_FAILED', 'Owner approval required or workflow state changed');
        // Never expose arbitrary dependency errors, stack traces or credentials.
        return fail('INTERNAL_ERROR', 'Command could not be completed');
      }
    },
  };
  return {
    get mcpSettingsStore() { return mcpSettingsStore; },
    useMcpSettingsStore(store: typeof mcpSettingsStore) { mcpSettingsStore = store; },
    onRenderProgress: progress.onRenderProgress,
    listCommands: service.listCommands,
    async execute(name: string, input: unknown): Promise<ServiceResult> {
      return sanitize(await service.execute(name, input), [...secrets]) as ServiceResult;
    },
  };
}

