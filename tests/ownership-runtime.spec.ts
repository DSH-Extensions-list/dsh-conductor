import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as Conductor from '../src/index.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function text(value: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function tool(name: string, value: object, id: string): StreamChunk[] {
  const callId = ToolCallId(id), args = JSON.stringify(value)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
async function untilReleased(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
  })
  try { await Promise.race([gate, cancelled]) } finally { signal?.removeEventListener('abort', abort) }
}
function plan(owner: string) {
  const worker = { id: `${owner}-worker`, owner: `${owner}-author`, title: 'Inspect workspace', role: 'backend', prompt: 'Inspect the isolated fixture', dependsOn: [] as string[], readOnly: true, writeScopes: [] }
  return { summary: `Check ${owner}`, risk: 'low', requiresConfirmation: false, tasks: [worker,
    { ...worker, id: `${owner}-review`, owner: `${owner}-reviewer`, title: 'Review evidence', role: 'reviewer', dependsOn: [worker.id] }] }
}
const userMessage = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function fixture(options: { exerciseTools?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'conductor-ownership-'))
  const ctx = new Context()
  const barriers = new Map(['alpha', 'beta'].map(owner => [owner, deferred()]))
  const started = new Map(['alpha', 'beta'].map(owner => [owner, deferred()]))
  const completed = new Map(['alpha', 'beta'].map(owner => [owner, deferred()]))
  const disposed = new Map(['alpha', 'beta'].map(owner => [owner, deferred()]))
  const parentActions = new Map<string, 'dispatch' | 'cancel'>()
  const parentCalls = new Map<string, number>()
  const childCalls = new Map<string, number>()
  const children: Agent[] = []
  const requests: GenerateOptions[] = []
  const sequence: string[] = []
  const writes: string[] = []
  const reads: string[] = []
  const disposalSessions = new Set<string>()
  const owners = new Map<string, string>()
  let liveBharatcode = 0, peakBharatcode = 0
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
    override async modelInfo() { return { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      if (request.model === 'lead') {
        const owner = owners.get(String(request.sessionId))!
        parentCalls.set(owner, (parentCalls.get(owner) ?? 0) + 1)
        const action = parentActions.get(owner)
        if (action !== undefined) {
          parentActions.delete(owner)
          yield* tool(`conductor_${action}`, action === 'dispatch' ? { objective: `Inspect ${owner} workspace`, plan: plan(owner) } : {}, `${owner}-${action}`)
        } else {
          const messages = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
          yield* text('The coordinator is available.')
          if (/Conductor run [^\n]+: (completed|cancelled|failed|blocked)\./.test(messages)) completed.get(owner)!.resolve()
        }
        return
      }
      const messages = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const task = messages.match(/^Task: ([^.]+)\./m)?.[1]
      if (task === undefined) throw new Error(`Unexpected child request ${request.model}`)
      const owner = task.split('-')[0]!
      const count = (childCalls.get(task) ?? 0) + 1
      childCalls.set(task, count)
      if (request.provider === 'bharatcode' && count === 1) {
        sequence.push(`stream:${owner}`)
        started.get(owner)!.resolve()
        await untilReleased(barriers.get(owner)!.promise, request.signal)
      }
      if (options.exerciseTools && count <= 3) {
        if (count === 1) yield* tool('read', {}, `${task}-read`)
        if (count === 2) yield* tool('write', {}, `${task}-write`)
        if (count === 3) yield* tool('conductor_dispatch', { objective: 'Attempt forbidden nested work', plan: plan('nested') }, `${task}-nested`)
        return
      }
      const report = task.endsWith('-review')
        ? { status: 'approved', summary: 'Evidence approved', findings: [], checks: ['isolated fixture checked'], nextSteps: [] }
        : { taskId: task, status: 'completed', summary: 'Workspace checked', evidence: ['isolated fixture'], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
      yield* tool('structured_output', report, `${task}-result`)
    }
  }
  try {
    await writeFile(join(directory, 'source.txt'), 'isolated source')
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: directory })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Todo, { allowParallelInProgress: true })
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read isolated fixture', parameters: {}, execute: async (_args, exec) => {
      const id = String(exec.agent!.id)
      reads.push(id)
      return [{ type: 'text', text: await readFile(join(directory, 'source.txt'), 'utf8') }]
    } }))
    ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Write isolated fixture', parameters: {}, execute: async (_args, exec) => {
      const id = String(exec.agent!.id)
      writes.push(id)
      await writeFile(join(directory, `${id}.txt`), 'tool access verified')
      return [{ type: 'text', text: 'fixture written' }]
    } }))
    await ctx.plugin(Conductor, { fullAccessWorkers: true, maxConcurrentAgents: 2, maxActiveGenerations: 2,
      concurrencyByContext: [{ maxContextTokens: 1_000_000, maxActiveGenerations: 2 }],
      subagentLlmProvider: 'bharatcode', subagentModel: 'worker', reviewerProvider: 'codex', reviewerModel: 'review', minComplexityScore: 100 })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      children.push(agent)
      if (agent.options.provider === 'bharatcode') {
        liveBharatcode++
        peakBharatcode = Math.max(peakBharatcode, liveBharatcode)
        sequence.push(`created:${agent.session.header.parentSession}`)
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      disposalSessions.add(String(agent.id))
      if (agent.options.provider === 'bharatcode') {
        liveBharatcode--
        const owner = owners.get(String(agent.session.header.parentSession))!
        sequence.push(`disposed:${owner}`)
        disposed.get(owner)!.resolve()
      }
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['codex', 'bharatcode'], new Adapter())
    const parents = new Map<string, Agent>()
    for (const owner of ['alpha', 'beta']) {
      const parent = await harness.create(SessionId(`ownership-${owner}`), { provider: 'codex', model: 'lead' })
      await ctx.workingDirectory.set(parent, directory, new AbortController().signal)
      owners.set(String(parent.id), owner)
      parents.set(owner, parent)
    }
    const send = async (owner: string, action?: 'dispatch' | 'cancel') => {
      if (action !== undefined) parentActions.set(owner, action)
      const parent = parents.get(owner)!
      parent.followup(userMessage(action ?? 'Answer an unrelated question while the worker runs.'))
      await parent.whenIdle()
    }
    const checkpoint = (owner: string) => [...parents.get(owner)!.session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!.data
    return { ctx, directory, parents, children, requests, sequence, writes, reads, disposalSessions, send, checkpoint,
      barriers, started, completed, disposed, parentCalls, get peakBharatcode() { return peakBharatcode }, get liveBharatcode() { return liveBharatcode },
      cleanup: async () => {
        for (const barrier of barriers.values()) barrier.resolve()
        try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
      } }
  } catch (error) {
    for (const barrier of barriers.values()) barrier.resolve()
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

describe('owned background runs in the production loop', () => {
  it('keeps two conversations responsive while globally serializing entire BharatCode child lifetimes', async () => {
    const f = await fixture()
    try {
      await f.send('alpha', 'dispatch')
      await f.started.get('alpha')!.promise
      await f.send('beta', 'dispatch')
      expect(f.liveBharatcode).toBe(1)
      expect(f.requests.filter(request => request.provider === 'bharatcode')).toHaveLength(1)
      expect(f.children.filter(child => child.options.provider === 'bharatcode')).toHaveLength(1)
      await f.send('alpha'); await f.send('beta')
      expect(f.parentCalls.get('alpha')).toBe(3)
      expect(f.parentCalls.get('beta')).toBe(3)
      f.barriers.get('alpha')!.resolve()
      await f.started.get('beta')!.promise
      expect(f.sequence.indexOf('disposed:alpha')).toBeLessThan(f.sequence.indexOf('stream:beta'))
      // Sol review for the first run completes while the second BharatCode worker stays blocked.
      await f.completed.get('alpha')!.promise
      await f.parents.get('alpha')!.whenIdle()
      expect(f.requests.some(request => request.provider === 'codex' && request.model === 'review')).toBe(true)
      expect(JSON.stringify(f.checkpoint('alpha'))).toContain('"status":"completed"')
      expect(f.liveBharatcode).toBe(1)
      f.barriers.get('beta')!.resolve()
      await f.completed.get('beta')!.promise
      await f.parents.get('beta')!.whenIdle()
      expect(JSON.stringify(f.checkpoint('beta'))).toContain('"status":"completed"')
      expect(f.peakBharatcode).toBe(1)
      expect(f.liveBharatcode).toBe(0)
      expect(f.ctx.agents.list().filter(agent => agent.session.header.origin === 'subagent')).toEqual([])
    } finally { await f.cleanup() }
  }, 5000)

  it('cancels an owning run, disposes its actual child, and admits another owner without blocking the conversation', async () => {
    const f = await fixture()
    try {
      await f.send('alpha', 'dispatch'); await f.started.get('alpha')!.promise
      await f.send('beta', 'dispatch')
      await f.send('alpha', 'cancel')
      await f.disposed.get('alpha')!.promise
      await f.started.get('beta')!.promise
      expect(f.sequence.indexOf('disposed:alpha')).toBeLessThan(f.sequence.indexOf('stream:beta'))
      expect(f.disposalSessions.has(String(f.children[0]!.id))).toBe(true)
      await f.send('alpha')
      expect(f.parents.get('alpha')!.status).toBe('idle')
      expect(JSON.stringify(f.checkpoint('alpha'))).toContain('CANCELLED')
      f.barriers.get('beta')!.resolve()
      await f.completed.get('beta')!.promise
      await f.parents.get('beta')!.whenIdle()
      expect(f.peakBharatcode).toBe(1)
      expect(f.ctx.agents.list().filter(agent => agent.session.header.origin === 'subagent')).toEqual([])
    } finally { await f.cleanup() }
  }, 5000)

  it('gives owned read-only worker and reviewer tasks full tools and policy while rejecting nested dispatch', async () => {
    const f = await fixture({ exerciseTools: true })
    try {
      await f.send('alpha', 'dispatch')
      await f.started.get('alpha')!.promise
      const worker = f.children[0]!
      expect(f.ctx.sandboxPolicy.resolve({ session: worker.session }).mode).toBe('danger-full-access')
      f.barriers.get('alpha')!.resolve()
      await f.completed.get('alpha')!.promise
      await f.parents.get('alpha')!.whenIdle()
      expect(f.children).toHaveLength(2)
      expect(f.reads).toHaveLength(2)
      expect(f.writes).toHaveLength(2)
      for (const child of f.children) {
        const events = child.session.snapshotEvents()
        expect(events.some(event => event.type === 'sandbox/mode' && event.data.mode === 'danger-full-access')).toBe(true)
        expect(events.some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access')).toBe(true)
        expect(events.some(event => event.type === 'approval/policy' && event.data.policy === 'never')).toBe(true)
        expect(await readFile(join(f.directory, `${child.id}.txt`), 'utf8')).toBe('tool access verified')
        expect(JSON.stringify(events)).toContain('instead of spawning nested agents')
      }
      expect(JSON.stringify(f.checkpoint('alpha'))).toContain('"status":"completed"')
    } finally { await f.cleanup() }
  }, 5000)
})
