import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Conductor from '../src/index.ts'
import type { Checkpoint } from '../src/runner.ts'
import { ResourceManager } from '../src/resource-manager.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
function tool(name: string, args: object, id: string): StreamChunk[] {
  const callId = ToolCallId(id), json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function text(value: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
}

describe('exact model context through native tool validation', () => {
  it('saves and resumes the exact 1,050,000-token GPT plan without the former million-token enum rejection', async () => {
    const ctx = new Context()
    const worker = { id: 'inspect', owner: 'inspector', title: 'Inspect project', role: 'backend', prompt: 'Inspect project evidence', dependsOn: [], readOnly: true, writeScopes: [] }
    const initial = { summary: 'Inspect and review', risk: 'low', requiresConfirmation: false,
      tasks: [worker, { ...worker, id: 'review', owner: 'reviewer', title: 'Review evidence', role: 'reviewer', dependsOn: ['inspect'] }] }
    let calls = 0, childStarts = 0, legacyExecutions = 0
    let saved!: Checkpoint
    const requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async modelInfo() { return { context: { contextWindow: 1_050_000 }, defaultMaxTokens: 128_000 } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        expect(options.model).toBe('lead')
        calls++
        if (calls === 1) yield* tool('conductor_dispatch', { objective: 'Inspect project', plan: initial, planOnly: true }, 'initial-plan')
        else if (calls === 3) yield* tool('conductor_dispatch', { objective: saved.objective, runId: saved.runId, plan: saved.result.plan, planOnly: true }, 'resume-exact-plan')
        else if (calls === 5) yield* tool('legacy_context_probe', { contextBudget: saved.result.plan.tasks[0]!.contextBudget }, 'legacy-enum-control')
        else yield* text('The assigned plan is saved.')
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Todo, { allowParallelInProgress: true })
      // A test-local negative control exercises the same native enum validator as the former schema.
      ctx.tools.register(defineContentToolFixture({ name: 'legacy_context_probe', description: 'Former context enum',
        parameters: { contextBudget: { type: 'integer', enum: [1_000_000], required: true } },
        execute: async () => { legacyExecutions++; return [{ type: 'text', text: 'must not execute' }] } }))
      await ctx.plugin(Conductor, { backgroundMode: false, mode: 'off', subagentLlmProvider: 'openai', subagentModel: 'gpt-6.1-sol',
        reviewerProvider: 'openai', reviewerModel: 'gpt-6.1-sol', minComplexityScore: 100 })
      ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') childStarts++ })
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture', 'openai'], new Adapter())
      const parent = await harness.create(SessionId('exact-gpt-context-parent'), { provider: 'fixture', model: 'lead' })
      const send = async () => {
        parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save this assigned plan only.' }], source: { kind: 'user' } }))
        await parent.whenIdle()
      }
      const latest = (): Checkpoint => {
        const event = [...parent.session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!
        return (event.data as unknown as { orchestration: Checkpoint }).orchestration
      }
      await send()
      expect(calls).toBe(2)
      saved = structuredClone(latest())
      expect(saved.result.status).toBe('plan-only')
      expect(saved.result.plan.tasks).toHaveLength(2)
      for (const task of saved.result.plan.tasks) expect(task).toMatchObject({ contextBudget: 1_050_000, outputReserveTokens: 128_000 })
      await send()
      expect(calls).toBe(4)
      expect(latest().runId).toBe(saved.runId)
      expect(latest().result.status).toBe('plan-only')
      expect(latest().result.plan).toEqual(saved.result.plan)
      const results = parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(results.every(event => !event.data.message.isError)).toBe(true)
      const resumeCall = parent.session.snapshotEvents().find(event => event.type === 'tool/call' && event.data.callId === 'resume-exact-plan')!
      expect(JSON.parse(resumeCall.data.arguments).plan.tasks.every((task: { contextBudget: number }) => task.contextBudget === 1_050_000)).toBe(true)
      // This proves that the saved capacity would actually fail the old native enum schema.
      await send()
      expect(legacyExecutions).toBe(0)
      const probe = parent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)!
      expect(probe.data.message.isError).toBe(true)
      expect(childStarts).toBe(0)
      expect(ctx.agents.list().filter(agent => agent.session.header.origin === 'subagent')).toEqual([])
      expect(requests.every(request => request.provider === 'fixture' && request.model === 'lead')).toBe(true)
    } finally { await ctx.fiber.dispose() }
  }, 3000)

  it('keeps a queued native-provider request admissible after stale synthetic limits shrink', async () => {
    let hard = 1_000, total = 1_000
    const first = deferred(), entered = deferred(), released = deferred()
    const scheduler = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: () => hard, totalContextTokens: () => total,
      concurrencyByContext: [{ maxContextTokens: 1_000_000, maxActiveGenerations: 1 }],
      contextPolicy: options => options.provider === 'bharatcode' ? 'provider' : undefined })
    const context = { agents: { get: () => undefined } } as never
    const consume = async (options: GenerateOptions, run: () => AsyncIterable<StreamChunk>) => {
      for await (const _chunk of scheduler.stream(context, options, run)) { /* consume production admission */ }
    }
    const blocker = consume({ provider: 'fixture', model: 'first', messages: [], maxTokens: 1 }, async function* () {
      entered.resolve(); await first.promise; yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await entered.promise
    const queued = consume({ provider: 'bharatcode', model: 'deepseek-v4.1-flash', messages: [], system: 'x'.repeat(8_000), maxTokens: 32_000 }, async function* () {
      released.resolve(); yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect(scheduler.queuedGenerations).toBe(1)
    hard = 1; total = 1
    first.resolve()
    await blocker
    await released.promise
    await queued
    expect(scheduler.queuedGenerations).toBe(0)
    expect(scheduler.activeGenerations).toBe(0)
    scheduler.close()
  }, 3000)
})
