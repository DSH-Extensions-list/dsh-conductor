# Verification — Conductor 0.1.2

## 0.2.0 model routing and official Muse CLI — 1 November 2026

- `npm run check`, `npm test`, and `npm run build` pass: 165 automated tests, with two opt-in live cases skipped by default.
- `CONDUCTOR_MUSE_LIVE=1 npm test -- tests/muse-cli.spec.ts` passes all 25 adapter cases, including actual account-authenticated read-only and file-edit requests through the official CLI.
- An isolated real DSH web profile ran GPT-6.1 Sol as coordinator, discovered routes with `conductor_models`, assigned GPT-6 Luna and Muse Spark 1.3 explicitly, and obtained an approved GPT-6.1 Sol final review. Luna wrote `LUNA_OK\n`; Muse wrote `MUSE_OK\n`; both file byte sequences were checked. The run completed with saved provider/model/reasoning evidence for all three tasks.
- The first live editing attempt exposed Muse's all-fields-required structured-output requirement. The CLI wire schema now converts optional fields to nullable sentinels and restores omission before original-schema validation. The failed run was explicitly resumed after the fix; Luna's completed evidence was preserved and not rerun.
- Production-runtime barrier tests verify cross-owner serialization across native and CLI children, cancel-before-process-exit queue retention, failure cleanup/refill, external message refusal, immutable explicit routes, and cancellation/resume through final review.
- Subprocess regressions verify timeout, malformed output, invalid schema, nonzero exits, correlated root completion, environment-key isolation, and background-descendant cleanup after success, abort, and timeout.

The enforceable admission queue covers Conductor-managed children. Internal delegation tools inside the official Muse client remain client-owned; handoffs forbid nested delegation. This transport currently requires Linux process-group supervision and cannot deliver live steering messages; cancel/dispose/resume is explicit. Catalog presence does not establish entitlement to every model.


Verified on 1 November 2026 with Node.js24 and DSH 0.2.1-rc.2 development dependencies, in an isolated repository.

- TypeScript no-emit check passed.
- Complete Vitest suite: **114 tests passed across 15 files**.
- Host/declaration build and browser settings bundle passed.
- Independent source review identified a terminal-notice re-planning loop and untracked foreground lifecycle; both were reproduced/fixed and covered before packaging. A cancellation display envelope was also made consistent.

The production-loop tests use the shipped DSH agent loop, native scoped tool registry, in-process spawn, native TODO and deterministic adapter streams. Workers are held on barriers while the parent answers another prompt. Cross-parent tests measure actual child creation/disposal order, not only stream counts: peak Conductor-managed BharatCode children is one even with task/model slots configured to two. Cancellation aborts a pending generation and releases the permit to the next owner.

Full-access tests execute file reads and writes in isolated temporary directories from logically read-only worker/reviewer roles, verify full sandbox/preset and never-ask approval events, and deny nested delegation through Conductor's guard. Model and reasoning selectors are tested for staged atomic changes, catalog failure/retry, unavailable choices, unsupported reasoning and revision conflicts.

Continuation tests adapt the installed max-tokens-continue hook in a test-local attributed fixture. They verify same-child retained context, sticky max-tokens after a later committed structured result, rejected truncated tool calls and complete reviewed task results.

The default million-token budget and complete configured output allowance are verified in actual constructed requests/checkpoints, including model-authored attempts to reduce task budgets. This establishes configuration/transport behavior; no million-token paid request or backend maximum-output probe was sent.

The user's running DSH process, installed extensions and active sessions were not modified, restarted or reloaded during this build. Live activation with real models remains a separate acceptance step when existing work is idle. Scripted adapters do not establish arbitrary-model reasoning quality, universal delegation reliability, or correctness of future generated changes.

Model visibility regressions verify queued assignments, observed request route changes, native child labels, completed-history preservation after selector changes, and legacy checkpoints that lack model evidence.

Context-policy regressions reproduce old 98K/114K task/shared limits and verify DeepSeek stream admission and queued admission despite them. GPT tests enforce exact published windows/output, preserve lower served-route bounds, emit canonical context-overflow recovery errors, and resume a normalized 1.05M GPT plan through native tool validation. Official sources for all nine configured GPT models are bundled.
