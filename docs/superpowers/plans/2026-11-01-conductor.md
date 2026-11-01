# DSH Conductor Implementation Plan

> **For agentic workers:** Use the supplied design and implement isolated tasks with tests first.

**Goal:** Nonblocking Sol coordination with full-budget DeepSeek workers.
**Architecture:** Fork the existing DAG runner; a background registry owns runs and notices, with native TODO durability.
**Tech Stack:** TypeScript, DSH 0.2.1-rc.2, Vitest and the production agent-loop testkit.
**Spec:** docs/superpowers/specs/2026-11-01-conductor-design.md

## Constraints

No running-profile edits, reloads, restarts or live model requests. Preserve MIT attribution. Worker context 1,000,000; output resolved from selected provider metadata. Publish the tested source/package to the user's DSH-Extensions-list organization.

## Review focus

- Tool return must not cancel children; deterministic barrier test covers this.
- Saturated worker slots must not block Sol's provider; scoped scheduling test covers this.
- Pending children must dispose on explicit cancellation/unload; controlled activation test covers this.
- Sticky max-tokens must not reject a subsequently valid structured completion; real-loop continuation test covers this.
- Resume/cross-parent controls must neither duplicate writes nor access another parent's run; checkpoint/ownership tests cover these.

## Tasks

1. Fork identity and budget policy. Rename package/client/group IDs, retain upstream attribution. Add failing budget tests for one-million context and declared provider output/full tool defaults; implement and run focused checks.
2. Background lifecycle. Add checkpoint callback seam to runner; create background run registry with accepted receipt, status, message, cancellation, single-owner controls and one terminal notice. Test barriers/cancellation/ownership before implementing.
3. Runtime integration. Replace awaited dispatch with registry, keep parent planning state committed at first checkpoint, register status/message/cancel tools, exempt conversational turns while an active run exists, isolate worker request scheduler from Sol. Verify production-loop responsiveness and final notices.
4. Continuation compatibility. Inspect max-tokens extension, reproduce sticky-finish behavior, accept only validated final structured evidence after continuation, verify partial/truncated output is never treated as success.
5. Documentation and packaging. Describe exact behavior, provider limitations, no live installation, migration from task-orchestrator, checks and known boundaries. Run complete suite, typecheck, build, package smoke and independent whole-change review. Commit/push the dedicated repo and add the organization index entry.
