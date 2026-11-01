import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Conductor from '../src/index.ts'

/*
 * Test-local adaptation of @local/max-tokens-continue 1.1.0-english.20261023,
 * package/lib/index.js, from the user's existing max-tokens continuation plugin.
 * Its package declares MIT; no copyright author is present in the archive.
 * MIT License: Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * Only typing/config defaults are inlined; stream and turn-stopping behavior is
 * retained verbatim, so no installed plugin or profile is loaded or changed.
 */
const CONTINUATION_PROMPT = 'Your previous response was cut off by the output-token limit. Continue exactly where you stopped. Do not restart, restate, or summarize anything you already produced, and do not comment on this interruption. If you were issuing a tool call when cut off, re-issue the complete tool call now. If your previous response was already complete, reply with one short sentence confirming that.'
function mountContinuation(ctx: Context) {
  const state = new WeakMap<Agent, { finish: string | undefined; chars: number; countTurn: number; count: number }>()
  function stateOf(agent: Agent) {
    let entry = state.get(agent)
    if (entry === undefined) { entry = { finish: undefined, chars: 0, countTurn: 0, count: 0 }; state.set(agent, entry) }
    return entry
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const entry = stateOf(agent)
    if (frame.type === 'start') { entry.finish = undefined; entry.chars = 0; return }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'finish': entry.finish = chunk.reason.kind; return
      case 'text-delta': case 'reasoning-delta': entry.chars += chunk.text.length; return
      case 'tool-call-delta': entry.chars += chunk.argumentsDelta.length; return
      default: return
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted) return
    const entry = state.get(agent)
    if (entry === undefined || entry.finish !== 'max-tokens') return
    if (entry.chars === 0) return
    if (entry.countTurn !== turn) { entry.countTurn = turn; entry.count = 0 }
    if (entry.count >= 9) return
    entry.count += 1; entry.finish = undefined
    agent.steer(createUserMessage({ content: [{ type: 'text', text: CONTINUATION_PROMPT }], source: { kind: 'max-tokens-continue', form: 'notice' } }))
  })
}
function response(text: string, finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: finish } }]
}
function tool(name: string, args: object, id: string): StreamChunk[] {
  const callId = ToolCallId(id), json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
const report = (id: string) => ({ taskId: id, status: 'completed', summary: `${id} checked`, evidence: ['retained context checked'], changedFiles: [], tests: [], blockers: [], nextSteps: [] })

describe('production-loop max-token continuation', () => {
  it('continues the same structured child with retained history and preserves the sticky finish reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-conductor-continuation-'))
    const ctx = new Context(), requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions) {
        requests.push(options)
        yield* requests.length === 1 ? response('partial evidence', 'max-tokens') : tool('structured_output', { complete: true }, 'final-capture')
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); mountContinuation(ctx)
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture'], new Adapter())
      const parent = await harness.create(SessionId('continuation-parent'), { provider: 'fixture', model: 'fixture' }, { cwd: directory })
      const activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'continuation', request: { parent, prompt: [{ type: 'text', text: 'ORIGINAL_TASK_CONTEXT' }], outputSchema: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'], additionalProperties: false } }, signal: new AbortController().signal, delivery: 'caller' })
      const settled = await activation.result
      expect(requests).toHaveLength(2)
      expect(requests[0]?.sessionId).toBe(requests[1]?.sessionId)
      expect(JSON.stringify(requests[1]?.messages)).toContain('ORIGINAL_TASK_CONTEXT')
      expect(JSON.stringify(requests[1]?.messages)).toContain('partial evidence')
      expect(JSON.stringify(requests[1]?.messages)).toContain(CONTINUATION_PROMPT)
      expect(settled.structured).toEqual({ complete: true })
      expect(settled.stopReason).toBe('max-tokens')
      // The predecessor runner's `stopReason !== completed` gate rejected this
      // authoritative final capture; the integration test below checks Conductor.
      expect(settled.stopReason !== 'completed').toBe(true)
      await activation.dispose()
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('does not commit truncated structured arguments when no complete capture follows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-conductor-truncated-'))
    const ctx = new Context()
    let count = 0
    class Adapter extends LlmAdapter {
      override async *stream() {
        count += 1
        if (count === 1) {
          const chunks = tool('structured_output', { complete: true }, 'truncated-capture')
          chunks[chunks.length - 1] = { type: 'finish', reason: { kind: 'max-tokens' } }
          yield* chunks
        } else yield* response('Stopped without a final capture.')
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); mountContinuation(ctx)
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture'], new Adapter())
      const parent = await harness.create(SessionId('truncated-parent'), { provider: 'fixture', model: 'fixture' }, { cwd: directory })
      const activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'truncated', request: { parent, prompt: [{ type: 'text', text: 'Finish with a valid capture.' }], outputSchema: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'] } }, signal: new AbortController().signal, delivery: 'caller' })
      const settled = await activation.result
      expect(count).toBe(2)
      expect(settled.stopReason).toBe('max-tokens')
      expect(settled.structured).toBeUndefined()
      await activation.dispose()
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('finishes a dispatched plan when workers and reviewer submit valid structured results after continuation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-conductor-dispatch-'))
    const ctx = new Context(), calls = new Map<string, number>(), requests: GenerateOptions[] = []
    const tasks = ['one', 'two'].map(id => ({ id, owner: `worker-${id}`, title: id, role: 'researcher', prompt: `Check ${id} ORIGINAL_TASK_CONTEXT`, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 1_000_000, outputReserveTokens: 32_000, safetyReserveTokens: 1_024 }))
    const graph = { summary: 'Continuation regression', risk: 'low', requiresConfirmation: false, tasks: [...tasks, { ...tasks[0], id: 'review', owner: 'reviewer', title: 'Review', role: 'reviewer', dependsOn: ['one', 'two'] }] }
    let parentCalls = 0
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
      override async *stream(options: GenerateOptions) {
        const id = JSON.stringify(options.messages).match(/Task: ([^.]+)\. Assigned worker:/)?.[1]
        if (id === undefined) {
          parentCalls += 1
          yield* parentCalls === 1 ? tool('conductor_dispatch', { objective: 'Check continuation', plan: graph }, 'dispatch') : response('Conductor accepted.')
          return
        }
        requests.push(options)
        const count = (calls.get(id) ?? 0) + 1; calls.set(id, count)
        if (count === 1) { yield* response(`${id} partial evidence`, 'max-tokens'); return }
        expect(JSON.stringify(options.messages)).toContain(CONTINUATION_PROMPT)
        const value = id === 'review' ? { status: 'approved', summary: 'Evidence reviewed', findings: [], checks: ['continued reports'], nextSteps: [] } : report(id)
        yield* tool('structured_output', value, `${id}-capture`)
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
      await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Todo, { allowParallelInProgress: true }); mountContinuation(ctx)
      await ctx.plugin(Conductor, { maxPlanningReminders: 0, subagentLlmProvider: 'fixture', subagentModel: 'fixture', reviewerProvider: 'fixture', reviewerModel: 'fixture', scheduledProviders: ['fixture'] })
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture'], new Adapter())
      const parent = await harness.create(SessionId('dispatch-continuation-parent'), { provider: 'fixture', model: 'fixture' }, { cwd: directory })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the API, backend, frontend, tests and review the results.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      await vi.waitFor(() => {
        const saved = [...parent.session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')
        expect(saved).toBeDefined()
        expect(saved!.data.todos.every(todo => todo.status === 'completed')).toBe(true)
      }, { timeout: 5_000 })
      expect([...calls.entries()].sort()).toEqual([['one', 2], ['review', 2], ['two', 2]])
      expect(requests.every(request => request.maxTokens === 32_000)).toBe(true)
      await parent.whenIdle()
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, 10_000)
})
