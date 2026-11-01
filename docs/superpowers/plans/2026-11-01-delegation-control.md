# Central delegation and provider-specific concurrency

**Goal:** Only Conductor admits workers. Muse has one root execution slot, no workflows/observers/session delegation, and exactly one BharatCode child may run while independent native and Muse tasks share three total slots.

**Implementation:** Per-run documented Muse configuration sets `agents.execution_capacity=1`, disables workflow triggering, local session messaging and reminder capabilities. Native direct delegation tools are guarded even on short requests. Provider-first admission prevents BharatCode waiters taking shared slots, while the per-run scheduler skips additional BharatCode tasks. Current official model guidance and attributed practitioner reports supply task-fit advice in the catalog and coordinator prompt.

- [x] Research supported Muse runtime controls and model task assignments.
- [x] Watch failing tests for missing runtime controls and native direct delegation.
- [x] Add provider-first shared admission and same-plan BharatCode fairness regressions.
- [x] Verify trusted Muse actually attempts a spawn and runtime rejects it with `root_capacity_exhausted`, without creating or queuing a child.
- [x] Run full checks/live acceptance, review, package, install when idle, and verify installed settings.
- [x] Publish source, release package, routing guide, and verification evidence.

**Boundaries:** Slot limits govern Conductor admission and the official Muse agent tree. General shell execution is not a universal sandbox against a malicious agent manually implementing a new external model client; retain official CLI sandboxing and credential restrictions. Task-fit recommendations are advisory, not a benchmark ranking.
