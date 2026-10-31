import type { ServiceDependencies } from './index.ts';
import type { JsonSchema } from '../script/llm/schema.ts';
import { importSourceVideo, segmentSourceVideo, listSegments, setOwnerCutPoints, getSourceVideo } from '../motion/source-import.ts';
import { analyzeSubjects, listSubjects, setMapping } from '../motion/subjects.ts';
import { MotionStyleService } from '../motion/style-service.ts';
import { loadStylePresets } from '../motion/preset-config.ts';
import { enqueueMotionJobs, getMotionState, selectVariant, completeVisualPreview, motionCoordinator } from '../motion/render.ts';
import type { MotionDependencies } from '../motion/render.ts';
import { assembleMotion } from '../motion/assemble.ts';
import { createScheduler } from '../flow/scheduler.ts';

export function registerMotion(deps: ServiceDependencies, register: (name: string, schema: JsonSchema, output: JsonSchema, handler: (input: any) => unknown) => void) {
  const { db } = deps, style = new MotionStyleService(db);
  let rendering = false;
  const text: JsonSchema = { type: 'string', minLength: 1 };
  const source = { sourceVideoId: text };
  function add(name: string, properties: Record<string, JsonSchema>, handler: (i: any) => unknown, required = Object.keys(properties)) {
    register('motion.' + name, { type: 'object', properties, required, additionalProperties: false }, {}, handler);
  }
  const runtime = (): MotionDependencies => {
    if (!deps.motion) throw new Error('Chưa cấu hình trình điều khiển Flow cho chuyển động');
    return { ...deps.motion, db, style };
  };
  const status = (id: string) => ({ source: getSourceVideo(db, id), segments: listSegments(db, id).map(s => ({ ...s, state: getMotionState(db, s.id) })), subjects: listSubjects(db, id), approval: style.getStyleApproval(id) });
  add('import', { projectId: text, filePath: text, rights_confirmed: { type: 'boolean', enum: [true] } }, i => importSourceVideo(db, { ...i, rightsConfirmed: i.rights_confirmed === true }));
  add('segment', { ...source, maxSegmentSec: { type: 'number', minimum: 0.001 } }, i => segmentSourceVideo(db, i.sourceVideoId, i), ['sourceVideoId']);
  add('list_segments', source, i => listSegments(db, i.sourceVideoId));
  add('update_segment', { ...source, cuts: { type: 'array', items: { type: 'number', minimum: 0 } } }, i => setOwnerCutPoints(db, i.sourceVideoId, i.cuts));
  add('analyze', source, i => analyzeSubjects(db, i.sourceVideoId, { llm: deps.llm }));
  add('map_subjects', { subjectId: text, target: text }, i => setMapping(db, i.subjectId, i.target));
  add('presets', {}, () => loadStylePresets().presets);
  add('set_preset', { ...source, presetKey: text }, i => style.createStylePreview(i.sourceVideoId, i.presetKey));
  add('style_preview', { ...source, accountId: text }, async i => {
    await completeVisualPreview({ ...runtime(), ...i });
    return style.getStyleApproval(i.sourceVideoId);
  });
  add('style_approve', { ...source, approver: text }, i => style.approveStyle(i.sourceVideoId, i.approver));
  add('style_reject', source, i => style.rejectStyle(i.sourceVideoId));
  add('render', source, async i => {
    if (rendering) throw new Error('Một lượt render đang chạy');
    rendering = true;
    try {
      const motion = motionCoordinator(runtime());
      enqueueMotionJobs(db, i.sourceVideoId, { style });
      await createScheduler({ queue: db, accounts: db, driver: deps.flowDriver, motion }).runUntilIdle();
      return status(i.sourceVideoId);
    } finally { rendering = false; }
  });
  add('status', source, i => status(i.sourceVideoId));
  add('select_take', { segmentId: text, variantId: text }, i => { selectVariant(db, i.segmentId, i.variantId); return getMotionState(db, i.segmentId); });
  add('export', { ...source, keepOriginalAudio: { type: 'boolean' } }, i => assembleMotion(db, i.sourceVideoId, { llm: deps.llm, keepOriginalAudio: i.keepOriginalAudio }), ['sourceVideoId']);
}
