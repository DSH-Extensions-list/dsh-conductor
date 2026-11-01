import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Conductor from '../src/index.ts'
import type { Checkpoint } from '../src/runner.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
function text(value: string): StreamChunk[] { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }] }
function tool(name: string, value: object, id: string): StreamChunk[] { const callId = ToolCallId(id), args = JSON.stringify(value); return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } }, { type: 'finish', reason: { kind: 'tool-calls' } }] }

describe('background production runtime', () => {
  it('answers a second parent prompt while workers are pending, then delivers reviewed completion', async () => {
    const ctx = new Context(), release = deferred(), began = deferred(), finished = deferred()
    let parentCalls = 0, children = 0
    const requests: GenerateOptions[] = []
    const childLabels: string[] = []
    const tasks = ['one', 'two'].map(id => ({ id, owner: `${id}-author`, title: id, role: 'backend', prompt: `Inspect ${id}`, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 24_576, outputReserveTokens: 2_048 }))
    const plan = { summary: 'Independent checks', risk: 'low', requiresConfirmation: false, tasks: [...tasks, { ...tasks[0], id: 'review', owner: 'reviewer', title: 'Review evidence', role: 'reviewer', dependsOn: ['one', 'two'] }] }
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
      override async modelInfo() { return { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (options.model === 'lead') {
          parentCalls++
          if (parentCalls === 1) yield* tool('conductor_dispatch', { objective: 'Review project files, tests and documentation', plan }, 'dispatch')
          else if (parentCalls === 2) yield* text('Workers dispatched; I remain available.')
          else if (parentCalls === 3) yield* text('Four.')
          else { yield* text('Reviewed completion received.'); finished.resolve() }
          return
        }
        const message = options.messages.flatMap(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : [])).join('\n')
        const id = message.match(/^Task: ([^.]+)\./m)?.[1]!
        if (id !== 'review') { children++; if (children === 1) began.resolve(); await release.promise }
        const report = id === 'review' ? { status: 'approved', summary: 'Approved', findings: [], checks: ['files checked'], nextSteps: [] }
          : { taskId: id, status: 'completed', summary: `${id} checked`, evidence: ['read evidence'], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
        yield* tool('structured_output', report, `result-${id}`)
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Todo, { allowParallelInProgress: true })
      await ctx.plugin(Conductor, { maxActiveGenerations: 1, subagentLlmProvider: 'bharatcode', subagentModel: 'worker', reviewerProvider: 'codex', reviewerModel: 'review' })
      ctx.on('agent/disposed', ({ agent }) => {
        if (agent.session.header.origin !== 'subagent') return
        const descriptor = agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')
        if (descriptor?.type === 'subagent/descriptor') childLabels.push(descriptor.data.label ?? '')
      })
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['codex', 'bharatcode'], new Adapter())
      const parent = await harness.create(SessionId('background-parent'), { provider: 'codex', model: 'lead' })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please check the project.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      expect(parentCalls).toBe(2)
      await began.promise
      // A worker remains pending while the lead is already idle.
      expect(requests.some(r => r.model === 'worker')).toBe(true)
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'What is two plus two?' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      expect(parentCalls).toBe(3)
      expect(requests.filter(r => r.model === 'worker').every(r => r.maxTokens === 32_000)).toBe(true)
      release.resolve()
      await finished.promise
      await parent.whenIdle()
      const checkpoint = [...parent.session.snapshotEvents()].reverse().find(e => e.type === 'todo/write')!
      expect(JSON.stringify(checkpoint.data)).toContain('"status":"completed"')
      expect(JSON.stringify(checkpoint.data)).toContain('"contextBudget":1000000')
      expect(requests.some(r => r.provider === 'codex' && r.model === 'review')).toBe(true)
      const saved = (checkpoint.data as unknown as { orchestration: Checkpoint }).orchestration
      expect(saved.result.taskStates.find(task => task.taskId === 'one')).toMatchObject({ model: { provider: 'bharatcode', model: 'worker' }, modelSource: 'request' })
      expect(saved.result.taskStates.find(task => task.taskId === 'review')).toMatchObject({ model: { provider: 'codex', model: 'review' }, modelSource: 'request' })
      expect(childLabels.some(label => label.includes('bharatcode/worker'))).toBe(true)
      expect(childLabels.some(label => label.includes('codex/review'))).toBe(true)
      expect(parentCalls).toBe(4)
      expect(parent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
    } finally { release.resolve(); await ctx.fiber.dispose() }
  }, 2500)
})
