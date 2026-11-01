# Scope and execution policy

Conductor is an agent orchestration tool. Its default full-access mode deliberately gives owned workers and reviewer tasks the native full-access sandbox and never-ask approval policy, as selected by the operator. The task's readOnly flag expresses work intent; it is not an execution sandbox in this mode. Disable full access to restore per-child read-tool filters.

Controls are scoped to the exact owning parent. Saved plans and declared file scopes are untrusted model output validated before dispatch, and reports are validated before use. Nested delegation tools are denied for owned workers to maintain Conductor's single-child lane. This does not constrain arbitrary external processes or unrelated plugins.

Only committed structured output can count as completion after max-token continuation. Partial tool calls, missing capture, cancellation and provider errors do not establish success. Completed evidence cannot be silently reused for changed task inputs.

Do not include credentials or private session logs when reporting issues. Supply a minimal reproduction, package/DSH versions and redacted errors. No hosted service or credential collection is part of this extension.
