# Verification — Conductor 0.1.0

Verified on 1 November 2026 with Node.js24 and DSH 0.2.1-rc.2 development dependencies, in an isolated repository.

- TypeScript no-emit check passed.
- Complete Vitest suite: **102 tests passed across 13 files**.
- Host/declaration build and browser settings bundle passed.
- Independent source review identified a terminal-notice re-planning loop and untracked foreground lifecycle; both were reproduced/fixed and covered before packaging. A cancellation display envelope was also made consistent.

The production-loop tests use the shipped DSH agent loop, native scoped tool registry, in-process spawn, native TODO and deterministic adapter streams. Workers are held on barriers while the parent answers another prompt. Cross-parent tests measure actual child creation/disposal order, not only stream counts: peak Conductor-managed BharatCode children is one even with task/model slots configured to two. Cancellation aborts a pending generation and releases the permit to the next owner.

Full-access tests execute file reads and writes in isolated temporary directories from logically read-only worker/reviewer roles, verify full sandbox/preset and never-ask approval events, and deny nested delegation through Conductor's guard. Model and reasoning selectors are tested for staged atomic changes, catalog failure/retry, unavailable choices, unsupported reasoning and revision conflicts.

Continuation tests adapt the installed max-tokens-continue hook in a test-local attributed fixture. They verify same-child retained context, sticky max-tokens after a later committed structured result, rejected truncated tool calls and complete reviewed task results.

The default million-token budget and complete configured output allowance are verified in actual constructed requests/checkpoints, including model-authored attempts to reduce task budgets. This establishes configuration/transport behavior; no million-token paid request or backend maximum-output probe was sent.

The user's running DSH process, installed extensions and active sessions were not modified, restarted or reloaded during this build. Live activation with real models remains a separate acceptance step when existing work is idle. Scripted adapters do not establish arbitrary-model reasoning quality, universal delegation reliability, or correctness of future generated changes.
