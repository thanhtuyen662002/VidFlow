# M6.5: durable render slots and restart recovery

Migration 13 adds `render_job_slots`, `render_plan_steps.generation`,
`render_plans.takes_per_scene`, and `flow_fake_requests`. Earlier migrations are
unchanged. A slot identifies one take in one generation of one plan step. Restart
reuses its job and reservation; approved rework starts another generation when
the completed step transitions to ready. No job state is stored in sidecar files.

Startup recovery is an exclusive replacement-worker operation. It checks files
and awaits media probes before opening one short immediate SQLite transaction
to record all interrupted jobs, with rollback on failure. Final downloads
are named by job ID and take index and published with rename from `.partial`.
Valid videos are registered once; missing or incomplete output requeues the
same job without changing its attempt count. Existing credit entries remain
idempotent by job ID. A recovered charged job can regenerate only on its
original account. Recovery runs before both the render orchestrator and Flow
worker CLI dispatch work.

The test-only adapter uses the existing M5 fake HTTP service with a minimal
FlowPage implementation, so Chromium is unnecessary for the resume test. It
records requests in SQLite before fake generation begins. The child-process test
checks the exact retry allowance based on whether the interrupted job received a
request and whether its final file survived. Production uses the existing
Playwright page driver and configured LLM reviewer.

CLI examples and the seven subcommands are documented in `docs/milestones/M6.md`.
M6.5 adds no M7 behavior. Planning remains project-wide, matching the existing
M6.1 planner; chain ordering and dependencies remain those of that planner.

The SQLite lock fix configures every application connection and the shared test
helper with a 5000 ms constructor timeout and busy timeout, WAL journaling and
NORMAL synchronous mode. The hard-kill test closes its seed connection before
spawning, opens and closes a configured connection per progress poll, retries
SQLITE_BUSY until a bounded deadline, and waits for child `close` after killing.
It opens fresh connections for counts after restart and retains the exact take
and fake generation request assertions. Child cleanup finishes before temporary
home cleanup even on failure. This revision was reviewed statically; no tests
were run, as instructed. The validation below describes the earlier revision.

## Validation in the supplied workspace

- Focused command: `node --test --test-isolation=none test/render-recovery.test.ts test/render-plans.test.ts test/render-orchestrator.test.ts test/rework-budget.test.ts test/migrations.test.ts`.
  Actual output: tests 26, pass 25, fail 0, skipped 1. The hard-kill child-process
  test skipped because ffmpeg/ffprobe are unavailable. Direct recovery, clean
  stop/resume, persisted take count, CLI selection, in/out validation, budget
  stop, redo approval and the M5 fake HTTP adapter ran successfully.
- Full command (TEMP/TMP redirected to workspace `test/`):
  `node --test --test-isolation=none --test-reporter=tap test/*.test.ts test/flow/*.test.ts`.
  Actual output: tests 174, pass 136, fail 21, skipped 17. Failures report child
  process `EPERM` and absent context files: `config/flow-selectors.json`,
  `prompts/script-writer.system.md`, `.gitignore`. These files are outside the
  authorized task paths and were not recreated. Ordinary isolated `node --test`
  cannot launch test workers (`spawn EPERM`).
- `npm.cmd test`, `npm.cmd run lint`, and `npm.cmd run typecheck` report missing
  scripts: the supplied workspace has no package manifest. No dependencies or
  manifests were changed. `node --check` passes for the CLI entry point and the
  new render CLI, recovery, and fake adapter modules.

The hard-kill acceptance test remains unverified in this sandbox and is supplied
for execution in the complete Agent Forge checkout with media tools installed.
