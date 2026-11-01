# DSH Conductor

Keep talking to your coordinator while workers do the work. Conductor dispatches a saved task graph in the background, queues BharatCode children one at a time, and delivers reviewed results to the owning conversation.

An MIT fork of [DSH Task Orchestrator](https://github.com/hasan-aghayev/dsh-task-orchestrator), with a new background lifecycle, child lane, full-context budgets, controls and settings. See [attribution](THIRD_PARTY_NOTICES.md) and the [source comparison](docs/research/alternatives.md).

## Defaults

The package preset selects **Codex / GPT-6.1 Sol / Medium** for the coordinator and final reviewer, and **BharatCode / DeepSeek v4.1 Flash** for workers. These routes must already exist in your DSH profile. All three roles have model and reasoning selectors in **Settings → Conductor**. Choose other available routes there; unsupported selections fail visibly rather than silently substituting a model.

- Background dispatch returns an accepted run ID immediately. The coordinator can answer another prompt while the run remains pending.
- Exactly one Conductor-managed BharatCode child is admitted at a time across conversations in this plugin instance. The permit lasts through child disposal, not just one API response. Extra tasks queue. The lead and Codex reviewer stay outside the worker queue.
- DeepSeek workers use their **1,000,000-token provider window** with no additional Conductor task/shared-context rejection, plus the selected adapter's complete configured per-response output allowance. The current BharatCode declaration is **32,000 output tokens**, not an independently measured backend maximum. Conductor ignores obsolete model-authored context caps such as 98K/114K for DeepSeek and GPT. GPT uses exact documented OpenAI model ceilings and any smaller route-reported capacity, rather than a blanket 1M clamp. See [verified GPT limits](docs/openai-context-policy.md).
- Full-access workers, including reviewers, receive all tools available in their preset plus `danger-full-access` / `approval: never`. Review-only assignments are instructions, not filesystem confinement. Nested delegation tools are guarded so they cannot bypass the single-child queue. Other plugins and external processes are outside that queue.
- Native Fleet/subagent names include the selected provider, model and reasoning level. Queued task rows mark that selection as assigned; once a model request starts, TODO/status records its actual route. Completed tasks retain their recorded model even after selector changes, and old checkpoints without model evidence stay unknown.
- Final review is required by default. Success requires every task's structured evidence and an approved review. Failures, cancellation and missing context are reported with partial evidence.

Context capacity includes input, output and overhead; a million-token window does not mean a million input tokens plus another full output allowance. Conductor does not pad prompts to fill the window or invent capacity above the selected provider's metadata. No aggregate token-spend cap is added; task/start/retry and context controls remain explicit settings.

## Install when existing work is idle

Conductor targets **DSH >=0.2.1-rc.2 <0.2.2**, Node.js >=22.19. Build a tarball or use a release asset. In a CLI-managed profile:

```sh
dsh plugin --profile web add ./dsh-conductor-0.1.2.tgz
```

For an Electron-managed desktop profile, use its plugin manager instead of modifying the profile package files directly. Installing/replacing plugins can unload code: wait until existing runs are finished. Disable the previous orchestration extension before enabling Conductor so two planning guards do not compete. Conductor's manifest is additive and does not disable any standard or third-party rows itself.

The initial delivery was built and tested in isolation. It was **not installed into or reloaded over the user's active DSH process**.

## Use

Ask for ordinary implementation, investigation or review work. Substantial human requests get plan-first guidance and an implementation guard. Complexity detection is heuristic; short answers use ordinary chat, and an explicit delegation request is always available. Terminal notices are evidence deliveries and cannot themselves trigger another planning loop.

| Tool | Behavior |
| --- | --- |
| `conductor_dispatch` | Save the assigned plan, start/queue children and return a background run ID. `runId` plus corrected context resumes a saved run. |
| `conductor_status` | Show this conversation's current/latest or specified run, task states, child IDs and evidence. |
| `conductor_message` | Deliver new instructions or information to an active assigned task. |
| `conductor_cancel` | Cancel an owned run, dispose active children and release queued admissions. |

You can continue the conversation, ask for status, or redirect an active worker. One run per coordinator is active at a time. A separate project/conversation can have a separate run while sharing the global BharatCode lane. Follow-up work can steer the current run or be dispatched after it settles.

Settings changes are staged and saved atomically with revision checks. Running runs keep their captured model/policy choices; a new run uses saved changes. Controls include background mode, full access, other-model context fallback, worker output, task slots, review, starts/retries and context estimates. DeepSeek/GPT automatic context policies supersede the fallback and synthetic shared caps. Model-window overflow uses DSH’s canonical recovery code so existing compaction can handle it; DeepSeek’s true provider overflow remains provider/native-harness owned. Output `0` means the selected adapter's declared output allowance. Optional `respectTaskBudgets: true` allows explicit per-task reductions for advanced deployments.

## Output-limit continuation

Keep the existing `max-tokens-continue` extension enabled. It continues the **same in-process worker** with its retained conversation when output is truncated. Conductor accepts a sticky `max-tokens` outcome only when a final structured result actually committed and validates; truncated tool arguments, missing capture, aborts and errors remain unsuccessful. The continuation extension retains its own retry/progress settings (the inspected version defaults to nine continuations); Conductor does not pretend those are unlimited.

Retained conversation is subject to the host's existing compaction, image-offload and tool-output policies. The continuation hook cannot reconstruct content that the host has already removed. External CLI/SDK workers would need their own continuation setup; Conductor's tested transport is in-process `spawn`.

## Persistence and boundaries

Native TODO events save complete assignments, attempts, children, reports and review evidence. Status can reconstruct a saved checkpoint after a process interruption. Conductor does not silently restart interrupted write tasks; an explicit resume preserves completed evidence and refuses to duplicate a live child. Per-session controls cannot address another coordinator's runs. Plugin shutdown cancels and awaits owned executions, including foreground compatibility mode.

Workers share the workspace. Writes are serialized by default; declared scopes help scheduling and prompts, while full-access tools remain able to reach other files. Task evidence and model review are useful checks, not proof that arbitrary generated code is correct.

## Development

```sh
corepack pnpm@12.4.1 install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack
```

Tests use the real DSH loop/spawn services with a deterministic adapter, temporary files and barriers. They prove dispatch, conversation responsiveness, queue ownership, cancellation, permissions, selectors and continuation mechanics without paid/live model calls. See [verification](VERIFICATION.md) for the current run and its limits.
