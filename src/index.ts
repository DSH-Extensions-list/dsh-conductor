/** TODO-first parent planning and bounded isolated worker execution. @module */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContentBlock, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_CONTEXT_TOKENS } from './adaptive.js'
import { BackgroundRuns, type BackgroundSnapshot } from './background-runs.js'
import { ChildLane } from './child-lane.js'
import { resolveWorkerBudget } from './budget-policy.js'
import { ResourceManager, validateContextConcurrency } from './resource-manager.js'
import { readPlan, positiveInteger } from './validation.js'
import { runPlan, OrchestrationRunId, type RunnerPolicy, type Checkpoint } from './runner.js'
import { TOOL_PLAN_SCHEMA } from './schemas.js'
import { formatTaskModel } from './model-label.js'
import type { PlannedTask, TaskModel } from './types.js'
import { ROLE_MODEL_FIELDS, resolveRoleModels, resolveChildModels, installParentModelPolicy, type RoleModelValues } from './model-policy.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'conductor': { kind: 'conductor' } & ContextFormed
  }
}

/** Plugin identifier used by the profile loader. */
export const name = 'conductor'
/** Existing services used without changing the agent loop. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents', 'llm']

/** Automatic orchestration mode. */
export type OrchestrationMode = 'off' | 'suggest' | 'hybrid' | 'auto'

/** Maximum active model streams allowed for requests up to one context size. */
export interface ContextConcurrency {
  maxContextTokens: number
  maxActiveGenerations: number
}

const DEFAULT_CONTEXT_CONCURRENCY: readonly ContextConcurrency[] = [
  { maxContextTokens: MAX_CONTEXT_TOKENS, maxActiveGenerations: 1 },
]

/** Deployment policy for automatic task orchestration. */
export interface ConfigValues extends RoleModelValues {
  /** Return immediately while an owned task run continues. */
  backgroundMode?: boolean
  /** Give workers all capabilities available in their selected preset. */
  fullAccessWorkers?: boolean
  /** Default combined worker context ceiling; exact route capacity remains authoritative. */
  workerContextTokens?: number
  /** Zero resolves the provider-declared per-request output allowance. */
  workerOutputTokens?: number
  /** Advanced compatibility option: accept per-task reductions instead of global full budgets. */
  respectTaskBudgets?: boolean
  /** Disable automation, show a plan first, or execute complex requests automatically. */
  mode?: OrchestrationMode
  /** Minimum deterministic complexity score that starts planning. */
  minComplexityScore?: number
  /** Provider used for worker and reviewer children. */
  subagentProvider?: string
  /** Suggested independent initial task count in the planning instruction. */
  preferredWorkers?: number
  /** Hard worker count ceiling accepted from the parent-created graph. */
  maxWorkers?: number
  /** Logical task ceiling, including review. Retries use a separate start budget. */
  maxTotalAgents?: number
  /** Maximum concurrent worker children. */
  maxConcurrentAgents?: number
  /** Allow worker agents to modify the shared workspace. */
  allowWrites?: boolean
  /** Allow independent worker agents with declared write scopes to run together. */
  allowParallelWrites?: boolean
  /** Always run a final reviewer after worker execution. */
  requireReview?: boolean
  /** Maximum serialized plan or worker handoff size. */
  maxHandoffChars?: number
  /** Maximum characters added to the parent model's current request. */
  maxResultChars?: number
  /** Maximum simultaneous owned worker model streams. */
  maxActiveGenerations?: number
  /** Per-request concurrency ceilings selected by estimated input context. */
  concurrencyByContext?: ContextConcurrency[]
  /** Hard estimated input-token limit for one model request; zero disables this check. */
  hardContextTokens?: number
  /** Queue wait interval after which a request gains one priority level. */
  priorityAgingMs?: number
  /** Total estimated context budget for active requests; zero disables this budget check. */
  totalContextTokens?: number
  /** Maximum characters retained when a worker report is compacted for another task. */
  contextCompactionChars?: number
  /** Compatibility setting; must stay true because only the parent may plan. */
  parentOrchestratorOnly?: boolean
  /** Minimum independent initial tasks in a substantial-work plan. */
  minParallelTasks?: number
  /** Total child starts per run, including explicit retries and review. */
  maxChildStarts?: number
  /** Maximum explicit starts of one logical task. */
  maxAttemptsPerTask?: number
  /** Finite reminders when the parent finishes without the required plan. */
  maxPlanningReminders?: number
  /** Global tools a read-only child may use; absent tools are omitted. */
  readOnlyTools?: string[]
  /** LLM provider names sharing this scheduler. An empty list schedules all providers. */
  scheduledProviders?: string[]
  /** Output reserve for a request whose provider-neutral options omit maxTokens. */
  defaultOutputReserveTokens?: number
  /** Safety reserve for parent and other requests without a task-specific reserve. */
  requestSafetyReserveTokens?: number
}

/** Fields editable through the profile Settings page without unloading active runs. */
export type LiveSetting = 'backgroundMode' | 'fullAccessWorkers' | 'workerContextTokens' | 'workerOutputTokens' | 'mode' | 'maxWorkers' | 'maxConcurrentAgents' | 'requireReview'
  | 'maxActiveGenerations' | 'maxChildStarts' | 'maxAttemptsPerTask' | 'concurrencyByContext'
  | 'hardContextTokens' | 'totalContextTokens'
  | typeof ROLE_MODEL_FIELDS[number]

/** Cordis wraps editable fields in references that expose the latest saved values. */
export type Config = Omit<ConfigValues, LiveSetting> & {
  [K in LiveSetting]: Volatile<NonNullable<ConfigValues[K]>>
}

/** Schemastery configuration for the task orchestrator plugin. */
export const Config: z<ConfigValues, Config> = z.object({
  respectTaskBudgets: z.boolean().default(false),
  backgroundMode: z.boolean().default(true).volatile(),
  fullAccessWorkers: z.boolean().default(true).volatile(),
  workerContextTokens: z.number().step(1).min(1).max(1_000_000).default(1_000_000).volatile(),
  workerOutputTokens: z.number().step(1).min(0).max(1_000_000).default(0).volatile(),
  mode: z.union(['off', 'suggest', 'hybrid', 'auto']).default('auto').volatile(),
  minComplexityScore: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(55),
  subagentProvider: z.string().default('spawn'),
  orchestratorProvider: z.string().default('').volatile(),
  orchestratorModel: z.string().default('').volatile(),
  orchestratorReasoningEffort: z.string().default('').volatile(),
  subagentLlmProvider: z.string().default('').volatile(),
  subagentModel: z.string().default('').volatile(),
  subagentReasoningEffort: z.string().default('').volatile(),
  reviewerProvider: z.string().default('').volatile(),
  reviewerModel: z.string().default('').volatile(),
  reviewerReasoningEffort: z.string().default('').volatile(),
  preferredWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  maxWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6).volatile(),
  maxTotalAgents: z.number().step(1).min(1).max(6).default(6),
  maxConcurrentAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1).volatile(),
  allowWrites: z.boolean().default(false),
  allowParallelWrites: z.boolean().default(false),
  requireReview: z.boolean().default(true).volatile(),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262_144),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262_144),
  maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1).volatile(),
  concurrencyByContext: z.array(z.object({
    maxContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })).default([...DEFAULT_CONTEXT_CONCURRENCY]).volatile(),
  hardContextTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0).volatile(),
  priorityAgingMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
  totalContextTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0).volatile(),
  contextCompactionChars: z.number().step(1).min(128).max(Number.MAX_SAFE_INTEGER).default(65_536),
  parentOrchestratorOnly: z.boolean().default(true),
  minParallelTasks: z.number().step(1).min(1).max(6).default(1),
  maxChildStarts: z.number().step(1).min(1).max(48).default(12).volatile(),
  maxAttemptsPerTask: z.number().step(1).min(1).max(8).default(2).volatile(),
  maxPlanningReminders: z.number().step(1).min(0).max(4).default(2),
  readOnlyTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'list_skills', 'read_skill', 'skill']),
  scheduledProviders: z.array(z.string()).default([]),
  defaultOutputReserveTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2_048),
  requestSafetyReserveTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1_024),
})


const COMPLEXITY_TERMS = [
  /frontend|front[- ]end|ui|ux|интерфейс|фронтенд|клиент/i,
  /backend|back[- ]end|api|database|db|сервер|бэкенд|база данных/i,
  /refactor|migration|архитектур|рефактор|миграц/i,
  /test|tests|e2e|ci|тест|провер/i,
  /document|docs|readme|документац/i,
  /review|audit|ревью|аудит/i,
  /all files|whole project|entire|весь проект|все файлы|полностью/i,
  /step by step|phases|dependencies|pipeline|этап|зависим|пайплайн/i,
]

/** Score a request using cheap deterministic signals before spending a child call. */
export function scoreComplexity(text: string): number {
  const normalized = text.trim()
  if (normalized.length === 0) return 0
  let score = 0
  if (normalized.length >= 180) score += 15
  if (normalized.length >= 500) score += 15
  if (/[\n\r]/.test(normalized)) score += 8
  if (/[,:;]|\d+[.)]/.test(normalized)) score += 7
  if (/(?:^|\s)(?:and|и|then|затем|also|также)(?:\s|$)/i.test(normalized)) score += 5
  for (const term of COMPLEXITY_TERMS) if (term.test(normalized)) score += 10
  return Math.min(score, 100)
}

/** Return the text blocks from a user message in their original order. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}


interface TurnPolicy { turn: number; required: boolean; saved: boolean; reminders: number }

function boundResult(value: JsonValue, maxChars: number): string {
  // Control information comes first; a large plan must not hide blockers or the identity needed to resume.
  const ordered = value !== null && typeof value === 'object' && !Array.isArray(value) ? {
    runId: value.runId, status: value.status, summary: value.summary, agentsStarted: value.agentsStarted,
    taskStates: Array.isArray(value.taskStates) ? value.taskStates.map(state => state !== null && typeof state === 'object' && !Array.isArray(state)
      ? { ...state, reason: typeof state.reason === 'string' ? state.reason.slice(0, 500) : state.reason } : state) : value.taskStates,
    review: value.review, workers: value.workers, plan: value.plan,
  } : value
  const serialized = JSON.stringify(ordered)
  const marker = '\n… [truncated; complete results remain in the saved TODO checkpoint]'
  return serialized.length <= maxChars ? serialized : serialized.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, maxChars)
}

/** Bind task execution to the current DSH services and live context settings. */
export function apply(ctx: Context, config: Config): void {
  const defaults = Config({})
  const get = <K extends keyof ConfigValues>(key: K): NonNullable<ConfigValues[K]> => {
    const value = config[key] ?? defaults[key]
    // Values come from the typed Cordis configuration resolver, which wraps only volatile fields.
    return (typeof value === 'object' && value !== null && 'get' in value ? value.get() : value) as NonNullable<ConfigValues[K]>
  }
  const readModels = () => resolveRoleModels(Object.fromEntries(ROLE_MODEL_FIELDS.map(key => [key, get(key)])))
  readModels()
  installParentModelPolicy(ctx, readModels)
  const resolvePolicy = (parent?: Agent): RunnerPolicy => {
    const maxWorkers = Math.min(get('maxWorkers'), get('maxTotalAgents'))
    const maxConcurrentAgents = get('maxConcurrentAgents')
    const minParallelTasks = get('minParallelTasks')
    const concurrencyByContext = get('concurrencyByContext').map(tier => ({ ...tier }))
    validateContextConcurrency(concurrencyByContext, get('hardContextTokens'))
    for (const [key, value] of Object.entries({ maxWorkers, maxConcurrentAgents, minParallelTasks, preferredWorkers: get('preferredWorkers'), maxChildStarts: get('maxChildStarts'), maxAttemptsPerTask: get('maxAttemptsPerTask') })) positiveInteger(value, key)
    if (maxWorkers > 6 || maxConcurrentAgents > maxWorkers || get('preferredWorkers') < minParallelTasks || get('preferredWorkers') > maxWorkers) throw new TypeError('Worker limits must allow the configured independent tasks and fit within six logical tasks')
    if (maxWorkers < minParallelTasks + (get('requireReview') ? 1 : 0)) throw new TypeError('maxWorkers must leave a slot for the required final reviewer')
    if (get('maxChildStarts') < maxWorkers) throw new TypeError('maxChildStarts must cover all logical tasks')
    if (!get('parentOrchestratorOnly')) throw new TypeError('parentOrchestratorOnly must be true; the parent owns planning')
    if (get('readOnlyTools').includes('run_code')) throw new TypeError('readOnlyTools must name end tools, not the PTC transport')
    const inherited = parent === undefined ? undefined : parentAgentOptionsForDelegation(parent)
    const models = inherited?.provider && inherited.model ? resolveChildModels(readModels(), {
      provider: inherited.provider, model: inherited.model,
      ...(inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort }),
    }) : undefined
    return {
      maxWorkers, minParallelTasks, maxConcurrentAgents, maxChildStarts: get('maxChildStarts'), maxAttemptsPerTask: get('maxAttemptsPerTask'),
      allowWrites: get('allowWrites'), allowParallelWrites: get('allowParallelWrites'), requireReview: get('requireReview'),
      maxHandoffChars: get('maxHandoffChars'), contextCompactionChars: get('contextCompactionChars'),
      concurrencyByContext,
      ...(models === undefined ? {} : { workerModel: models.worker, reviewerModel: models.reviewer }),
    }
  }
  resolvePolicy()
  interface ChildLaunchContext { task: PlannedTask; restriction?: ToolRestriction; onModel?: (model: TaskModel) => void }
  const budgetContext = new AsyncLocalStorage<ChildLaunchContext>()
  const budgets = new Map<SessionId, PlannedTask>()
  const modelObservers = new Map<SessionId, (model: TaskModel) => void>()
  const budgetFailures = new Map<SessionId, string>()
  ctx.on('agent/created', ({ agent }) => {
    const launch = budgetContext.getStore()
    if (launch !== undefined && agent.session.header.origin === 'subagent') {
      budgets.set(agent.session.id, launch.task)
      if (launch.onModel !== undefined) modelObservers.set(agent.session.id, launch.onModel)
      if (launch.restriction !== undefined) agent.ctx.tools.restrict(launch.restriction)
      else {
        agent.session.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' })
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' })
        agent.session.append('permission/preset', { preset: 'danger-full-access' })
      }
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    budgets.delete(agent.session.id)
    modelObservers.delete(agent.session.id)
    const running = runs.active(agent.id)
    if (running !== undefined) runs.cancel(agent.id, running.runId)
  })
  const resources = new ResourceManager({
    maxActiveGenerations: () => get('maxActiveGenerations'),
    hardContextTokens: () => get('hardContextTokens'), totalContextTokens: () => get('totalContextTokens'),
    concurrencyByContext: () => get('concurrencyByContext'), priorityAgingMs: get('priorityAgingMs'),
    defaultOutputReserveTokens: get('defaultOutputReserveTokens'), safetyReserveTokens: get('requestSafetyReserveTokens'),
    requestBudget: options => {
      const task = options.sessionId === undefined ? undefined : budgets.get(options.sessionId)
      return task === undefined ? undefined : { contextTokens: task.contextBudget!, safetyReserveTokens: task.safetyReserveTokens! }
    },
    onRejectedRequest: (options, reason) => {
      if (options.sessionId !== undefined && budgets.has(options.sessionId)) budgetFailures.set(options.sessionId, reason)
    },
  })
  ctx.effect(() => () => resources.close())
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId !== undefined) modelObservers.get(options.sessionId)?.({ provider: options.provider, model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) })
    // Only owned worker streams enter this queue. The lead and reviewer remain independent.
    const task = options.sessionId === undefined ? undefined : budgets.get(options.sessionId)
    return task !== undefined && task.role !== 'reviewer' && (get('scheduledProviders').length === 0 || get('scheduledProviders').includes(options.provider))
      ? resources.stream(ctx, options, next) : next()
  })
  const turns = new WeakMap<Agent, TurnPolicy>()
  const runs = new BackgroundRuns()
  const bharatcodeLane = new ChildLane()
  const unload = new AbortController()
  ctx.effect(() => async () => {
    unload.abort()
    resources.close()
    bharatcodeLane.close()
    await runs.shutdown()
  })
  const planningReminder = (): string => {
    const { minParallelTasks, maxConcurrentAgents } = resolvePolicy()
    return `You coordinate substantive work through conductor_dispatch: save a concrete assigned plan with at least ${minParallelTasks} useful initial task(s), dependencies and a final reviewer${get('requireReview') ? ' (required)' : ''}. It returns an accepted run ID immediately in background mode; remain available to talk to the human. Only one BharatCode child is spawned at a time, remaining tasks queue, and your lead-model requests are not put in that worker queue. Let the configured workers implement, investigate and test, then use the independent review evidence before reporting success. Use conductor_status for saved progress/results, conductor_message to steer an active task, and conductor_cancel to stop a run. Terminal notices arrive automatically; do not poll repeatedly or claim completion while pending. Short questions need no team. A plan's budgets default to the selected model's declared capacity (DeepSeek 1,000,000 combined context) and full configured per-response output; omit small budget overrides. Full-access workers retain their preset tools while honoring task-scope instructions. Use planOnly only when planning or approval is actually required. Existing authorization is sufficient; do not ask again. For an authorized implementation use executeWrites=true. Resume a blocked run using its exact saved objective and plan plus resumeContext, preserving completed evidence.`
  }
  ctx.systemPrompt.section({ name: 'tool:conductor', order: 150, text: () => get('mode') === 'off' ? 'Automatic orchestration is disabled. The parent may use conductor_dispatch when the human explicitly requests a task team. Existing runs may finish.' : planningReminder() })
  ctx.tools.register(defineTool({
    name: 'conductor_dispatch',
    description: 'Save an assigned task graph and dispatch background workers. Returns an accepted run ID without waiting, so the lead can keep talking. Completion or actionable failure is delivered later. Explicit plan required; resume preserves exact saved assignments.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concrete user objective.' },
      plan: { ...TOOL_PLAN_SCHEMA, required: true },
      planOnly: { type: 'boolean', description: 'Save and display TODO without starting children.' },
      executeWrites: { type: 'boolean', description: 'True only when the human has already authorized implementation.' },
      maxWorkers: { type: 'number', description: 'Optional smaller logical task ceiling, including review.' },
      runId: { type: 'string', description: 'Saved run to continue. Keep task assignments; unfinished task packets and budgets may be corrected. Completed task inputs remain unchanged.' },
      resumeContext: { type: 'json', description: 'Object mapping waiting task IDs to newly obtained data or corrected instructions. No automatic retries without this data.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        runId: { type: 'string', required: true }, status: { type: 'string', required: true }, agentsStarted: { type: 'integer', required: true }, result: { type: 'json', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: boundResult(value.result, get('maxResultChars')) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined || parent.session.header.origin === 'subagent') throw new Error('Only the parent orchestrator may execute a task plan')
      if (runs.active(parent.id) !== undefined) throw new Error('This conversation already has an active background run. Use conductor_status, conductor_message or conductor_cancel; ordinary conversation can continue.')
      const objective = args.objective.trim()
      if (objective.length === 0 || objective.length > get('maxHandoffChars')) throw new TypeError('objective must fit maxHandoffChars and be non-empty')
      const plan = readPlan(args.plan, get('maxHandoffChars'), true)
      const policy = resolvePolicy(parent)
      const rawTasks = (args.plan as { tasks: Array<Record<string, unknown>> }).tasks
      for (const task of plan.tasks) {
        const model = task.role === 'reviewer' ? policy.reviewerModel ?? policy.workerModel : policy.workerModel
        if (model === undefined) throw new Error('Choose a worker model before dispatch')
        const info = await ctx.llm.resolveModelInfo(model.provider, model.model, exec.signal)
        const raw = rawTasks.find(item => item.id === task.id)!
        const taskOverrides = get('respectTaskBudgets')
        const budget = resolveWorkerBudget({ contextWindow: info.context?.contextWindow, defaultMaxTokens: info.defaultMaxTokens }, {
          contextBudget: taskOverrides && raw.contextBudget !== undefined ? raw.contextBudget as number
            : Math.min(get('workerContextTokens'), info.context?.contextWindow ?? get('workerContextTokens')),
          ...(taskOverrides && raw.outputReserveTokens !== undefined ? { outputReserveTokens: raw.outputReserveTokens as number }
            : get('workerOutputTokens') > 0 ? { outputReserveTokens: get('workerOutputTokens') } : {}),
          ...(taskOverrides && raw.safetyReserveTokens !== undefined ? { safetyReserveTokens: raw.safetyReserveTokens as number } : {}),
        })
        Object.assign(task, budget)
      }
      const maxWorkers = policy.maxWorkers
      const requestedCap = args.maxWorkers === undefined ? maxWorkers : positiveInteger(args.maxWorkers, 'maxWorkers')
      if (requestedCap > maxWorkers) throw new TypeError('maxWorkers exceeds the deployment ceiling')
      const provider = ctx.subagents.getProvider(get('subagentProvider'))
      if (provider === undefined || provider.inheritsParentContext || !provider.capabilities.outputSchema || !provider.capabilities.agentOptions) throw new Error('Provider must support fresh contexts, structured reports and output-token limits')
      const allowed = get('readOnlyTools').filter(name => ctx.tools.get(name, parent) !== undefined)
      const deniedDelegation = ['conductor_dispatch', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent'].filter(name => ctx.tools.get(name, parent) !== undefined)
      let resumeContext: Record<string, string> | undefined
      if (args.resumeContext !== undefined) {
        if (typeof args.resumeContext !== 'object' || args.resumeContext === null || Array.isArray(args.resumeContext)) throw new TypeError('resumeContext must be an object')
        resumeContext = {}
        for (const [id, text] of Object.entries(args.resumeContext)) {
          if (typeof text !== 'string') throw new TypeError('resumeContext values must be text')
          resumeContext[id] = text
        }
      }
      const launch = (lifecycle: { signal: AbortSignal; onCheckpoint: (checkpoint: Checkpoint) => void }) => runPlan({
        parent, signal: lifecycle.signal,
        onCheckpoint: checkpoint => {
          const state = turns.get(parent)
          if (state !== undefined) state.saved = true
          lifecycle.onCheckpoint(checkpoint)
        },
        childIsLive: id => ctx.agents.get(id) !== undefined,
        failureDetail: id => { const detail = budgetFailures.get(id); budgetFailures.delete(id); return detail },
        start: async (request, task, onModel) => {
          const restriction: ToolRestriction | undefined = get('fullAccessWorkers') ? undefined : task.readOnly
            ? { allow: allowed } : deniedDelegation.length === 0 ? { allow: [...ctx.tools.schemas(parent).map(tool => tool.name)] } : { deny: deniedDelegation }
          // This permit covers child lifetime, not merely individual model streams.
          const release = request.agentOptions?.provider === 'bharatcode' ? await bharatcodeLane.acquire(request.signal) : () => {}
          try {
            return await budgetContext.run({ task, restriction, onModel }, async () => {
              const activation = await ctx.subagents.startActivation({
                provider: get('subagentProvider'), label: request.agentOptions?.provider && request.agentOptions.model
                  ? `${task.owner} · ${formatTaskModel({ provider: request.agentOptions.provider, model: request.agentOptions.model, reasoningEffort: request.agentOptions.reasoningEffort })} · ${task.title}`
                  : request.label ?? `${task.owner}: ${task.title}`,
                request: { parent: request.parent, prompt: request.prompt,
                  ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                  ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
                  ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
                  ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
                  ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }) },
                signal: request.signal, delivery: 'caller',
              })
              let disposal: Promise<void> | undefined
              const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(() => activation.dispose()).finally(() => {
                request.signal.removeEventListener('abort', abort); release()
              })
              const abort = (): void => { void dispose().catch(error => ctx.logger.warn(`Conductor child cleanup: ${String(error)}`)) }
              request.signal.addEventListener('abort', abort, { once: true })
              if (request.signal.aborted) abort()
              return { id: activation.childId, result: activation.result, dispose }
            })
          } catch (error) { release(); throw error }
        },
      }, { ...policy, maxWorkers: requestedCap }, {
        objective, plan, planOnly: args.planOnly ?? false, executeWrites: args.executeWrites ?? false,
        ...(args.runId === undefined ? {} : { runId: OrchestrationRunId(args.runId) }), ...(resumeContext === undefined ? {} : { resumeContext }),
      })
      let snapshot: BackgroundSnapshot
      const background = get('backgroundMode')
      snapshot = await runs.dispatch(parent.id, launch, terminal => {
          if (!background || unload.signal.aborted || ctx.agents.get(parent.id) !== parent) return
          const message = createUserMessage({ content: [{ type: 'text', text:
            `Conductor run ${terminal.runId}: ${terminal.status}. ` +
            (terminal.result?.summary ?? terminal.error ?? 'Inspect conductor_status for saved evidence.') +
            '\n' + boundResult(JSON.parse(JSON.stringify(terminal.result ?? terminal.checkpoint?.result ?? {})) as JsonValue, get('maxResultChars')) +
            '\nUse the actual evidence, handle unfinished tasks, and report the result to the human. Do not claim failed work succeeded.' }],
            source: { kind: name, form: 'notice', summary: `Background run ${terminal.status}` } })
          if (parent.status === 'idle') parent.followup(message)
          else parent.steer(message)
        })
      if (!background) {
        const cancel = (): void => { runs.cancel(parent.id, snapshot.runId) }
        exec.signal.addEventListener('abort', cancel, { once: true })
        if (exec.signal.aborted) cancel()
        try { snapshot = await runs.wait(parent.id, snapshot.runId) }
        finally { exec.signal.removeEventListener('abort', cancel) }
      }
      const result: JsonValue = JSON.parse(JSON.stringify({
        ...(snapshot.status === 'running' ? { taskStates: snapshot.checkpoint?.result.taskStates } : snapshot.result),
        runId: snapshot.runId, status: snapshot.status,
        summary: snapshot.status === 'running' ? 'Background run accepted. You can continue the conversation; a terminal notice will arrive.' : snapshot.result?.summary }))
      return { runId: snapshot.runId, status: snapshot.status, agentsStarted: snapshot.checkpoint?.result.agentsStarted ?? 0, result }

    },
    presentCall: args => ({ card: 'generic', title: 'Conductor dispatch', rawInput: args.objective }),
    presentResult: () => ({ card: 'generic' }),
  }))
  const lookup = (parent: Agent, runId?: string): BackgroundSnapshot => {
    const current = runId === undefined ? runs.active(parent.id) : runs.get(parent.id, runId)
    if (current !== undefined) return current
    const saved = [...parent.session.snapshotEvents()].reverse().flatMap(event => {
      if (event.type !== 'todo/write') return []
      const checkpoint = (event.data as unknown as { orchestration?: Checkpoint }).orchestration
      return checkpoint !== undefined && (runId === undefined || checkpoint.runId === runId) ? [checkpoint] : []
    })[0]
    if (saved === undefined) throw new Error('No saved Conductor run found in this conversation')
    return { ownerId: parent.id, runId: saved.runId,
      status: saved.result.taskStates.some(task => task.state === 'ACTIVE') ? 'blocked' : saved.result.status,
      checkpoint: saved,
      error: saved.result.taskStates.some(task => task.state === 'ACTIVE') ? 'Runtime was interrupted; use the saved checkpoint to resume, without duplicating live children.' : undefined }
  }
  for (const action of ['status', 'cancel', 'message'] as const) ctx.tools.register(defineTool({
    name: `conductor_${action}`,
    description: action === 'status' ? 'Inspect this conversation’s saved task progress, assigned children and complete evidence.' : action === 'cancel' ? 'Cancel this conversation’s active run and dispose its workers.' : 'Send corrected instructions or data to an active assigned worker in this conversation.',
    parameters: { runId: { type: 'string', description: 'Run ID; omitted selects the current/latest run.' },
      taskId: { type: 'string', description: 'Assigned task ID required for messaging.' },
      message: { type: 'string', description: 'New instructions/data required for messaging.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'json', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result).slice(0, get('maxResultChars')) }] },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined || parent.session.header.origin === 'subagent') throw new Error('Only the owning lead can control a run')
      let snapshot = lookup(parent, args.runId)
      if (action === 'cancel') snapshot = runs.cancel(parent.id, snapshot.runId)
      if (action === 'message') {
        const task = snapshot.checkpoint?.result.taskStates.find(task => task.taskId === args.taskId)
        if (task?.state !== 'ACTIVE' || task.childId === undefined || !args.message?.trim()) throw new Error('Choose a live assigned task and supply a non-empty message')
        await ctx.subagents.sendMessage(parent, task.childId, [{ type: 'text', text: args.message }], { signal: exec.signal })
      }
      return { result: JSON.parse(JSON.stringify(snapshot)) as JsonValue }
    }, presentCall: () => ({ card: 'generic', title: `Conductor ${action}` }), presentResult: () => ({ card: 'generic' }),
  }))
  ctx.tools.guard(exec => {
    const parent = exec.agent
    if (parent === undefined) return undefined
    if (parent.session.header.origin === 'subagent') {
      if (budgets.has(parent.id) && ['conductor_dispatch', 'subagent', 'subagent_fork', 'workflow'].includes(exec.name))
        return 'Conductor owns the single-worker queue. Return requested additional work to the lead instead of spawning nested agents.'
      return undefined
    }
    if (runs.active(parent.id) !== undefined && ['subagent', 'subagent_fork', 'workflow'].includes(exec.name)) return 'Use the active Conductor run; direct delegation would bypass its single-worker queue.'
    const state = turns.get(parent)
    if (!state?.required) return undefined
    if (['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent'].includes(exec.name)) return 'Use conductor_dispatch with the assigned TODO plan; direct delegation bypasses the task queue.'
    if (!state.saved && !['conductor_status', 'conductor_message', 'conductor_cancel'].includes(exec.name) && exec.name !== 'conductor_dispatch' && exec.name !== 'run_code' && !get('readOnlyTools').includes(exec.name) && !['ask_user', 'request_user_input', 'todo_write', 'plan'].includes(exec.name)) return 'Save an assigned plan through conductor_dispatch before implementation.'
    return undefined
  })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || agent.session.header.origin === 'subagent') return decision
    if (step === 1) {
      if (runs.active(agent.id) !== undefined) { turns.set(agent, { turn, required: false, saved: true, reminders: 0 }); return decision }
      const mode = get('mode')
      if (mode === 'off') { turns.delete(agent); return decision }
      const reminder = planningReminder()
      // Host notices are evidence deliveries, not new human work requests.
      const objective = messages.filter(message => message.source?.kind === 'user').map(messageText).join('\n').trim()
      const required = scoreComplexity(objective) >= get('minComplexityScore')
        || /(?:реализуй|исправь|доработай|разработай|внедри|implement|fix|refactor|build).*(?:проект|плагин|код|project|plugin|code|feature)/is.test(objective)
      turns.set(agent, { turn, required, saved: false, reminders: 0 })
      if (!required) return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: reminder + (mode === 'suggest' ? ' Start with planOnly=true unless the human already authorized execution.' : '') }], source: { kind: name, form: 'notice', summary: 'Create and assign TODO before work' } })] }
    }
    return decision
  })
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = turns.get(agent)
    if (signal.aborted || state?.turn !== turn || !state.required || state.saved) return
    if (state.reminders >= get('maxPlanningReminders')) throw new Error('Required TODO plan was not saved; orchestration is incomplete')
    state.reminders += 1
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'The assigned TODO plan has not been saved. Call conductor_dispatch now with your explicit plan, or report the concrete blocker that prevents planning. ' + planningReminder() }], source: { kind: name, form: 'notice', summary: 'Required plan is missing' } }))
  })
}

export type { OrchestrationResult, PlannedTask, ReviewReport, TaskPlan, TaskRisk, WorkerReport } from './types.js'
