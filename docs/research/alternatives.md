# Background orchestration source review — 1 November 2026

| Project | Source behavior reviewed | Decision |
| --- | --- | --- |
| [Task Orchestrator](https://github.com/hasan-aghayev/dsh-task-orchestrator) 1.2.1 | Assigned graph validation, dependency runner, native TODO checkpoints, model selectors. Its tool awaits the full run. | Fork the tested runner and settings; replace awaited ownership with a background registry. |
| [Swarm Orchestrator](https://github.com/linkbag/dsh-swarm-orchestrator) | Dispatch returns promptly, explicit run controllers and durable state/notices. Its shutdown path does not await all cleanup. | Follow the lifecycle approach, implement awaited cleanup rather than copying its fire-and-forget disposer. |
| [Orch-lite](https://github.com/LYJ132/dsh-orch-lite) | Keeps the main session coordinating; native background child notices. Routing remains instruction driven. | Use as interaction reference; retain a concrete plan/queue guard. |
| [Task Board](https://github.com/PPawnsir/task-board-plugin) | Host dispatch/verification queue and native startActivation adapter. Notifications use followup even while the parent may be busy. | Prefer DSH's busy-steer / idle-followup semantics for terminal notice delivery. |
| [Smart Subagents](https://github.com/HamizDev/dsh-smart-subagents) | Automatic-delegation guidance, rather than mandatory plan interception. | Does not directly address the previous ordinary-request delegation failure. |
| [Subagent Model Router](https://github.com/CypherNaught-0x/DSH-Subagent-Model-Router) | Configured model aliases and result joining. | Useful routing reference; does not provide the required owned task lifecycle by itself. |

The runtime review also checked DSH 0.2.1-rc.2 native subagent settlement, scoped tools, model metadata and sticky max-token turn outcomes. The resulting behavior is covered by keyless production-loop tests; source review and scripted tests do not establish arbitrary real-model reliability.
