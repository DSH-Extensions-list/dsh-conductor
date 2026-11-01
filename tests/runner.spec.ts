import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { runPlan, type RunnerHost, type RunnerPolicy } from '../src/runner.ts'
import { TOOL_PLAN_SCHEMA } from '../src/schemas.ts'
import { readPlan, compactReport } from '../src/validation.ts'
import type { TaskPlan, WorkerReport } from '../src/types.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function report(id: string, fields: Partial<WorkerReport> = {}): WorkerReport {
  return { taskId: id, status: 'completed', summary: `${id} checked`, evidence: [`${id} evidence`], changedFiles: [], tests: [], blockers: [], nextSteps: [], ...fields }
}

function plan(ids = ['one', 'two', 'three', 'four']): TaskPlan {
  const tasks = ids.map(id => ({ id, owner: `worker-${id}`, title: id, role: 'researcher' as const, prompt: `Inspect ${id}`, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 8_192, outputReserveTokens: 2_048, safetyReserveTokens: 1_024 }))
  return readPlan({ summary: 'Independent checks and review', risk: 'low', requiresConfirmation: false,
    tasks: [...tasks, { ...tasks[0], id: 'review', owner: 'final-reviewer', title: 'Review evidence', role: 'reviewer', dependsOn: ids }],
  }, 16_384)
}

const policy: RunnerPolicy = {
  maxWorkers: 6, minParallelTasks: 2, maxConcurrentAgents: 2, maxChildStarts: 12, maxAttemptsPerTask: 2,
  allowWrites: false, allowParallelWrites: false, requireReview: true, maxHandoffChars: 16_384,
  contextCompactionChars: 512, concurrencyByContext: [{ maxContextTokens: 49_152, maxActiveGenerations: 2 }, { maxContextTokens: 150_000, maxActiveGenerations: 1 }],
}

function fixture(seed?: ReturnType<Session['snapshotEvents']>, signal = new AbortController().signal) {
  const session = Session.create('parent' as never, seed)
  session.append('turn/start', { turn: 1 })
  const starts: Array<{ id: string; request: SubagentStartRequest; result: ReturnType<typeof deferred<unknown>> }> = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  let disposed = 0
  const host: RunnerHost = {
    parent: { session } as never, signal, childIsLive: () => false,
    start: async (request, task) => {
      const result = deferred<unknown>()
      starts.push({ id: task.id, request, result })
      for (const waiter of waiters) if (starts.length >= waiter.count) waiter.resolve()
      request.signal.addEventListener('abort', () => result.reject(new Error('cancelled')), { once: true })
      return {
        id: `child-${task.id}-${starts.length}` as never, localAgent: undefined,
        result: result.promise.then(structured => ({ stopReason: 'completed' as const, output: [], structured })),
        dispose: async () => { disposed += 1 },
      }
    },
  }
  const started = async (count: number) => {
    if (starts.length >= count) return
    await new Promise<void>(resolve => waiters.push({ count, resolve }))
  }
  const finish = (id: string, output: unknown = id === 'review' ? { status: 'approved', summary: 'Evidence checked', findings: [], checks: ['reports and files checked'], nextSteps: [] } : report(id)) => {
    [...starts].reverse().find(start => start.id === id)!.result.resolve(output)
  }
  const state = () => {
    const event = [...session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!
    return event.data as { todos: Array<{ content: string; status: string }>; orchestration: { result: { taskStates: Array<{ taskId: string; state: string; reason: string }> } } }
  }
  return { session, host, starts, started, finish, state, get disposed() { return disposed } }
}

describe('saved TODO execution', () => {
  it('advertises exact explicit task routes and catalog discovery in the model-facing schema', () => {
    const model = TOOL_PLAN_SCHEMA.properties.tasks.items.properties.model
    expect(model).toMatchObject({ type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
    } })
    expect(model.description).toContain('conductor_models')
  })

  it('accepts the same route fields in a different JSON key order on resume', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    Object.assign(graph.tasks[0], { model: { provider: 'muse', model: 'spark' } })
    const saved = await runPlan(f.host, policy, { objective: 'Routes', plan: graph, planOnly: true, executeWrites: false })
    const reordered = structuredClone(graph)
    Object.assign(reordered.tasks[0], { model: { model: 'spark', provider: 'muse' } })
    const resumed = await runPlan(f.host, policy, { objective: 'Routes', plan: reordered, planOnly: true, executeWrites: false, runId: saved.runId })
    expect(resumed.taskStates?.[0]).toMatchObject({ model: { provider: 'muse', model: 'spark' }, modelSource: 'assigned' })
  })

  it('dispatches explicit task routes ahead of defaults and preserves observed evidence on replay', async () => {
    const f = fixture(), raw = plan(['one', 'two'])
    Object.assign(raw.tasks[0], { model: { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' } })
    Object.assign(raw.tasks[1], { model: { provider: 'muse', model: 'spark' } })
    Object.assign(raw.tasks[2], { model: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } })
    const graph = readPlan(raw, policy.maxHandoffChars)
    expect(graph.tasks[1]).toHaveProperty('model', { provider: 'muse', model: 'spark' })
    const originalStart = f.host.start
    f.host.start = async (request, task, observed) => {
      const run = await originalStart(request, task)
      observed?.({ provider: request.agentOptions!.provider!, model: request.agentOptions!.model!, ...(task.id === 'two' ? {} : { reasoningEffort: task.id === 'one' ? 'low' : 'high' }) })
      return run
    }
    const pending = runPlan(f.host, { ...policy, workerModel: { provider: 'default', model: 'worker' }, reviewerModel: { provider: 'default', model: 'reviewer' } }, { objective: 'Routes', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    expect(f.starts[0].request.agentOptions).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' })
    expect(f.starts[1].request.agentOptions).toMatchObject({ provider: 'muse', model: 'spark', reasoningEffort: undefined })
    f.finish('one'); f.finish('two'); await f.started(3)
    expect(f.starts[2].request.agentOptions).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
    f.finish('review')
    const done = await pending
    expect(done.taskStates?.find(state => state.taskId === 'two')).toMatchObject({ model: { provider: 'muse', model: 'spark' }, modelSource: 'request' })
    const replay = await runPlan(f.host, policy, { objective: 'Routes', plan: graph, planOnly: false, executeWrites: false, runId: done.runId })
    expect(replay.taskStates).toEqual(done.taskStates)
    expect(f.starts).toHaveLength(3)
  })

  it.each([
    { provider: 'codex', model: 'different' },
    { provider: 'muse', model: 'gpt-6-luna' },
    { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'high' },
    undefined,
  ])('rejects an edited explicit route before resume starts: %j', async model => {
    const f = fixture(), graph = plan(['one', 'two'])
    Object.assign(graph.tasks[0], { model: { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' } })
    const saved = await runPlan(f.host, policy, { objective: 'Routes', plan: graph, planOnly: true, executeWrites: false })
    const changed = structuredClone(graph)
    Object.assign(changed.tasks[0], { model })
    await expect(runPlan(f.host, policy, { objective: 'Routes', plan: changed, planOnly: false, executeWrites: false, runId: saved.runId })).rejects.toThrow(/assignment/)
    expect(f.starts).toHaveLength(0)
  })

  it.each([null, {}, { provider: 'codex' }, { model: 'spark' }, { provider: '', model: 'spark' },
    { provider: ' codex', model: 'spark' }, { provider: 'codex', model: 'spark ' },
    { provider: 'muse', model: 'spark', reasoningEffort: '' }, { provider: 'muse', model: 'spark', reasoningEffort: ' low' },
    { provider: 'muse', model: 'spark', typo: true },
  ])('rejects malformed task model without dispatch: %j', async model => {
    const f = fixture(), raw = plan(['one', 'two'])
    Object.assign(raw.tasks[0], { model })
    f.host.start = async () => { throw new Error('malformed route reached dispatch') }
    expect(() => readPlan(raw, policy.maxHandoffChars)).toThrow(/model/)
    await expect(runPlan(f.host, policy, { objective: 'Routes', plan: raw, planOnly: false, executeWrites: false })).rejects.toThrow(/model/)
    expect(f.starts).toHaveLength(0)
  })

  it('refreshes never-started model assignments when a saved plan is resumed with a different route', async () => {
    const f = fixture(), graph = plan(['one','two'])
    const saved = await runPlan(f.host, { ...policy, workerModel: { provider: 'provider-a', model: 'model-a' } }, { objective: 'Plan', plan: graph, planOnly: true, executeWrites: false })
    const resumed = await runPlan(f.host, { ...policy, workerModel: { provider: 'provider-b', model: 'model-b' } }, { objective: 'Plan', plan: graph, planOnly: true, executeWrites: false, runId: saved.runId })
    expect(resumed.taskStates?.find(task => task.taskId === 'one')).toMatchObject({ model: { provider: 'provider-b', model: 'model-b' }, modelSource: 'assigned', attempts: 0 })
    expect(f.state().todos[0].content).toContain('provider-b/model-b')
    expect(f.starts).toHaveLength(0)
  })

  it('keeps historical model unknown when a legacy completed checkpoint has no model metadata', async () => {
    const f = fixture(), graph = plan(['one','two'])
    const pending = runPlan(f.host, policy, { objective: 'Legacy', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('one'); f.finish('two'); await f.started(3); f.finish('review')
    const done = await pending
    const restored = fixture(f.session.snapshotEvents())
    const replay = await runPlan(restored.host, { ...policy, workerModel: { provider: 'new-provider', model: 'new-model' } }, { objective: 'Legacy', plan: graph, planOnly: false, executeWrites: false, runId: done.runId })
    expect(replay.taskStates?.every(task => task.model === undefined && task.modelSource === undefined)).toBe(true)
    expect(restored.starts).toHaveLength(0)
  })

  it('shows captured worker and reviewer assignments in queued TODO before any child starts', async () => {
    const f = fixture()
    const selected = { ...policy, workerModel: { provider: 'bharatcode', model: 'deepseek-v4.1-flash' }, reviewerModel: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' as never } }
    const saved = await runPlan(f.host, selected, { objective: 'Check', plan: plan(['one','two']), planOnly: true, executeWrites: false })
    expect(saved.taskStates?.find(t => t.taskId === 'one')).toMatchObject({ model: { provider: 'bharatcode', model: 'deepseek-v4.1-flash' }, modelSource: 'assigned' })
    expect(saved.taskStates?.find(t => t.taskId === 'review')).toMatchObject({ model: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, modelSource: 'assigned' })
    expect(f.state().todos[0].content).toContain('bharatcode/deepseek-v4.1-flash')
    expect(f.state().todos.at(-1)?.content).toContain('codex/gpt-6.1-sol · medium')
    expect(f.starts).toHaveLength(0)
  })

  it('records the actual request model and preserves it when a completed run is resumed under different settings', async () => {
    const f = fixture(), graph = plan(['one','two'])
    const original = f.host.start
    f.host.start = async (request, task, onModel) => {
      const run = await original(request, task)
      if (task.id === 'one') onModel?.({ provider: 'bharatcode', model: 'deepseek-v4.1-pro', reasoningEffort: 'high' })
      return run
    }
    const selected = { ...policy, workerModel: { provider: 'bharatcode', model: 'deepseek-v4.1-flash' }, reviewerModel: { provider: 'codex', model: 'gpt-6.1-sol' } }
    const pending = runPlan(f.host, selected, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(1)
    expect(f.state().todos[0].content).toContain('bharatcode/deepseek-v4.1-pro · high')
    f.finish('one'); await f.started(2); f.finish('two'); await f.started(3); f.finish('review')
    const done = await pending
    expect(done.taskStates?.find(t => t.taskId === 'one')).toMatchObject({ model: { provider: 'bharatcode', model: 'deepseek-v4.1-pro', reasoningEffort: 'high' }, modelSource: 'request' })
    const replay = await runPlan(f.host, { ...selected, workerModel: { provider: 'other', model: 'changed' } }, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: done.runId })
    expect(replay.taskStates?.find(t => t.taskId === 'one')).toMatchObject({ model: { provider: 'bharatcode', model: 'deepseek-v4.1-pro' }, modelSource: 'request' })
    expect(f.starts).toHaveLength(3)
  })

  it('skips same-run BharatCode waiters so Luna and Muse fill shared capacity through BharatCode disposal', async () => {
    const controller = new AbortController(), f = fixture(undefined, controller.signal)
    const graph = plan(['bharat-one', 'bharat-two', 'bharat-three', 'luna', 'muse'])
    for (const task of graph.tasks) {
      if (task.id.startsWith('bharat')) Object.assign(task, { model: { provider: 'bharatcode', model: 'worker' } })
      if (task.id === 'luna') Object.assign(task, { model: { provider: 'codex', model: 'gpt-6-luna' } })
      if (task.id === 'muse') Object.assign(task, { model: { provider: 'muse', model: 'spark' } })
    }
    const disposal = deferred<void>(), disposing = deferred<void>(), originalStart = f.host.start
    f.host.start = async (request, task, onModel) => {
      const child = await originalStart(request, task, onModel)
      return { ...child, dispose: async () => {
        if (task.id === 'bharat-one') { disposing.resolve(); await disposal.promise }
        await child.dispose()
      } }
    }
    const pending = runPlan(f.host, { ...policy, maxConcurrentAgents: 3, concurrencyByContext: [{ maxContextTokens: 1_000_000, maxActiveGenerations: 3 }] },
      { objective: 'Mixed routes', plan: graph, planOnly: false, executeWrites: false })
    try {
      await f.started(3)
      expect(f.starts.map(start => start.id)).toEqual(['bharat-one', 'luna', 'muse'])
      for (const taskId of ['bharat-two', 'bharat-three']) expect(f.state().orchestration.result.taskStates.find(task => task.taskId === taskId)).toMatchObject({ state: 'QUEUED', attempts: 0 })
      f.finish('bharat-one'); await disposing.promise
      f.finish('luna'); f.finish('muse')
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(f.starts).toHaveLength(3)
      disposal.resolve(); await f.started(4)
      expect(f.starts.at(-1)?.id).toBe('bharat-two')
      expect(f.disposed).toBe(3)
      f.finish('bharat-two'); await f.started(5)
      expect(f.starts.at(-1)?.id).toBe('bharat-three')
      f.finish('bharat-three'); await f.started(6); f.finish('review')
      expect((await pending).status).toBe('completed')
    } finally { disposal.resolve(); controller.abort(); await pending }
  })

  it('saves assigned TODO before any child and runs four tasks as two active, two queued', async () => {
    const f = fixture()
    const pending = runPlan(f.host, policy, { objective: 'Check project', plan: plan(), planOnly: false, executeWrites: false })
    await f.started(2)
    const firstTodo = f.session.snapshotEvents().find(event => event.type === 'todo/write')!
    expect(firstTodo.data.todos.every(todo => todo.status === 'pending')).toBe(true)
    expect(firstTodo.data.todos[0].content).toContain('worker-one')
    expect(f.starts.map(start => start.id)).toEqual(['one', 'two'])
    expect(f.state().orchestration.result.taskStates.map(task => task.state)).toEqual(['ACTIVE', 'ACTIVE', 'QUEUED', 'QUEUED', 'QUEUED'])
    f.finish('two')
    await f.started(3)
    expect(f.starts.at(-1)?.id).toBe('three')
    expect(f.state().orchestration.result.taskStates.find(task => task.taskId === 'one')?.state).toBe('ACTIVE')
    f.finish('three')
    await f.started(4)
    f.finish('one'); f.finish('four')
    await f.started(5)
    expect(f.starts.at(-1)?.id).toBe('review')
    f.finish('review')
    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.agentsStarted).toBe(5)
    expect(f.disposed).toBe(5)
    expect(f.state().todos.every(todo => todo.status === 'completed')).toBe(true)
    expect(f.starts[0].request.agentOptions?.maxTokens).toBe(2_048)
    expect(f.starts[0].request.prompt[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Task: one.') })
    // The native log reader accepts checkpoint metadata without a custom required event type.
    expect(Session.create('restored' as never, f.session.snapshotEvents()).snapshotEvents().slice(0, f.session.snapshotEvents().length)).toEqual(f.session.snapshotEvents())
    expect(f.state().todos.map(todo => `${todo.status}: ${todo.content}`)).toMatchInlineSnapshot(`
      [
        "completed: [one] one — worker-one (completed)",
        "completed: [two] two — worker-two (completed)",
        "completed: [three] three — worker-three (completed)",
        "completed: [four] four — worker-four (completed)",
        "completed: [review] Review evidence — final-reviewer (Evidence checked)",
      ]
    `)
  })

  it('starts no child for a missing reviewer, cyclic graph, or fewer than two independent tasks', async () => {
    const f = fixture()
    const graph = plan(['one', 'two'])
    graph.tasks = graph.tasks.filter(task => task.role !== 'reviewer')
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })).rejects.toThrow(/reviewer/)
    const chain = plan(['one', 'two']); chain.tasks[1].dependsOn = ['one']
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: chain, planOnly: false, executeWrites: false })).rejects.toThrow(/independent/)
    const cycle = plan(['one', 'two']); cycle.tasks[0].dependsOn = ['two']; cycle.tasks[1].dependsOn = ['one']
    expect(() => readPlan(cycle, 16_384)).toThrow(/cycle/)
    const duplicate = plan(['one', 'two']); duplicate.tasks[1].prompt = duplicate.tasks[0].prompt
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: duplicate, planOnly: false, executeWrites: false })).rejects.toThrow(/duplicate prompts/)
    expect(f.starts).toHaveLength(0)
  })

  it('keeps a plan-only TODO and starts it only on a later explicit run', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const saved = await runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: true, executeWrites: false })
    expect(saved.status).toBe('plan-only'); expect(f.starts).toHaveLength(0)
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: saved.runId })
    await f.started(2); f.finish('one'); f.finish('two'); await f.started(3); f.finish('review')
    expect((await pending).status).toBe('completed')
  })

  it('returns a precise missing-file request and resumes only that task when new data arrives', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('one', report('one', { status: 'needs_more_context', summary: 'File required', needs: [{ kind: 'NEED_FILE', reason: 'Provide config.json' }] }))
    f.finish('two')
    const blocked = await pending
    expect(blocked.status).toBe('blocked'); expect(blocked.agentsStarted).toBe(2)
    expect(blocked.taskStates?.find(state => state.taskId === 'one')?.reason).toContain('NEED_FILE')
    const noData = await runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId })
    expect(noData.agentsStarted).toBe(2)
    expect(f.starts).toHaveLength(2)
    f.host.childIsLive = () => true
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId, resumeContext: { one: 'new data' } })).rejects.toThrow(/still live/)
    f.host.childIsLive = () => false
    const resume = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId, resumeContext: { one: 'config.json contents: enabled=true' } })
    await f.started(3)
    expect(f.starts.at(-1)?.id).toBe('one')
    expect(f.starts.at(-1)?.request.prompt[0]).toMatchObject({ text: expect.stringContaining('enabled=true') })
    f.finish('one'); await f.started(4); f.finish('review')
    const result = await resume
    expect(result.status).toBe('completed'); expect(result.agentsStarted).toBe(4)
    expect(f.starts.filter(start => start.id === 'two')).toHaveLength(1)
  })

  it('keeps successful evidence when a sibling returns invalid JSON', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('one'); f.finish('two', { taskId: 'wrong' })
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.workers.find(worker => worker.taskId === 'one')?.evidence).toEqual(['one evidence'])
    expect(result.workers.find(worker => worker.taskId === 'two')?.blockers[0]).toContain('taskId')
    expect(f.disposed).toBe(2)
  })

  it('requires actual reviewer approval before marking the run complete', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('one'); f.finish('two'); await f.started(3)
    f.finish('review', { status: 'changes_requested', summary: 'Missing test', findings: ['Add test'], checks: [], nextSteps: ['Fix and review'] })
    const result = await pending
    expect(result.status).toBe('blocked'); expect(result.review?.status).toBe('changes_requested')
  })

  it('cancels and disposes active children while preserving the saved TODO', async () => {
    const controller = new AbortController(), f = fixture(undefined, controller.signal)
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: plan(), planOnly: false, executeWrites: false })
    await f.started(2); controller.abort()
    const result = await pending
    expect(result.status).toBe('failed'); expect(f.disposed).toBe(2); expect(f.starts).toHaveLength(2)
    expect(result.taskStates?.every(state => state.state === 'CANCELLED')).toBe(true)
  })

  it('resumes a cancelled worker with context and runs its never-started reviewer without repeating completed evidence', async () => {
    const controller = new AbortController(), f = fixture(undefined, controller.signal), graph = plan(['one', 'two'])
    graph.tasks[0].model = { provider: 'muse', model: 'muse-spark-1.3', reasoningEffort: 'low' }
    graph.tasks[1].model = { provider: 'codex', model: 'gpt-6-luna' }
    const completedSibling = deferred<void>()
    f.host.onCheckpoint = checkpoint => {
      if (checkpoint.result.taskStates.find(state => state.taskId === 'two')?.state === 'DONE') completedSibling.resolve()
    }
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('two'); await completedSibling.promise; controller.abort()
    const cancelled = await pending
    expect(cancelled.taskStates?.find(state => state.taskId === 'one')).toMatchObject({ state: 'CANCELLED', attempts: 1 })
    expect(cancelled.taskStates?.find(state => state.taskId === 'review')).toMatchObject({ state: 'CANCELLED', attempts: 0 })
    const restored = fixture(f.session.snapshotEvents())
    const unchanged = await runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: cancelled.runId })
    expect(restored.starts).toHaveLength(0)
    expect(unchanged.taskStates?.find(state => state.taskId === 'one')).toMatchObject({ state: 'CANCELLED', attempts: 1 })
    expect(unchanged.taskStates?.find(state => state.taskId === 'review')).toMatchObject({ state: 'WAITING', attempts: 0 })
    restored.host.childIsLive = () => true
    await expect(runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: cancelled.runId, resumeContext: { one: 'Finish with the supplied evidence.' } })).rejects.toThrow(/still live/)
    restored.host.childIsLive = () => false
    const resumed = runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: cancelled.runId, resumeContext: { one: 'Finish with the supplied evidence.' } })
    await restored.started(1)
    expect(restored.starts[0].request.agentOptions).toMatchObject({ provider: 'muse', model: 'muse-spark-1.3', reasoningEffort: 'low' })
    restored.finish('one'); await restored.started(2); restored.finish('review')
    const result = await resumed
    expect(result.status).toBe('completed')
    expect(restored.starts.map(start => start.id)).toEqual(['one', 'review'])
    expect(result.taskStates?.find(state => state.taskId === 'two')).toEqual(cancelled.taskStates?.find(state => state.taskId === 'two'))
    expect(result.workers.find(worker => worker.taskId === 'two')).toEqual(cancelled.workers.find(worker => worker.taskId === 'two'))
  })

  it('runs a large-context task alone, then fills both slots immediately', async () => {
    const f = fixture(), graph = plan(['one', 'two', 'three'])
    graph.tasks[0].contextBudget = 65_536
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(1); expect(f.starts).toHaveLength(1)
    f.finish('one'); await f.started(3); expect(f.starts.map(start => start.id)).toEqual(['one', 'two', 'three'])
    f.finish('two'); f.finish('three'); await f.started(4); f.finish('review')
    expect((await pending).status).toBe('completed')
  })

  it('bounds the whole compacted report rather than each list item', () => {
    const long = Array.from({ length: 8 }, () => 'x'.repeat(200))
    expect(compactReport(report('one', { evidence: long, tests: long, blockers: long, changedFiles: long, nextSteps: long }), 512).length).toBeLessThanOrEqual(512)
  })

  it('recovers a saved interrupted task without repeating completed siblings', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('two')
    // Simulate the durable snapshot at a crash: one child is active, the other has already finished.
    await new Promise<void>((resolve, reject) => {
      let checks = 0
      const check = () => {
        if (f.state().orchestration.result.taskStates.find(state => state.taskId === 'two')?.state === 'DONE') resolve()
        else if (++checks > 64) reject(new Error('Completed sibling did not publish its checkpoint'))
        else queueMicrotask(check)
      }
      check()
    })
    const seed = f.session.snapshotEvents()
    const checkpoint = JSON.parse(JSON.stringify(f.state().orchestration))
    f.finish('one'); await f.started(3); f.finish('review'); await pending
    const restored = fixture(seed)
    const stopped = await runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: checkpoint.runId })
    expect(stopped.status).toBe('blocked'); expect(restored.starts).toHaveLength(0)
    expect(stopped.taskStates?.find(state => state.taskId === 'one')?.reason).toContain('interrupted')
    const resume = runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: checkpoint.runId, resumeContext: { one: 'Previous process stopped; finish the remaining check.' } })
    await restored.started(1); expect(restored.starts[0].id).toBe('one')
    restored.finish('one'); await restored.started(2); restored.finish('review')
    expect((await resume).status).toBe('completed')
    expect(restored.starts.some(start => start.id === 'two')).toBe(false)
  })

  it('accepts a corrected budget for unfinished work while retaining completed evidence', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('one', report('one', { status: 'needs_more_context', needs: [{ kind: 'NEED_BUDGET', reason: 'Need 16K', requestedContextTokens: 16_384 }] })); f.finish('two')
    const saved = await pending
    const revised = structuredClone(graph); revised.tasks[0].contextBudget = 16_384
    const resume = runPlan(f.host, policy, { objective: 'Check', plan: revised, planOnly: false, executeWrites: false, runId: saved.runId })
    await f.started(3)
    expect(f.starts.at(-1)?.request.prompt[0]).toMatchObject({ text: expect.stringContaining('Context ceiling including output and safety: 16384') })
    f.finish('one'); await f.started(4); f.finish('review')
    expect((await resume).status).toBe('completed')
    expect(f.starts.filter(start => start.id === 'two')).toHaveLength(1)
    revised.tasks[1].prompt = 'Different completed goal'
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: revised, planOnly: false, executeWrites: false, runId: saved.runId })).rejects.toThrow(/cannot change/)
  })
})
