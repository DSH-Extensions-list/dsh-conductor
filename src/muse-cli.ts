/** Account-authenticated official Muse subprocess transport; caller owns scheduling. */
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, delimiter } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { PlannedTask, TaskModel } from './types.js'

export const MUSE_MODELS = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'] as const
interface MuseOptions {
  executable?: string
  timeoutMs?: number
  maxOutputBytes?: number
  onModel?: (model: TaskModel) => void
}
function accountEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['META_API_KEY', 'MODEL_API_KEY', 'MUSE_API_KEY', 'MUSE_AUTH_PATH']) delete env[key]
  return env
}
async function findExecutable(explicit?: string): Promise<string> {
  const configured = explicit ?? process.env.DSH_MUSE_EXECUTABLE
  const candidates = configured === undefined
    ? [join(homedir(), '.local', 'bin', 'muse'), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'muse'))]
    : configured.includes('/') ? [resolve(configured)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, configured))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Official Muse CLI executable is unavailable; configure DSH_MUSE_EXECUTABLE or install muse on PATH')
}

/** Linux process groups include inherited background children even after their leader exits. */
async function groupHasExecutableMembers(group: number): Promise<boolean> {
  try { process.kill(-group, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  const entries = await readdir('/proc')
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let value: string
    try { value = await readFile(`/proc/${entry}/stat`, 'utf8') } catch (error) {
      if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') return true
  }
  return false
}
async function awaitGroupQuiescence(group: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (await groupHasExecutableMembers(group)) {
    if (Date.now() >= deadline) throw new Error('Muse process group did not reach quiescence')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Muse's structured-output endpoint requires every object property to be required. */
function strictWireSchema(schema: JsonSchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema }
  if (schema.oneOf !== undefined) { delete result.oneOf; result.anyOf = schema.oneOf.map(strictWireSchema) }
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? [])
    result.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name,
      required.has(name) || validateJsonSchemaValue(child, null).length === 0
        ? strictWireSchema(child) : { anyOf: [strictWireSchema(child), { type: 'null' }] },
    ]))
    result.required = Object.keys(schema.properties ?? {})
    result.additionalProperties = false
  }
  if (schema.items !== undefined) result.items = strictWireSchema(schema.items)
  return result
}
/** Remove only null sentinels introduced for optional fields that originally rejected null. */
function restoreOptionalFields(schema: JsonSchemaNode, value: unknown): unknown {
  if (schema.oneOf !== undefined) {
    for (const branch of schema.oneOf) {
      const candidate = restoreOptionalFields(branch, value)
      if (validateJsonSchemaValue(branch, candidate).length === 0) return candidate
    }
    return value
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) return value.map(item => restoreOptionalFields(schema.items!, item))
  if (schema.type !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const required = new Set(schema.required ?? [])
  return Object.fromEntries(Object.entries(value).flatMap(([name, child]) => {
    const definition = schema.properties?.[name]
    if (definition === undefined) return [[name, child]]
    if (child === null && !required.has(name) && validateJsonSchemaValue(definition, null).length > 0) return []
    return [[name, restoreOptionalFields(definition, child)]]
  }))
}

/** Version and account-login presence only; account entitlement is checked by Muse on execution. */
export async function probeMuseCli(executable?: string): Promise<{ available: boolean; reason?: string; version?: string }> {
  if (process.platform !== 'linux') return { available: false, reason: 'Official Muse CLI workers currently require Linux process-group supervision' }
  let command: string
  try { command = await findExecutable(executable) } catch { return { available: false, reason: 'Official Muse CLI executable is unavailable' } }
  const version = await new Promise<string | undefined>(resolveVersion => {
    const child = spawn(command, ['--version'], { env: accountEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    let output = '', failed = false
    const kill = () => { failed = true; try { process.platform === 'win32' ? child.kill('SIGKILL') : child.pid && process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }
    const timeout = setTimeout(kill, 5000)
    child.stdout.on('data', (chunk: Buffer) => { if (Buffer.byteLength(output) + chunk.length > 4096) kill(); else output += chunk.toString('utf8') })
    child.once('error', () => { failed = true })
    child.once('close', code => { clearTimeout(timeout); resolveVersion(!failed && code === 0 && /^muse\s+\S+/i.test(output.trim()) ? output.trim() : undefined) })
  })
  if (version === undefined) return { available: false, reason: 'Official Muse CLI version probe failed' }
  const auth = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'), 'muse', 'auth.json')
  try { if (!(await stat(auth)).isFile()) throw new Error('not a file') } catch { return { available: false, version, reason: 'Muse account login is absent; run muse login' } }
  return { available: true, version, reason: 'Official CLI and account-login file present; model entitlement is not verified until execution' }
}

/** Start an external child. Its synthetic id is not a native DSH Session. */
export async function startMuseTask(request: SubagentStartRequest, task: PlannedTask, options: MuseOptions = {}): Promise<SubagentRun> {
  request.signal.throwIfAborted()
  if (process.platform !== 'linux') throw new Error('Muse subprocess lifecycle currently requires Linux process-group supervision')
  const model = request.agentOptions?.model
  if (typeof model !== 'string' || !(MUSE_MODELS as readonly string[]).includes(model)) throw new Error('Unsupported official Muse subscription model')
  if (request.agentOptions?.provider !== undefined && request.agentOptions.provider !== 'muse') throw new Error('Muse CLI requires the muse provider route')
  if (request.prompt.some(block => block.type !== 'text')) throw new Error('Muse CLI handoffs support text content only')
  if (request.outputSchema === undefined) throw new Error('Muse CLI requires an explicit output schema')
  assertObjectJsonSchema(request.outputSchema)
  const cwd = request.cwd ?? request.parent.session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Muse CLI requires an existing absolute workspace directory')
  const reasoningEffort = request.agentOptions?.reasoningEffort
  if (reasoningEffort !== undefined && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(reasoningEffort)) throw new Error('Unsupported Muse reasoning effort')
  const timeoutMs = options.timeoutMs ?? 15 * 60_000, maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid Muse subprocess limits')
  const executable = await findExecutable(options.executable)
  const root = await mkdtemp(join(tmpdir(), 'dsh-conductor-muse-'))
  try {
    const promptFile = join(root, 'prompt.txt'), schemaFile = join(root, 'schema.json')
    await Promise.all([
      writeFile(promptFile, request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n\n'), { mode: 0o600 }),
      writeFile(schemaFile, JSON.stringify(strictWireSchema(request.outputSchema)), { mode: 0o600 }),
    ])
    request.signal.throwIfAborted()
    const args = ['exec', '--json', '--prompt-file', promptFile, '--output-schema', schemaFile, '--workspace', cwd,
      '--provider', 'meta', '--model', model, '--contributor-mode', 'off', '--no-foreign-personal-context', '--no-session-log',
      '--max-model-steps', '40', '--disable-request-user-input', '--disable-reminders',
      '--config', 'agents.execution_capacity=1',
      '--config', 'run.workflow_trigger_mode="off"',
      '--config', 'local_session_messaging.enabled=false',
      '--config', 'runtime_capabilities=' + JSON.stringify(Object.fromEntries(
        ['goal-reminder', 'memory', 'scope-reminder', 'skill-reminder', 'todo-reminder', 'verify-reminder']
          .map(name => [`plugin:tbh-reminders:reminder:${name}`, { enabled: false }]),
      )),
      ...(reasoningEffort === undefined ? [] : ['--reasoning-effort', reasoningEffort]),
      ...(task.readOnly ? ['--disable-write', '--disable-shell'] : ['--approval-mode', 'never']),
    ]
    const child = spawn(executable, args, { cwd, env: accountEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let failure: string | undefined, aborted = false, closed = false, bytes = 0, pending = ''
    const decoder = new StringDecoder('utf8')
    let terminal: { text: string } | undefined
    let rootSession: string | undefined, rootCommand: string | undefined, rootRun: string | undefined
    let rootStarted = false, rootModelConfigured = false
    let cleanupError: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid !== undefined) process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'Muse subprocess termination failed' }
    }
    const stop = (reason: string, cancel = false) => {
      failure ??= reason; aborted ||= cancel
      if (closed) return
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), 300)
    }
    const onAbort = () => stop('Muse task aborted', true)
    const timer = setTimeout(() => stop('Muse task timed out'), timeoutMs)
    const parseLine = (line: string) => {
      if (!line.trim() || failure !== undefined) return
      try {
        const event = JSON.parse(line)
        if (event.schema_version !== 1 || typeof event.payload_type !== 'string' || !event.payload || typeof event.payload !== 'object') throw new Error('envelope')
        const payload = event.payload
        if (event.payload_type === 'runtime.command.accepted' && payload.kind === 'command_accepted' && payload.command_kind === 'turn.submit') {
          if (rootCommand !== undefined || typeof payload.command_id !== 'string' || event.stream?.kind !== 'session' || typeof event.stream.id !== 'string') throw new Error('root command')
          rootCommand = payload.command_id; rootSession = event.stream.id
        }
        if (event.payload_type === 'session.run.linked' && payload.kind === 'session_run_linked') {
          if (rootCommand === undefined || rootRun !== undefined || payload.command_id !== rootCommand || event.stream?.id !== rootSession || payload.run_stream?.kind !== 'run' || typeof payload.run_stream.id !== 'string') throw new Error('root run link')
          rootRun = payload.run_stream.id
        }
        const fromRoot = rootRun !== undefined && payload.command_id === rootCommand && payload.run_stream?.kind === 'run' && payload.run_stream.id === rootRun && event.stream?.kind === 'session' && event.stream.id === rootSession
        if (event.payload_type === 'run.lifecycle.started' && payload.kind === 'run_started') {
          if (!fromRoot) throw new Error('foreign run lifecycle')
          rootStarted = true
        }
        if (event.payload_type === 'run.model.configured' && payload.kind === 'run_model_configured') {
          if (!fromRoot || payload.provider_id !== 'meta' || payload.model_id !== model) throw new Error('model route changed')
          rootModelConfigured = true
          options.onModel?.({ provider: 'muse', model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
        }
        if (event.payload_type.startsWith('run.terminal.')) {
          if (!fromRoot || !rootStarted || !rootModelConfigured || terminal !== undefined || event.record_type !== 'event' || event.payload_type !== 'run.terminal.completed' || payload.kind !== 'run_terminal' || payload.terminal !== 'completed' || typeof payload.text !== 'string') throw new Error('terminal')
          terminal = { text: payload.text }
        }
      } catch { stop('Muse emitted an invalid or unsuccessful protocol event') }
    }
    const result = new Promise<SubagentResult>(resolveResult => {
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxOutputBytes) { stop('Muse output exceeded the configured byte limit'); return }
        pending += decoder.write(chunk)
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); parseLine(line) }
      })
      // Never surface raw stderr: it may contain workspace text or credentials.
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxOutputBytes) stop('Muse output exceeded the configured byte limit') })
      child.once('error', () => { failure ??= 'Muse CLI subprocess failed to start' })
      child.once('close', async code => {
        closed = true; clearTimeout(timer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        // A successful leader may leave background jobs with closed stdio. Always stop its group.
        kill('SIGKILL')
        try { if (child.pid !== undefined) await awaitGroupQuiescence(child.pid) } catch {
          cleanupError = new Error('Muse process-group cleanup could not establish quiescence')
          failure = cleanupError.message
        }
        request.signal.removeEventListener('abort', onAbort)
        pending += decoder.end()
        if (pending.trim()) parseLine(pending)
        if (code !== 0) failure ??= 'Muse CLI exited unsuccessfully'
        let structured: unknown
        if (failure === undefined) {
          try {
            if (terminal === undefined) throw new Error('missing terminal')
            structured = restoreOptionalFields(request.outputSchema!, JSON.parse(terminal.text))
            if (validateJsonSchemaValue(request.outputSchema!, structured).length > 0) throw new Error('invalid schema')
          } catch { failure = 'Muse completed without a valid final structured result' }
        }
        try { await rm(root, { recursive: true, force: true }) } catch { failure ??= 'Muse temporary file cleanup failed' }
        resolveResult(failure === undefined
          ? { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(structured) }], structured }
          : { stopReason: aborted ? 'aborted' : 'error', output: [], diagnostic: failure })
      })
    })
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    let disposed: Promise<void> | undefined
    return { id: SessionId(`muse-${randomUUID()}`), result, dispose() { return disposed ??= (async () => { stop('Muse task disposed', true); await result; if (cleanupError !== undefined) throw cleanupError })() } }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
