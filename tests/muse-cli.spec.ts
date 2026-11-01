import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { PlannedTask } from '../src/types.js'
import { WORKER_SCHEMA } from '../src/schemas.js'
import { MUSE_MODELS, probeMuseCli, startMuseTask } from '../src/muse-cli.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } as const
const task: PlannedTask = { id: 'a', title: 'inspect', owner: 'Muse', role: 'researcher', prompt: 'Inspect', dependsOn: [], readOnly: true, writeScopes: [] }
async function setup(body = '') {
  const root = await mkdtemp(join(tmpdir(), 'conductor-muse-test-')); roots.push(root)
  const executable = join(root, 'muse')
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Muse Code 1.4.14 (1.4.14-R7309.1)'); process.exit(0); }
const option = key => args[args.indexOf(key) + 1];
fs.writeFileSync(${JSON.stringify(join(root, 'capture.json'))}, JSON.stringify({args,env:Object.fromEntries(['META_API_KEY','MODEL_API_KEY','MUSE_API_KEY','MUSE_AUTH_PATH'].map(k=>[k,process.env[k]??null])),prompt:fs.readFileSync(option('--prompt-file'),'utf8'),schema:JSON.parse(fs.readFileSync(option('--output-schema'),'utf8'))}));
const event = (type,payload) => console.log(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:type,payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},...payload}}));
event('runtime.command.accepted',{kind:'command_accepted',command_kind:'turn.submit'}); event('session.run.linked',{kind:'session_run_linked'}); event('run.model.configured',{kind:'run_model_configured',provider_id:'meta',model_id:'muse-spark-1.3'}); event('run.lifecycle.started',{kind:'run_started'});
${body || `event('run.model.configured',{kind:'run_model_configured',provider_id:'meta',model_id:'muse-spark-1.3'}); event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":true}'});`}
`, { mode: 0o700 })
  const controller = new AbortController()
  const request = { cwd: root, parent: {}, signal: controller.signal, prompt: [{ type: 'text', text: 'Inspect this workspace' }], outputSchema: schema, agentOptions: { provider: 'muse', model: 'muse-spark-1.3', reasoningEffort: 'low' } } as unknown as SubagentStartRequest
  return {root,executable,request,controller,capture:async()=>JSON.parse(await readFile(join(root,'capture.json'),'utf8'))}
}

describe('official Muse CLI adapter', () => {
  it('uses account CLI, schema files, restrictive read-only flags and observed model events', async () => {
    const f = await setup(); const observed = vi.fn()
    for (const key of ['META_API_KEY','MODEL_API_KEY','MUSE_API_KEY','MUSE_AUTH_PATH']) vi.stubEnv(key, 'must-not-leak')
    const run = await startMuseTask(f.request, task, {executable:f.executable,onModel:observed})
    expect(await run.result).toMatchObject({stopReason:'completed',structured:{ok:true}})
    const capture = await f.capture()
    expect(capture.prompt).toBe('Inspect this workspace'); expect(capture.schema).toEqual(schema)
    expect(capture.env).toEqual({META_API_KEY:null,MODEL_API_KEY:null,MUSE_API_KEY:null,MUSE_AUTH_PATH:null})
    for (const flag of ['--disable-write','--disable-shell','--no-session-log','--no-foreign-personal-context','--disable-request-user-input']) expect(capture.args).toContain(flag)
    expect(capture.args).not.toContain('--yolo'); expect(capture.args).not.toContain('--disable-sandbox')
    expect(capture.args[capture.args.indexOf('--contributor-mode')+1]).toBe('off')
    expect(observed).toHaveBeenCalledWith({provider:'muse',model:'muse-spark-1.3',reasoningEffort:'low'})
    await run.dispose(); await run.dispose()
    await expect(access(capture.args[capture.args.indexOf('--prompt-file')+1])).rejects.toThrow()
  })
  it('forces a one-root Muse execution tree and disables workflows and observers per run', async () => {
    const f=await setup(); const run=await startMuseTask(f.request,task,{executable:f.executable})
    expect((await run.result).stopReason).toBe('completed')
    const {args}=await f.capture(); const overrides=args.flatMap((value:string,index:number)=>value==='--config'?[args[index+1]]:[])
    expect(overrides).toContain('agents.execution_capacity=1')
    expect(overrides).toContain('run.workflow_trigger_mode="off"')
    expect(overrides).toContain('local_session_messaging.enabled=false')
    const capabilities=JSON.parse(overrides.find((v:string)=>v.startsWith('runtime_capabilities='))?.split('=').slice(1).join('=')??'{}')
    for(const name of ['goal-reminder','memory','scope-reminder','skill-reminder','todo-reminder','verify-reminder'])expect(capabilities[`plugin:tbh-reminders:reminder:${name}`]).toEqual({enabled:false})
    expect(args).toContain('--disable-reminders');await run.dispose()
  })
  it('adapts optional WorkerReport fields to strict nullable wire fields and restores omission',async()=>{
    const f=await setup(`event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:JSON.stringify({taskId:'muse',status:'needs_more_context',summary:'Need a file',evidence:[],changedFiles:[],tests:[],blockers:[],nextSteps:[],needs:[{kind:'NEED_FILE',reason:'Missing file',requestedContextTokens:null}]})});`)
    const original={...WORKER_SCHEMA,properties:{...WORKER_SCHEMA.properties,taskId:{type:'string',const:'muse'}}} as SubagentStartRequest['outputSchema']
    const run=await startMuseTask({...f.request,outputSchema:original},task,{executable:f.executable})
    const result=await run.result
    expect(result.stopReason).toBe('completed');expect(result.structured).toMatchObject({needs:[{kind:'NEED_FILE',reason:'Missing file'}]})
    expect((result.structured as {needs:object[]}).needs[0]).not.toHaveProperty('requestedContextTokens')
    const wire=(await f.capture()).schema
    expect(wire.required).toContain('needs');expect(wire.properties.needs.anyOf[0].items.required).toContain('requestedContextTokens')
    expect(wire.properties.needs.anyOf[1]).toEqual({type:'null'})
    expect(original?.required).not.toContain('needs');await run.dispose()
  })
  it('omits an absent optional field represented by null while retaining original validation',async()=>{
    const f=await setup(`event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":true,"detail":null}'});`)
    const original={...schema,properties:{...schema.properties,detail:{type:'string'}}} as SubagentStartRequest['outputSchema']
    const run=await startMuseTask({...f.request,outputSchema:original},task,{executable:f.executable})
    expect((await run.result).structured).toEqual({ok:true});await run.dispose()
  })
  it('preserves null explicitly allowed by original required and optional properties',async()=>{
    const f=await setup(`event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"requiredNull":null,"optionalNull":null,"mandatory":"yes"}'});`)
    const original={type:'object',properties:{requiredNull:{type:'null'},optionalNull:{oneOf:[{type:'string'},{type:'null'}]},mandatory:{type:'string'}},required:['requiredNull','mandatory'],additionalProperties:false} as SubagentStartRequest['outputSchema']
    const run=await startMuseTask({...f.request,outputSchema:original},task,{executable:f.executable})
    expect((await run.result).structured).toEqual({requiredNull:null,optionalNull:null,mandatory:'yes'});await run.dispose()
  })
  it('still rejects a null required field which the original schema disallows',async()=>{
    const f=await setup(`event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":null,"detail":null}'});`)
    const original={...schema,properties:{...schema.properties,detail:{type:'string'}}} as SubagentStartRequest['outputSchema']
    const run=await startMuseTask({...f.request,outputSchema:original},task,{executable:f.executable})
    expect((await run.result).stopReason).toBe('error');await run.dispose()
  })
  it('allows workspace edits while retaining sandbox and subscription attestation', async () => {
    const f=await setup(); const run=await startMuseTask(f.request,{...task,readOnly:false,writeScopes:['src']},{executable:f.executable})
    expect((await run.result).stopReason).toBe('completed'); const {args}=await f.capture()
    expect(args[args.indexOf('--approval-mode')+1]).toBe('never'); expect(args).not.toContain('--disable-write'); expect(args).not.toContain('--disable-shell'); expect(args).not.toContain('--disable-sandbox'); expect(args).not.toContain('--yolo')
    await run.dispose()
  })
  it.each([
    ['tool text', `event('tool.result',{text:'{"ok":true}'});`],
    ['invalid schema', `event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":"wrong"}'});`],
    ['nonzero exit', `event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":true}'}); process.exitCode=7;`],
    ['failed terminal', `event('run.terminal.failed',{kind:'run_terminal',terminal:'failed',text:'{"ok":true}'});`],
    ['nested terminal', `event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',command_id:'child-command',run_stream:{kind:'run',id:'child-run'},text:'{"ok":true}'});`],
    ['malformed JSONL', `console.log('not-json');`],
  ])('fails closed for %s', async (_,body) => {
    const f=await setup(body); const run=await startMuseTask(f.request,task,{executable:f.executable})
    const result=await run.result; expect(result.stopReason).toBe('error'); expect(result.structured).toBeUndefined(); expect(result.diagnostic).toBeTruthy(); await run.dispose()
  })
  it('bounds output and terminates timed-out subprocesses',async()=>{
    for(const [body,options] of [[`console.log('x'.repeat(10000)); setInterval(()=>{},1000);`,{maxOutputBytes:500}], [`setInterval(()=>{},1000);`,{timeoutMs:100}]] as const){
      const f=await setup(body); const run=await startMuseTask(f.request,task,{executable:f.executable,...options}); expect((await run.result).stopReason).toBe('error'); await run.dispose()
    }
  })
  it('aborts running subprocesses and rejects pre-aborted starts',async()=>{
    const f=await setup('setInterval(()=>{},1000);'); const run=await startMuseTask(f.request,task,{executable:f.executable}); f.controller.abort()
    expect((await run.result).stopReason).toBe('aborted'); await run.dispose(); await expect(startMuseTask(f.request,task,{executable:f.executable})).rejects.toThrow(/abort/i)
  })
  it('kills a subprocess which ignores SIGTERM before disposal completes',async()=>{
    const f=await setup(`process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`)
    const run=await startMuseTask(f.request,task,{executable:f.executable,timeoutMs:300}); expect((await run.result).stopReason).toBe('error'); await run.dispose()
  })
  it.each(['completed','aborted','timeout'])('reaps the owned background process group before %s result settles',async(mode)=>{
    const f=await setup(`const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); fs.writeFileSync(require('node:path').join(option('--workspace'),'descendant.pid'),String(child.pid)); child.unref(); ${mode === 'completed' ? `event('run.terminal.completed',{kind:'run_terminal',terminal:'completed',text:'{"ok":true}'});` : `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`}`)
    const run=await startMuseTask(f.request,task,{executable:f.executable,timeoutMs:mode==='timeout'?150:5000})
    let pid=0
    for(let attempt=0;attempt<100;attempt++) {try{pid=Number(await readFile(join(f.root,'descendant.pid'),'utf8'));break}catch{await new Promise(resolve=>setTimeout(resolve,5))}}
    expect(pid).toBeGreaterThan(0)
    if(mode==='aborted')f.controller.abort()
    try {
      expect((await run.result).stopReason).toBe(mode==='completed'?'completed':mode==='aborted'?'aborted':'error')
      let state:string|undefined
      try{const info=await readFile(`/proc/${pid}/stat`,'utf8');state=info.slice(info.lastIndexOf(')')+2).split(' ')[0]}catch{}
      expect(state===undefined||state==='Z'||state==='X').toBe(true)
      await run.dispose()
    }finally {try{process.kill(pid,'SIGKILL')}catch{}}
  })
  it('rejects unsupported contributor models and multimodal handoffs',async()=>{
    const f=await setup(); await expect(startMuseTask({...f.request,agentOptions:{model:'muse-spark-1.3-contributor'}},task,{executable:f.executable})).rejects.toThrow(/model/i)
    await expect(startMuseTask({...f.request,prompt:[{type:'image'}] as never},task,{executable:f.executable})).rejects.toThrow(/text/i)
    expect(MUSE_MODELS).toEqual(['muse-spark-1.3','muse-spark-1.2','muse-spark-1.1'])
  })
  it('preserves a UTF-8 final result split across stdout chunks',async()=>{
    const f=await setup(`const line=Buffer.from(JSON.stringify({schema_version:1,record_type:'event',stream:{kind:'session',id:'session-main'},payload_type:'run.terminal.completed',payload:{command_id:'command-main',run_stream:{kind:'run',id:'run-main'},kind:'run_terminal',terminal:'completed',text:JSON.stringify({ok:true,label:'नमस्ते'})}})+'\\n'); const split=line.indexOf(Buffer.from('न'))+1; process.stdout.write(line.subarray(0,split)); setTimeout(()=>process.stdout.write(line.subarray(split)),15);`)
    const request={...f.request,outputSchema:{type:'object',properties:{ok:{type:'boolean'},label:{type:'string'}},required:['ok','label'],additionalProperties:false}} as SubagentStartRequest
    const run=await startMuseTask(request,task,{executable:f.executable}); expect((await run.result).structured).toEqual({ok:true,label:'नमस्ते'}); await run.dispose()
  })
  it('disposal cancels a live run and waits for cleanup',async()=>{
    const f=await setup('setInterval(()=>{},1000);'); const run=await startMuseTask(f.request,task,{executable:f.executable})
    await Promise.all([run.dispose(),run.dispose()]); expect((await run.result).stopReason).toBe('aborted')
  })
  it('rejects a missing schema or nonabsolute workspace before spawning',async()=>{
    const f=await setup(); await expect(startMuseTask({...f.request,outputSchema:undefined},task,{executable:f.executable})).rejects.toThrow(/schema/i)
    await expect(startMuseTask({...f.request,cwd:'relative'},task,{executable:f.executable})).rejects.toThrow(/absolute/i)
  })
  it.runIf(process.env.CONDUCTOR_MUSE_LIVE === '1')('completes a live official Muse account-authenticated read-only structured turn',async()=>{
    expect(await probeMuseCli()).toMatchObject({available:true})
    const f=await setup(); const run=await startMuseTask({...f.request,prompt:[{type:'text',text:'Return the structured object with ok true. Do not use tools.'}]},task,{timeoutMs:90_000})
    try{expect(await run.result).toMatchObject({stopReason:'completed',structured:{ok:true}})}finally{await run.dispose()}
  },100_000)
  it.runIf(process.env.CONDUCTOR_MUSE_LIVE === '1')('writes a live file and returns the original optional-field WorkerReport contract',async()=>{
    await mkdir(join(process.cwd(),'work/muse-edit-debug'),{recursive:true,mode:0o700})
    const root=await mkdtemp(join(process.cwd(),'work/muse-edit-debug/live.'));roots.push(root)
    const f=await setup()
    const workerSchema={...WORKER_SCHEMA,properties:{...WORKER_SCHEMA.properties,taskId:{type:'string',const:'muse'}}} as SubagentStartRequest['outputSchema']
    const run=await startMuseTask({...f.request,cwd:root,outputSchema:workerSchema,prompt:[{type:'text',text:'Write muse.txt with exactly MUSE_OK followed by one newline. Modify no other file. Do not delegate or spawn subagents. Verify its content. Return a WorkerReport with taskId muse, status completed, summary, evidence, changedFiles ["muse.txt"], tests [], blockers [], nextSteps []. Use null for needs when there are no needs.'}]},{...task,id:'muse',readOnly:false,writeScopes:['muse.txt']},{timeoutMs:90_000})
    try{
      const result=await run.result;expect(result).toMatchObject({stopReason:'completed',structured:{taskId:'muse',status:'completed',changedFiles:['muse.txt']}})
      expect((result.structured as object)).not.toHaveProperty('needs');expect(await readFile(join(root,'muse.txt'),'utf8')).toBe('MUSE_OK\n')
    }finally{await run.dispose()}
  },100_000)
  it('probes CLI version and account-login presence without claiming model entitlement',async()=>{
    const f=await setup(); vi.stubEnv('XDG_CONFIG_HOME',join(f.root,'config'))
    expect(await probeMuseCli(f.executable)).toMatchObject({available:false,reason:expect.stringMatching(/login/i)})
    await mkdir(join(f.root,'config','muse'),{recursive:true}); await writeFile(join(f.root,'config','muse','auth.json'),'not-read-as-a-token')
    expect(await probeMuseCli(f.executable)).toMatchObject({available:true,version:'Muse Code 1.4.14 (1.4.14-R7309.1)',reason:expect.stringMatching(/entitlement.*not|not.*entitlement/i)})
    expect(await probeMuseCli(join(f.root,'missing'))).toMatchObject({available:false})
  })
  it.skipIf(process.env.CONDUCTOR_MUSE_LIVE!=='1')('official trusted-workspace runtime rejects an actual spawn attempt without child admission',async()=>{
    const root=await mkdtemp(join(tmpdir(),'conductor-no-nesting-live-'));roots.push(root)
    const outputSchema={type:'object',properties:{attempted:{type:'boolean'},blocked:{type:'boolean'},reason:{type:'string'}},required:['attempted','blocked','reason'],additionalProperties:false}
    const schemaPath=join(root,'result.schema.json');await writeFile(schemaPath,JSON.stringify(outputSchema))
    const env={...process.env};for(const k of ['META_API_KEY','MODEL_API_KEY','MUSE_API_KEY','MUSE_AUTH_PATH'])delete env[k]
    const capabilities=Object.fromEntries(['goal-reminder','memory','scope-reminder','skill-reminder','todo-reminder','verify-reminder'].map(n=>[`plugin:tbh-reminders:reminder:${n}`,{enabled:false}]))
    const {stdout}=await promisify(execFile)(join(homedir(),'.local','bin','muse'),['exec','--json','--provider','meta','--model','muse-spark-1.3','--workspace',root,'--trust-workspace','--reasoning-effort','low','--output-schema',schemaPath,'--disable-write','--disable-shell','--disable-request-user-input','--disable-reminders','--no-foreign-personal-context','--no-session-log','--contributor-mode','off','--max-model-steps','5','--config','agents.execution_capacity=1','--config','run.workflow_trigger_mode="off"','--config','local_session_messaging.enabled=false','--config','runtime_capabilities='+JSON.stringify(capabilities),'This is an admission-control test. Attempt exactly one native subagent_spawn call asking a child to reply QUEUE_BYPASS. Root capacity is one. Do not work around a refusal or use shell, workflows or another client. attempted is true only if you called the tool; blocked is true only for a runtime refusal. Quote the exact refusal in reason, then return structured output.'],{env,timeout:60000,maxBuffer:8*1024*1024})
    const events=stdout.split('\n').filter(Boolean).map(l=>JSON.parse(l))
    const terminal=events.find(e=>e.payload_type==='run.terminal.completed')
    const result=JSON.parse(terminal?.payload.text??'null')
    expect(result).toMatchObject({attempted:true,blocked:true})
    expect(result.reason).toContain('root_capacity_exhausted')
    const spawn=events.find(e=>e.payload_type==='tool.result'&&e.payload.correlation_facts?.tool_name==='subagent_spawn')
    const refusal=JSON.parse(spawn?.payload.text??'null')
    expect(refusal).toMatchObject({status:'rejected',reason:'root_capacity_exhausted'})
    expect(refusal.hint).toMatch(/no agent was created or queued/i)
    const usage=events.find(e=>e.payload_type==='run.usage')?.payload
    expect(usage?.children_included).toBe(false)
    expect(events.filter(e=>e.payload_type==='run.model.configured')).toHaveLength(1)
  },65000)

})
