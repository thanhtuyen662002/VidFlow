# M8.1 core service and validated command contract

Task: TSK-0A1BBDC3. This implementation supersedes the historical
TSK-0A1BBDC3-blocked.md report; its missing-storyboard and package blockers
are resolved for this revision. package.json/package-lock.json are present,
were read, and were not modified. No dependencies were added.

## Inspection before implementation

The supplied AGENTS.md, PLAN.md and milestones M2-M8 were read. Source files
use erasable TypeScript, ESM, explicit .ts internal imports and import type.
Existing test/*.test.ts files import node:test and node:assert/strict; helper
 temporaryDatabase sets VIDFLOW_HOME, migrates SQLite and cleans its directory.
package.json declares type=module, Node >=24 and npm test = node --test.
There are no lint/typecheck scripts or installed TypeScript compiler/types in
this workspace; Node 24 can load/execute all new modules directly.

Existing module inventory and public API families:

- M1: db.ts (openDatabase/configureDatabase), paths.ts (data/project/profile
  directories and resolveInside), migrations.ts (migrate), repo/projects.ts
  (create/get/find/list/update/deleteProject), plus repository CRUD for scripts,
  scenes, chains, renders, selections, accounts, assets, music and ledger.
- M2: prompt/bible.ts exports BibleService add/update/list/delete and canonical
  lookup/validation; repo/bibles.ts exports get/create/update/set/list/deleteBible.
  prompt/parse-refs.ts exports parsePrompt; compiler.ts exports compileScene,
  compileScenes, compileSceneUnit and duration errors; scene-chains.ts exports
  computeChains and computeRedoScope. References are shared with the Bible.
- M3: media/index.ts reexports discovery, probe, extract/sample frames, crop logo,
  concatSegments and typed media errors. runner.ts executes ffmpeg safely;
  concat-segments.ts exports segmentVideoFilter, reused by the preview builder.
  No storyboard/slideshow or storyboard owner gate existed.
- M4: variants.ts exports generateVariants, scoreVariants, editVariant,
  evaluateVariant, validateScenes and reexports revise/reviewRisks/overrideWarning/
  approve/acceptRevision/ScriptGateError. split.ts exports split and
  ScriptReferenceError. llm/types.ts supplies LlmClient; llm/schema.ts supplies
  JsonSchema and validateSchema. CLI and MockLlm already exist.
- M5: flow/jobDriver.ts defines FlowJobDriver, WorkerJob, WorkerAccount and the
  result union. driver/pageDriver supply browser adapters; mock/jobDriver supplies
  a fake. accounts.ts exports create/get/list/setAccountStatus/selectUsableAccount;
  credits.ts exports addEntry/getBalance/listEntries/chargeJob; queue.ts exports
  enqueue/get/list/claim/complete/reject/fail/releaseJob. scheduler.ts and
  workerCli.ts provide worker execution. No browser module is imported by service.
- M6: plans.ts exports build/getRenderPlan, estimatePlan/StepCredits and
  transitionStep. orchestrator.ts exports runRenderPlan, createLlmTakeReviewer,
  resolveSelection, getReviewScene, setOwnerOverride and exportSelections.
  frameChain.ts exports buildStartFrame, setOwnerOverrideAndRefresh and
  updateSelectionAndRefresh. rework/recovery/budget expose persisted rework,
  interrupted-job recovery and budget accounting.
- M7: timeline.ts exports buildTimelineFromSelectedTakes/getTimeline and typed
  selection errors; audio.ts exports mix/normalize/measure_loudness/buildMixGraph;
  subtitles.ts supplies SRT; tts.ts supplies provider/registry/mock types;
  capcut.ts exports buildCapcutDraft/writeCapcutDraft; export.ts exports exportFinal;
  package.ts exports collectMusicLicenses/buildPublishPackage/validatePackage/
  markReadyToPublish. Existing license and disclosure checks remain in M7.

## Decisions and contract

src/service/index.ts exports createCoreService, ServiceDependencies, ServiceResult
and ErrorCode. execute(name, input) is asynchronous and returns the documented
ok/data or ok/error envelope. listCommands() returns independent copies of the
unique command names and their input/output JSON schemas. Inputs reject unknown
fields, missing fields, invalid types, nonfinite numbers and configured bounds.
Semantic checks cover names, reference paths and selected take intervals.
Validation errors include field paths; dependency errors never return raw messages.
The fixed error set is VALIDATION_ERROR, UNKNOWN_COMMAND, NOT_FOUND,
PRECONDITION_FAILED and INTERNAL_ERROR.

Reuse the existing handwritten M4 validateSchema implementation, not zod/ajv.
Output schemas validate sanitized results before success. Both successes and
errors pass through recursive sanitization. Sensitive key matching is deliberately
broader than the minimum (substring, case insensitive); serialized JSON is also
sanitized. Discovered sensitive field values and trusted sensitiveValues are
scrubbed when echoed in other fields. Account outputs project only id, label,
status and remainingCredits; queue outputs omit payload/media/error/profile data.
Arbitrary thrown dependency text and stack traces are suppressed.

Factory injection reuses DatabaseSync as storage, LlmClient and FlowJobDriver;
clock, reviewer, duration, exit-frame builder, media mix/export and promptsDir
are injectable. Defaults invoke real M3/M6/M7 implementations. Tests inject media,
LLM and Flow, write system prompts under their temporary home, and need no browser,
ffmpeg, network or real account. No Electron dependency, including transitive ones.

## Storyboard addition and M8 scope

src/script/storyboard.ts fills the missing M3/M4 prerequisite. Generation requires
an approved active script, reuses split (once for that variant) and the M6 planner
(which compiles M2 references/prompts and chain dependencies), then stores a fresh
immutable draft snapshot. The additive service_storyboards table is initialized
idempotently, following the additive render_reviews pattern; no migration number
is changed. Approving records an owner timestamp. Regeneration never inherits
approval and makes older snapshots ineligible. Changed script/Bible/compiled scene
inputs invalidate approval. Rendering checks the approved storyboard/plan pair.
Existing scene IDs are retained on regeneration so original takes remain intact.
The core service does not alter direct M6/CLI APIs used by other tasks.

storyboard.preview returns an ffmpeg argument plan, with looped still images,
validated per-shot durations, a fresh exports path and timeout, reusing M3's
segmentVideoFilter. It does not launch ffmpeg; future adapters may execute the
plan through M3's runner. No preview image generation/UI is implemented here.

M8.1 implements the transport-independent command boundary only. Electron UI,
IPC transport, HTTP MCP authentication and Windows packaging remain later M8
work. Raw worker claim/complete/dispatch functions are deliberately not transport
commands: render.enqueue/run own dispatch and enforce storyboard approval.
Queue inspection is exposed; account/credit changes use existing M5 functions.
The service assembles a timeline, exposes audio mixing, final video and CapCut
exports, and builds the real M7 package/manifest. It never uploads a package.
The caller provides a cover image and exported videos to export.package, avoiding
an implicit ffmpeg operation inside package creation.

## Registered commands

project.create, project.list, project.get;
reference.add, reference.list, bible.update;
script.generate, script.score, script.revise, script.review, script.override,
script.approve;
storyboard.generate, storyboard.get, storyboard.preview, storyboard.approve;
render.enqueue, render.run, render.status;
take.list, take.select;
edit.assemble, edit.capcut, edit.export, audio.mix, export.package;
account.create, account.list, account.status;
credit.add, credit.list, queue.list.

## Verification

npm test -- --test-isolation=none test/service.test.ts: 4 passed, 0 failed.
Every registered command is tested with invalid inputs; every command is invoked
successfully during the fake service-only flow and every result is scanned.
The flow covers risk overrides, persisted approvals, two takes per shot, owner
selection, timeline, injected mix/export, real CapCut JSON and real package files.
Additional assertions cover stale approval, regenerated drafts, traversal rejection,
recursive redaction and static transitive Electron-import scanning.

Broader targeted run of service/script-gate/script-split/render-plans/timeline/
publish-package: 34 tests, 29 passed, 4 failed, 1 skipped. All 4 failures are
existing script-gate tests reading absent prompts/script-writer.system.md outside
the supplied context; the skip is an existing ffmpeg/ffprobe test without tools.
No files outside the allowed context paths were created to repair these fixtures.

## Source and test file inventory (post-addition)

test\capcut.test.ts
test\bible.test.ts
test\audio.test.ts
test\cli-ref.test.ts
test\cli-project.test.ts
test\cli-scene.test.ts
test\compiler-groups.test.ts
src\migrations.ts
src\version.ts
src\validate.ts
src\types.ts
test\validate.test.ts
test\timeline.test.ts
src\service\sanitize.ts
src\service\index.ts
src\cli.ts
src\media\runner.ts
src\script\variants.ts
src\script\storyboard.ts
src\script\split.ts
src\script\prompts.ts
src\db.ts
src\media\errors.ts
src\media\discovery.ts
src\media\crop-logo.ts
src\media\concat-segments.ts
src\logger.ts
src\media\redaction.ts
src\media\probe.ts
src\media\paths.ts
src\media\index.ts
src\media\extract-frame.ts
test\publish-package.test.ts
test\paths.test.ts
test\parse-refs.test.ts
test\migrations.test.ts
test\media.test.ts
test\media-logo.test.ts
test\media-frames.test.ts
test\media-concat.test.ts
test\llm.test.ts
test\helpers.ts
test\support\flow-fake\mp4.ts
test\support\flow-fake\index.ts
test\support\browser.ts
test\service.test.ts
test\script-variants.test.ts
test\script-split.test.ts
test\script-gate.test.ts
test\script-cli.test.ts
test\scene-chains.test.ts
test\rework-budget.test.ts
test\repositories.test.ts
test\repo-production.test.ts
test\repo-ledger.test.ts
test\repo-assets.test.ts
test\repo-accounts.test.ts
test\render-recovery.test.ts
test\render-plans.test.ts
test\render-orchestrator.test.ts
test\render-frame-chain.test.ts
test\redaction.test.ts
src\script\llm\types.ts
src\script\llm\schema.ts
src\script\llm\redact.ts
src\script\llm\mock.ts
src\script\llm\index.ts
src\script\llm\generate.ts
src\script\llm\errors.ts
src\script\llm\cli.ts
src\script\gate.ts
src\script\dialogue.ts
src\script\config.ts
src\script\cli.ts
test\helpers\media.ts
test\flow-worker.test.ts
test\flow-queue.test.ts
test\flow-fake.test.ts
test\flow-driver.test.ts
src\render\rework.ts
src\render\recovery.ts
src\render\plans.ts
src\render\orchestrator.ts
src\render\frameChain.ts
src\render\cli.ts
src\render\budget.ts
src\flow\workerCli.ts
src\flow\selftest.ts
src\reference-migration.ts
src\flow\selectors.ts
src\ref-name.ts
src\flow\scheduler.ts
src\flow\queue.ts
src\flow\queue-migration.ts
src\flow\pageDriver.ts
src\redact.ts
src\edit\tts.ts
test\flow\selftest.test.ts
src\flow\mock\mp4.ts
src\repo\scripts.ts
src\repo\script-reviews.ts
src\repo\script-decisions.ts
src\repo\scenes.ts
src\repo\renders.ts
src\repo\references.ts
src\repo\records.ts
src\repo\projects.ts
src\repo\music.ts
src\repo\ledger.ts
src\repo\chains.ts
src\repo\bibles.ts
src\repo\assets.ts
src\repo\accounts.ts
src\flow\driver.ts
src\flow\credits.ts
src\flow\cli.ts
src\prompt\scene-chains.ts
src\prompt\parse-refs.ts
src\flow\accounts.ts
src\prompt\compiler.ts
src\flow\jobDriver.ts
src\flow\evidence.ts
src\prompt\bible.ts
src\prompt\bible-errors.ts
src\paths.ts
src\edit\cli.ts
src\edit\capcut.ts
src\edit\audio.ts
src\edit\package.ts
src\edit\export.ts
src\edit\subtitles.ts
test\compiler.test.ts
test\final-export.test.ts
src\flow\mock\jobDriver.ts
src\flow\mock\index.ts
src\edit\timeline.ts
test\fixtures\flow-mock\index.html
test\fixtures\compiler\input.json
test\fixtures\compiler\expected.json

Final checks: Node --check passed for src/service/index.ts,
src/service/sanitize.ts, src/script/storyboard.ts and test/service.test.ts.
The final targeted npm test run still passes all 4 service tests. The secret
scan also seeds nested take metadata/serialized fields, and dependency exceptions
containing credentials are suppressed. A malformed injected media result is
rejected by its output schema with INTERNAL_ERROR.
