# DSH Conductor design

Build the user's dedicated background orchestration extension. Sol 6.1 Medium coordinates and remains available for new conversation while BharatCode DeepSeek v4.1 Flash executes tasks; Sol reviews results. User authorized implementation and saving to DSH-Extensions-list. The running DSH process and installed extensions must not be restarted, reloaded, replaced, or otherwise interrupted. Build and verify in this isolated repository only.

## Approaches

Task Orchestrator has a tested dependency runner, native TODO checkpoints, model roles and settings, but awaits its tool run. Swarm returns immediately and sends background notices, with a broader separate execution engine and lifecycle gaps. Orch-lite demonstrates conversational coordination but depends on instructions for routing. Chosen implementation: MIT fork of Task Orchestrator as dsh-conductor, retaining attribution and tests, adding an owned background lifecycle informed by Swarm and DSH native continuation delivery. This avoids replacing working graph validation with a new scheduler.

## Behavior

conductor dispatch saves the complete assigned plan before returning an accepted run ID. A controller independent of the dispatch tool signal owns child executions. Only an explicit run cancellation, owner disposal, or plugin unload cancels them; unload awaits quiescence. Sol can answer additional prompts while children are pending. The worker scheduler handles BharatCode requests, never Sol's codex route. Exactly one Conductor-managed BharatCode child is admitted globally across conversations until disposal; additional tasks queue. Status reconstructs saved checkpoints; messages target active assigned children, cancellation disposes active children, and explicit resume preserves completed evidence and exact assignments. Concurrent active runs on one parent are refused; a follow-up can steer existing workers or start a later run.

Native TODO checkpoints retain the complete plan and results; a completion or actionable blocked/failure notice goes to the parent once. Notices use parent followup when idle and steer when busy. Progress is inspectable without periodic chat spam. An interrupted process does not silently restart write tasks.

DeepSeek worker contextBudget defaults to 1,000,000 tokens including output/safety, matching configured route metadata. Per-request output defaults to the declared maxTokens for the selected route (currently 32,000 for BharatCode Flash), not an invented unlimited provider capacity. No aggregate token budget is added. Existing max-tokens continuation must continue the same child's history and remain compatible with structured results. Full-access defaults remove tool masks while preserving task-scope instructions. Sol review uses its own provider context/output limits.

## Verification

Use the real DSH production loop and in-process spawn with a deterministic scripted adapter: hold workers on barriers, verify dispatch returns and the parent answers a second unrelated prompt, then release workers and verify independently reviewed completion arrives. Verify cancellation while a child is pending, shutdown draining, no duplicate dispatch/recovery, exact model routes, million-token worker budgets, full output allowance, full tool access, and max-token continuation followed by structured completion. Do not send live requests through the user's running DSH instance. Package verification is distinct from a later installed real-model acceptance run.
