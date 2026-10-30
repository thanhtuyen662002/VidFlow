# M8.1 prerequisite inspection â€” TSK-0A1BBDC3

Historical revision 0: stopped before implementation. Superseded by M8-1-service-layer.md; the current revision implements M8.1.

The workspace contains PLAN.md, milestones M1â€“M8, and implementations in
src/repo, src/prompt, src/media, src/script, src/flow, src/render and src/edit.
M1 uses src/db.ts and src/repo rather than src/core. Sources use TypeScript,
ES module imports with .ts extensions, and node:test. Node is v24.19.0.
An existing validation implementation is available in
src/script/llm/schema.ts (JsonSchema and validateSchema); no new validation
dependency is needed.

## Missing prerequisites

- M3 explicitly requires a storyboard slideshow from images and durations.
  No storyboard/slideshow implementation or tests were found in src/ or test/.
  src/media/index.ts exports probing, frame extraction, logo cropping and
  video segment concatenation. concatSegments trims existing video streams;
  it does not implement the required still-image storyboard workflow.
- No storyboard approval workflow was found. M8 acceptance requires approval
  before rendering. src/render/plans.ts builds plans from scenes and compiled
  prompts without storyboard state. Treating that plan as a storyboard would
  invent missing behavior rather than wrap an existing module.
- package.json and package-lock.json are absent from this workspace. Therefore
  dependency versions, package module configuration, and test/typecheck/lint
  scripts cannot be verified. This alone is not the reason for stopping.

The manager explicitly requires stopping without code when required M1â€“M7
modules are missing. The missing M3 storyboard implementation prevents the
required end-to-end service flow. Restore that implementation and its public
API before implementing the service. No placeholder or adapter was added.

## Verification and remaining work

Searched src/ and test/ for storyboard, slideshow and gate 2: no matches.
Matches in milestones M3 and M8 confirm the requirement.
Attempted npm test: exit code 1, `Missing script: "test"`.
No tests executed; pass/fail counts are unavailable. Typecheck/lint commands
cannot be determined without the manifest.

No command groups or commands were registered. All M8.1 implementation and
acceptance tests remain pending: registry, schemas, typed errors, injected
dependencies, sanitization, M1â€“M7 command wrappers, fake end-to-end flow,
secret scanning and Electron import guard. Only this inspection report was
added; no M1â€“M7 behavior changed.

Revision note: superseded by M8-1-service-layer.md. M8.1 is now implemented;
this file records the previous revision only and does not describe current status.

