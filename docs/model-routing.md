# How I assign work in Conductor

I keep Sol as the coordinator. It breaks work into bounded tasks, chooses from the live `conductor_models` catalog, assigns file ownership, and checks the returned evidence. Workers ask the coordinator for more help; they do not launch their own teams.

## Execution policy

The default is **three managed children in total, with at most one BharatCode child**. DeepSeek and Qwen use the same BharatCode permit. A waiting BharatCode task holds no shared slot, so Luna, Muse, or another independent model can work while it waits. The same-plan scheduler also skips additional BharatCode tasks instead of letting them crowd out other models. Reviewers count toward the total and their provider limits.

Muse runs through the official CLI with `agents.execution_capacity=1`. That count includes the root, so native subagent spawn is rejected by the runtime. Workflow triggering, local session messaging, and reminder/observer capabilities are disabled per run. A live test in a trusted workspace forced an actual spawn attempt and received `root_capacity_exhausted`: no agent was created or queued. Unsupported configuration fails the worker; Conductor does not retry with weaker controls.

The coordinator's direct native delegation tools are also guarded. Dispatch, steering, cancellation, and explicit retry go through Conductor. Cancellation retains admission until disposal finishes. Keep the CLI sandbox enabled: slot limits are not a general security boundary against arbitrary hostile shell code implementing a separate external client.

Independent read-only tasks can run together. Conflicting edits need dependencies. Parallel writers still need the existing `allowParallelWrites` setting and disjoint declared scopes or separate workspaces; selecting a different model does not make conflicting edits safe.

## Recommended starting assignments

These are task-fit recommendations, checked against public sources on **1 November 2026**. They are not a measured ranking of this installation or a promise of model quality.

| Model | Starting responsibility | Acceptance checks |
| --- | --- | --- |
| **GPT-6.1 Sol** | Coordinator, decomposition, integration, ordinary final review; general implementation when useful. | Clear task graph, exact ownership, review based on files/tests rather than worker summaries alone. |
| **DeepSeek V4.1 Flash** | Main BharatCode worker for substantial implementation, refactors, input-heavy repository investigation, and algorithmic work. | Relevant tests, interface compatibility, focused diffs. Only one BharatCode child at a time. |
| **Qwen3.8 27B** | Alternative within the same BharatCode slot for bounded patches, tests, documentation, or an independent second opinion. | Same checks as any coding worker; do not infer quality from model size or assume BharatCode uses a particular quantization. |
| **GPT-6 Luna** | Bounded fixes, targeted tests, extraction, routine checks, small independent investigations. | Narrow scope and a concrete pass/fail condition. Use a stronger model when the problem remains ambiguous. |
| **Muse Spark 1.3** | Isolated feature implementation, tool-heavy build/test loops, and frontend/browser work. | Structured report plus verified artifacts/tests; one root only, no internal delegation. |
| **GPT-6.1 Terra** | Visual frontend tasks, screenshot interpretation, browser/workflow QA, documentation and natural writing. | Inspect the rendered or interactive result; do not accept code checks alone as proof of visual quality. |
| **GPT-6 Astra** | Escalation for difficult architecture, unresolved bugs, research synthesis, and hard reasoning when the task warrants it. | Explicit evidence and an independent check. It is an escalation option, not an automatic choice for every review. |

Use the actual provider catalog and its reasoning controls. For other registered models, use their documented capabilities and a bounded evaluation rather than inventing specialties. A failed task keeps its selected route; the coordinator must explicitly revise future assignments or provide resume context. It cannot silently replace an explicit model inside a saved task.

## What the sources establish

The [official Codex guidance](https://developers.openai.com/codex/models) describes Astra for demanding work, Sol for complex work at lower cost, Terra for writing/visual/computer-use tasks, and Luna for focused repeatable work. [DeepSeek's release](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) and [model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) describe input-heavy, long-context agent workloads. [Qwen's model card](https://huggingface.co/Qwen/Qwen3.8-27B) describes coding, research and visual-agent tasks. [Meta's model guide](https://dev.meta.ai/docs/models#muse-spark) positions Spark 1.3 for coding and multi-step tool work.

I also checked firsthand reports. A [Paseo user prefers Sol as the orchestrator](https://news.ycombinator.com/item?id=50312092), while [another report separates Sol's computer-use strengths from weaker frontend design](https://news.ycombinator.com/item?id=50321824). A [Terra user reports strong workflow QA](https://news.ycombinator.com/item?id=50323257). A [DeepSeek user describes implementing a WASM game port and escalating difficult issues](https://news.ycombinator.com/item?id=50326010). A [Qwen local-inference report shows quantization can change coding results](https://news.ycombinator.com/item?id=50322593); that does not establish the quality of BharatCode's serving configuration. A [Muse SVG example](https://news.ycombinator.com/item?id=49541357) is a small visual-code observation, not proof of broad frontend superiority.

These are individual experiences, not community consensus. No independent apples-to-apples comparison covering this exact model catalog was established. The [Aider Architect/Editor split](https://aider.chat/2024/09/26/architect.html) and [Anthropic's multi-agent research lessons](https://www.anthropic.com/engineering/multi-agent-research-system) support a strong coordinator plus bounded independent workers; the latter also warns that tightly dependent work parallelizes poorly and that coordination adds cost. Actual acceptance results should refine this starting policy.

Muse controls are documented under [subagents and observers](https://dev.meta.ai/docs/muse-code/extending#multi-agent), [workflow configuration](https://dev.meta.ai/docs/muse-code/workflows#configure), and [per-run settings](https://dev.meta.ai/docs/muse-code/configuration). The installed runtime accepted the configured observer capability identifiers and passed the live spawn-refusal test. Tests verify the controls travel with every CLI worker, rather than relying on a remembered prompt instruction.
