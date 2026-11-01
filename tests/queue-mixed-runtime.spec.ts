import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Conductor from '../src/index.ts'
import type { Checkpoint } from '../src/runner.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function text(value: string): StreamChunk[] { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }] }
function tool(name: string, value: object, id: string): StreamChunk[] { const callId = ToolCallId(id), args = JSON.stringify(value); return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } }, { type: 'finish', reason: { kind: 'tool-calls' } }] }
const user = (value: string) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    try { await stat(path); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for fixture barrier ${path}`)
}
function checkpoint(agent: Agent): Checkpoint {
  const event = [...agent.session.snapshotEvents()].reverse().find(item => item.type === 'todo/write')!
  return (event.data as unknown as { orchestration: Checkpoint }).orchestration
}
function graph(owner: string) {
  const worker = { id: `${owner}-worker`, owner: `${owner}-author`, title: 'Check route', role: 'researcher', prompt: `Inspect ${owner} route`, dependsOn: [] as string[], readOnly: true, writeScopes: [], model: owner === 'alpha' ? { provider: 'muse', model: 'muse-spark-1.3' } : { provider: 'codex', model: 'gpt-6-luna' } }
  return { summary: `Check ${owner}`, risk: 'low', requiresConfirmation: false, tasks: [worker,
    { ...worker, id: `${owner}-review`, owner: `${owner}-reviewer`, role: 'reviewer', dependsOn: [worker.id], model: { provider: 'codex', model: 'review' } }] }
}

async function fixture(mode: 'cancel' | 'nonzero' | 'schema' | 'concurrent') {
  const root = await mkdtemp(join(tmpdir(), 'conductor-mixed-queue-')), ctx = new Context()
  const prior = process.env.XDG_CONFIG_HOME
  const executable = join(root, 'fake-muse'), pidFile = join(root, 'pid'), releaseFile = join(root, 'release'), terminatingFile = join(root, 'terminating')
  const parents = new Map<string, Agent>(), actions = new Map<string, { name: string; args: object }>()
  const ownerNames = mode === 'concurrent' ? ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] : ['alpha', 'beta']
  const terminal = new Map(ownerNames.map(owner => [owner, deferred<string>()]))
  const nativeGates = new Map(ownerNames.map(owner => [owner, deferred<void>()]))
  const activeNative = new Set<string>()
  let peakNative = 0, peakBharatcode = 0
  const native: Array<{ task: string; museExited: boolean }> = []
  const nativeStarted = deferred<void>()
  class Adapter extends LlmAdapter {
    override async listModels(provider: string) { return (provider === 'bharatcode' ? ['worker'] : ['lead', 'gpt-6-luna', 'review']).map(id => ({ provider, id, name: id })) }
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.model === 'lead') {
        const owner = ownerNames.find(owner => String(options.sessionId).endsWith(owner))!
        const action = actions.get(owner)
        if (action !== undefined) { actions.delete(owner); yield* tool(action.name, action.args, `${owner}-${action.name}`) }
        else {
          const messages = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
          const status = messages.match(/Conductor run [^\n]+: (completed|cancelled|failed|blocked)\./)?.[1]
          if (status !== undefined) terminal.get(owner)!.resolve(status)
          yield* text('Coordinator available.')
        }
        return
      }
      const messages = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const task = messages.match(/^Task: ([^.]+)\./m)?.[1]!
      const pid = Number(await readFile(pidFile, 'utf8'))
      let museExited = false
      try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') museExited = true; else throw error }
      native.push({ task, museExited }); nativeStarted.resolve()
      if (mode === 'concurrent' && !task.endsWith('-review')) await nativeGates.get(task.split('-')[0]!)!.promise
      const report = task.endsWith('-review') ? { status: 'approved', summary: 'Reviewed native evidence', findings: [], checks: ['route checked'], nextSteps: [] }
        : { taskId: task, status: 'completed', summary: 'Native task checked', evidence: ['native route'], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
      yield* tool('structured_output', report, `${task}-result`)
    }
  }
  try {
    await mkdir(join(root, 'muse')); await writeFile(join(root, 'muse', 'auth.json'), '{}')
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);
if(a.includes('--version')){console.log('Muse Test 1.0');process.exit(0)}
const mode=${JSON.stringify(mode)},release=${JSON.stringify(releaseFile)};
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const event=(type,payload)=>console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:type,payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},...payload}}));
event('runtime.command.accepted',{kind:'command_accepted',command_kind:'turn.submit'});event('session.run.linked',{kind:'session_run_linked'});event('run.model.configured',{kind:'run_model_configured',provider_id:'meta',model_id:a[a.indexOf('--model')+1]});event('run.lifecycle.started',{kind:'run_started'});
process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(terminatingFile)},'received'));
const timer=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(timer);
if(mode==='concurrent')console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:'run.terminal.completed',payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},kind:'run_terminal',terminal:'completed',text:JSON.stringify({taskId:'alpha-worker',status:'completed',summary:'Muse checked',evidence:['fixture'],changedFiles:[],tests:[],blockers:[],nextSteps:[]})}}));
if(mode==='schema')console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:'run.terminal.completed',payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},kind:'run_terminal',terminal:'completed',text:JSON.stringify({taskId:'wrong-task',status:'completed'})}}));
process.exit(mode==='nonzero'?7:0)},5);
`, { mode: 0o700 })
    process.env.XDG_CONFIG_HOME = root
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' }, workingDirectory: true })
    await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(Todo, { allowParallelInProgress: true })
    await ctx.plugin(Conductor, { backgroundMode: true, minParallelTasks: 1, ...(mode === 'concurrent' ? {} : { maxConcurrentAgents: 1, maxActiveGenerations: 1 }), museExecutable: executable, subagentLlmProvider: 'codex', subagentModel: 'gpt-6-luna', reviewerProvider: 'codex', reviewerModel: 'review' } as Conductor.ConfigValues)
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      activeNative.add(String(agent.id)); peakNative = Math.max(peakNative, activeNative.size)
      peakBharatcode = Math.max(peakBharatcode, ctx.agents.list().filter(child => activeNative.has(String(child.id)) && child.options.provider === 'bharatcode').length)
    })
    ctx.on('agent/disposed', ({ agent }) => { activeNative.delete(String(agent.id)) })
    const harness = await mountAgentLoopTestHarness(ctx); ctx.llm.registerAdapter(['codex', 'bharatcode'], new Adapter())
    for (const owner of ownerNames) parents.set(owner, await harness.create(SessionId(`mixed-queue-${owner}`), { provider: 'codex', model: 'lead' }, { cwd: root }))
    const sendMessage = vi.spyOn(ctx.subagents, 'sendMessage')
    const command = async (owner: string, name: string, args: object = {}) => {
      actions.set(owner, { name, args }); parents.get(owner)!.followup(user(`Run ${name}.`)); await parents.get(owner)!.whenIdle()
    }
    return { root, pidFile, releaseFile, terminatingFile, parents, terminal, native, nativeStarted, sendMessage, command, nativeGates,
      get peakNative() { return peakNative }, get peakBharatcode() { return peakBharatcode },
      async dispose() { for (const gate of nativeGates.values()) gate.resolve(); await writeFile(releaseFile, 'release'); await ctx.fiber.dispose(); if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { await ctx.fiber.dispose(); if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; await rm(root, { recursive: true, force: true }); throw error }
}

describe('shared native/Muse child queue through the production runtime', () => {
  it('runs Luna and Muse beside one BharatCode while another owner queues, using default shared capacity three', async () => {
    const f = await fixture('concurrent')
    const assigned = (owner: string) => {
      const plan = graph(owner)
      if (owner === 'beta' || owner === 'gamma') {
        for (const task of plan.tasks) task.model = { provider: 'bharatcode', model: 'worker' }
      }
      return plan
    }
    try {
      await f.command('alpha', 'conductor_dispatch', { objective: 'Inspect alpha', plan: assigned('alpha') })
      await waitForFile(f.pidFile)
      await f.command('beta', 'conductor_dispatch', { objective: 'Inspect beta', plan: assigned('beta') })
      await vi.waitFor(() => expect(f.native.map(child => child.task)).toContain('beta-worker'))
      await f.command('gamma', 'conductor_dispatch', { objective: 'Inspect gamma', plan: assigned('gamma') })
      await f.command('delta', 'conductor_dispatch', { objective: 'Inspect delta', plan: assigned('delta') })
      await vi.waitFor(() => expect(f.native.map(child => child.task)).toContain('delta-worker'))
      expect(f.native.map(child => child.task)).toEqual(['beta-worker', 'delta-worker'])
      expect(f.native.every(child => !child.museExited)).toBe(true)
      await f.command('epsilon', 'conductor_dispatch', { objective: 'Inspect epsilon', plan: assigned('epsilon') })
      expect(f.native.map(child => child.task)).not.toContain('epsilon-worker')
      // Completing Luna frees shared capacity while both BharatCode owners retain their ordering.
      f.nativeGates.get('delta')!.resolve()
      await vi.waitFor(() => expect(f.native.map(child => child.task)).toContain('epsilon-worker'))
      expect(f.native.map(child => child.task)).not.toContain('gamma-worker')
      f.nativeGates.get('epsilon')!.resolve()
      expect(await f.terminal.get('delta')!.promise).toBe('completed')
      expect(await f.terminal.get('epsilon')!.promise).toBe('completed')
      f.nativeGates.get('beta')!.resolve()
      await vi.waitFor(() => expect(f.native.map(child => child.task)).toContain('gamma-worker'))
      f.nativeGates.get('gamma')!.resolve()
      expect(await f.terminal.get('beta')!.promise).toBe('completed')
      expect(await f.terminal.get('gamma')!.promise).toBe('completed')
      expect(f.peakBharatcode).toBe(1)
      // Muse remains alive throughout all native work, so native peak plus Muse is the global peak.
      expect(f.peakNative + 1).toBe(3)
      await writeFile(f.releaseFile, 'release')
      expect(await f.terminal.get('alpha')!.promise).toBe('completed')
    } finally { await f.dispose() }
  }, 10000)

  it('holds another owner until cancelled Muse has exited, and gives explicit external messaging guidance', async () => {
    const f = await fixture('cancel')
    try {
      await f.command('alpha', 'conductor_dispatch', { objective: 'Inspect alpha', plan: graph('alpha') })
      await waitForFile(f.pidFile)
      await f.command('beta', 'conductor_dispatch', { objective: 'Inspect beta', plan: graph('beta') })
      expect(f.native).toEqual([])
      expect(checkpoint(f.parents.get('beta')!).result.taskStates.find(task => task.taskId === 'beta-worker')?.state).toBe('ACTIVE')
      await f.command('alpha', 'conductor_message', { taskId: 'alpha-worker', message: 'Provide more evidence.' })
      expect(JSON.stringify(f.parents.get('alpha')!.session.snapshotEvents())).toContain('Cancel this run, wait for disposal, and resume its saved task with resumeContext')
      expect(f.sendMessage).not.toHaveBeenCalled()
      await f.command('alpha', 'conductor_cancel')
      await waitForFile(f.terminatingFile)
      expect(f.native).toEqual([])
      await writeFile(f.releaseFile, 'release')
      await f.nativeStarted.promise
      expect(await f.terminal.get('alpha')!.promise).toBe('cancelled')
      expect(await f.terminal.get('beta')!.promise).toBe('completed')
      expect(f.native).toEqual([{ task: 'beta-worker', museExited: true }, { task: 'beta-review', museExited: true }])
      expect(checkpoint(f.parents.get('alpha')!).result.taskStates.find(task => task.taskId === 'alpha-worker')).toMatchObject({ state: 'CANCELLED', model: { provider: 'muse', model: 'muse-spark-1.3' } })
      expect(checkpoint(f.parents.get('beta')!).result.review?.status).toBe('approved')
    } finally { await f.dispose() }
  }, 10000)

  it.each(['nonzero', 'schema'] as const)('releases a failed %s Muse child so another owner finishes without route fallback', async mode => {
    const f = await fixture(mode)
    try {
      await f.command('alpha', 'conductor_dispatch', { objective: 'Inspect alpha', plan: graph('alpha') })
      await waitForFile(f.pidFile)
      await f.command('beta', 'conductor_dispatch', { objective: 'Inspect beta', plan: graph('beta') })
      expect(f.native).toEqual([])
      await writeFile(f.releaseFile, 'release')
      expect(await f.terminal.get('alpha')!.promise).toBe('failed')
      expect(await f.terminal.get('beta')!.promise).toBe('completed')
      expect(f.native).toEqual([{ task: 'beta-worker', museExited: true }, { task: 'beta-review', museExited: true }])
      const failed = checkpoint(f.parents.get('alpha')!).result
      expect(failed.taskStates.find(task => task.taskId === 'alpha-worker')).toMatchObject({ state: 'FAILED', model: { provider: 'muse', model: 'muse-spark-1.3' }, modelSource: 'request' })
      expect(failed.workers[0].summary).toContain(mode === 'schema' ? 'valid final structured result' : 'exited unsuccessfully')
      expect(failed.agentsStarted).toBe(1)
      expect(checkpoint(f.parents.get('beta')!).result.review?.status).toBe('approved')
    } finally { await f.dispose() }
  }, 10000)
})
