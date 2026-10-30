# M6.2: Chain leases and review selection

M6 reuses RenderPlanStep dependencies, transitionStep and the M5 enqueueJob,
claimNextJob, completion/status APIs, account list and credit balance. M5 has
no chain lease or targeted claim. A run owns one account per chain and submits
one take at a time. Start with a drained queue and no other concurrent queue
producer/worker for these accounts. Enqueue/claim is atomic and rolls back if
an unrelated queued job is at the head; M6 never executes that unrelated job.
This is a consumer restriction, not a change to M5 public behavior.

No take-count config exists in the supplied config; default is two. The plan's
per-step budget estimate remains a one-generation estimate; M6.2 does not add
budget approval or automatic retries (later milestones).

FlowMedia lacks duration; duration inspection and clean exit-frame extraction
are injected M3 boundaries. Frame extraction always receives resolveSelection's
current result. No paths outside VIDFLOW_HOME are accepted. The existing LlmClient
backs the production reviewer; callers can supply sampled-frame observations
through a custom reviewer. The default reviewer receives take metadata and file
locations; it does not itself decode video or attach vision frames.

Review suggestion and partial owner override are separate durable columns in
an additive M6 table initialized by the module. Takes use existing repositories
with injectable-clock timestamps in metadata. Export reads the resolver afresh.
An override can be recorded before review once its takes exist. Partial overrides
must also form a valid interval after merging with the eventual suggestion.
M6.2 does not reconcile interrupted running steps or invalidate already-rendered
downstream scenes after an owner edit; those belong to subsequent M6 tasks.

Tests use an in-process FlowJobDriver fake (the M5 worker contract), not the HTTP
fake Flow page, to avoid Playwright, network and ffmpeg. A logical event clock
and event-loop barrier provide deterministic overlapping job intervals.
