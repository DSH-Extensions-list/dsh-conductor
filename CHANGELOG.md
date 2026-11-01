# Changelog

## 0.2.0 — 2026-11-01

- Discover native models and official Muse CLI models through `conductor_models`.
- Select and checkpoint an explicit provider/model/reasoning choice per task.
- Execute Muse tasks through the official account-authenticated CLI with structured results, bounded output, timeout, process-group cleanup, and owned cancellation.
- Share managed-child queue admission across model transports and preserve BharatCode serialization.
- Reject changed explicit task routes on resume and report external steering limitations clearly.

## 0.1.2

Replace synthetic context stops with model-aware policy: DeepSeek keeps its native 1M window without task/shared-budget failures; GPT uses verified OpenAI model limits and lower route capacity. Remove the old 1M enum from saved-plan tools so larger GPT windows can resume. Route changes defer to native enforcement instead of inheriting another model’s cap.

## 0.1.1

Show provider/model/reasoning in native Fleet names and task progress. Persist assigned models before dispatch and observed request models after execution begins. Preserve completed model history and compatibility with older checkpoints.

## 0.1.0

Initial Conductor fork: owned background runs, responsive coordinator conversation, globally serialized BharatCode child lifetimes, status/message/cancel tools, durable checkpoints, one-million-token context support, declared output allowance, full-access defaults, native model/reasoning selectors, and structured-output continuation compatibility.

Original Task Orchestrator history is archived under docs/upstream and preserved in git history.
