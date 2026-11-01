import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Conductor from '../src/index.ts'
import type { Checkpoint } from '../src/runner.ts'

function text(value: string): StreamChunk[] { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }] }
function tool(name: string, value: object, id: string): StreamChunk[] { const callId = ToolCallId(id), args = JSON.stringify(value); return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } }, { type: 'finish', reason: { kind: 'tool-calls' } }] }

describe('model-facing routing through the production runtime', () => {
  it('gives Sol a catalog, routes Luna natively and Muse through CLI, and saves reviewed model evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conductor-routing-')), ctx = new Context()
    const executable = join(root, 'fake-muse'), marker = join(root, 'cli-used')
    await mkdir(join(root, 'muse')); await writeFile(join(root, 'muse', 'auth.json'), '{}')
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);
if(a.includes('--version')){console.log('Muse Test 1.0');process.exit(0)}
const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));
const taskId=schema.properties.taskId.const;
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(a));
const event=(type,payload)=>console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:type,payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},...payload}}));
event('runtime.command.accepted',{kind:'command_accepted',command_kind:'turn.submit'});event('session.run.linked',{kind:'session_run_linked'});event('run.model.configured',{kind:'run_model_configured',provider_id:'meta',model_id:a[a.indexOf('--model')+1]});event('run.lifecycle.started',{kind:'run_started'});
console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:'run.terminal.completed',payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},kind:'run_terminal',terminal:'completed',text:JSON.stringify({taskId,status:'completed',summary:'CLI checked',evidence:['official client path'],changedFiles:[],tests:[],blockers:[],nextSteps:[]})}}));
`, { mode: 0o700 })
    const prior = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = root
    const one = { id: 'luna', owner: 'luna-author', title: 'Native check', role: 'researcher', prompt: 'Inspect native route', dependsOn: [], readOnly: true, writeScopes: [], model: { provider: 'codex', model: 'gpt-6-luna' } }
    const plan = { summary: 'Mixed routes', risk: 'low', requiresConfirmation: false, tasks: [one, { ...one, id: 'muse', owner: 'muse-author', title: 'Muse check', prompt: 'Inspect official client route', contextBudget: 8192, outputReserveTokens: 32000, safetyReserveTokens: 1024, model: { provider: 'muse', model: 'muse-spark-1.3' } }, { ...one, id: 'review', owner: 'reviewer', role: 'reviewer', dependsOn: ['luna','muse'], model: { provider: 'codex', model: 'review' } }] }
    let parentCalls = 0; let writesBeforeResume = 0; const native: string[] = []; let catalogVisible = false
    class Adapter extends LlmAdapter {
      override async listModels() { return ['lead','gpt-6-luna','review'].map(id => ({ provider: 'codex', id, name: id })) }
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_000 } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if(options.model==='lead'){
          parentCalls++
          if(parentCalls===1){catalogVisible=(options.tools??[]).some(t=>t.name==='conductor_models');yield* tool('conductor_models',{},'catalog')}
          else if(parentCalls===2)yield* tool('conductor_dispatch',{objective:'Inspect two model routes',plan},'dispatch')
          else if(parentCalls===3){
            const events = ctx.agents.get(SessionId('mixed-routing-parent'))!.session.snapshotEvents()
            writesBeforeResume = events.filter(event => event.type === 'todo/write').length
            const saved = [...events].reverse().find(event => event.type === 'todo/write')!
            const checkpoint = (saved.data as unknown as { orchestration: Checkpoint }).orchestration
            yield* tool('conductor_dispatch',{objective:'Inspect two model routes', plan: checkpoint.result.plan, runId: checkpoint.runId},'resume')
          }
          else yield* text('Finished')
          return
        }
        native.push(options.model)
        const id=options.model==='review'?'review':'luna'
        const report=id==='review'?{status:'approved',summary:'Reviewed',findings:[],checks:['both routes'],nextSteps:[]}:{taskId:id,status:'completed',summary:'Native checked',evidence:['native route'],changedFiles:[],tests:[],blockers:[],nextSteps:[]}
        yield* tool('structured_output',report,'result-'+id)
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx,{tools:{mode:'native'},workingDirectory:true})
      await ctx.plugin(Subagents);await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(Todo,{allowParallelInProgress:true})
      await ctx.plugin(Conductor,{backgroundMode:false, museExecutable:executable, maxConcurrentAgents:1, subagentLlmProvider:'codex',subagentModel:'gpt-6-luna',reviewerProvider:'codex',reviewerModel:'review'} as Conductor.ConfigValues)
      const harness=await mountAgentLoopTestHarness(ctx);ctx.llm.registerAdapter(['codex'],new Adapter())
      const parent=await harness.create(SessionId('mixed-routing-parent'),{provider:'codex',model:'lead'},{cwd:root})
      parent.followup(createUserMessage({content:[{type:'text',text:'Check the model routes.'}],source:{kind:'user'}}));await parent.whenIdle()
      expect(catalogVisible).toBe(true)
      const saved=[...parent.session.snapshotEvents()].reverse().find(e=>e.type==='todo/write')
      const checkpoint=(saved?.data as unknown as {orchestration:Checkpoint})?.orchestration
      expect(checkpoint?.result.status, JSON.stringify(parent.session.snapshotEvents().filter(e => e.type.includes('tool') || e.type === 'turn/end'))).toBe('completed')
      expect(native).toEqual(['gpt-6-luna','review'])
      expect(checkpoint.result.plan.tasks.find(task=>task.id==='muse')).toMatchObject({contextBudget:1_000_000, outputReserveTokens:32_000, safetyReserveTokens:1024})
      expect(parent.session.snapshotEvents().filter(event=>event.type==='todo/write').length).toBeGreaterThan(writesBeforeResume)
      expect(parentCalls).toBe(4)
      expect(checkpoint.result.taskStates.find(t=>t.taskId==='muse')).toMatchObject({state:'DONE',model:{provider:'muse',model:'muse-spark-1.3'},modelSource:'request'})
      const args=JSON.parse(await readFile(marker,'utf8'));expect(args).toContain('--disable-write');expect(args).toContain('--disable-shell')
    } finally { if(prior===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=prior;await ctx.fiber.dispose();await rm(root,{recursive:true,force:true}) }
  }, 10000)
})
