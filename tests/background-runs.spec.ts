import { describe, expect, it, vi } from 'vitest'
import { BackgroundRuns, type RunResult } from '../src/background-runs.ts'
import type { Checkpoint } from '../src/runner.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function checkpoint(id = '00000000-0000-0000-0000-000000000001'): Checkpoint {
  return { version: 1, runId: id as never, objective: 'Inspect', result: {
    status: 'blocked', summary: 'Saved', plan: { summary: 'Inspect', risk: 'low', requiresConfirmation: false, tasks: [] },
    workers: [], review: null, agentsStarted: 0, taskStates: [],
  } }
}
function result(saved: Checkpoint, status: RunResult['status'] = 'completed'): RunResult {
  return { ...saved.result, runId: saved.runId, status }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('BackgroundRuns', () => {
  it('returns the committed receipt while work remains blocked, then retains reviewed results', async () => {
    const runs = new BackgroundRuns()
    const barrier = deferred<RunResult>()
    const saved = checkpoint()
    const terminal = vi.fn()
    const receipt = await runs.dispatch('owner', async ({ onCheckpoint }) => {
      onCheckpoint(saved)
      return barrier.promise
    }, terminal)
    expect(receipt.status).toBe('running')
    expect(receipt.checkpoint).toEqual(saved)
    expect(runs.active('owner')?.runId).toBe(saved.runId)
    expect(terminal).not.toHaveBeenCalled()
    saved.result.summary = 'mutated externally'
    receipt.checkpoint!.result.summary = 'mutated receipt'
    expect(runs.get('owner', saved.runId)?.checkpoint?.result.summary).toBe('Saved')
    barrier.resolve(result(saved))
    await flush()
    expect(runs.active('owner')).toBeUndefined()
    expect(runs.get('owner', saved.runId)?.status).toBe('completed')
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(terminal.mock.calls[0]![0].result.status).toBe('completed')
    await runs.shutdown()
  })

  it('reserves one owner before checkpoint and refuses cross-owner access or cancellation', async () => {
    const runs = new BackgroundRuns()
    const gate = deferred<void>()
    const done = deferred<RunResult>()
    const saved = checkpoint()
    const pending = runs.dispatch('owner', async ({ onCheckpoint }) => { await gate.promise; onCheckpoint(saved); return done.promise }, () => {})
    await expect(runs.dispatch('owner', async () => result(saved), () => {})).rejects.toThrow(/active/i)
    gate.resolve()
    await pending
    expect(runs.get('other', saved.runId)).toBeUndefined()
    expect(() => runs.cancel('other', saved.runId)).toThrow(/not found|owner/i)
    done.resolve(result(saved))
    await runs.shutdown()
  })

  it('cancels its independent signal but keeps ownership until cleanup settles', async () => {
    const runs = new BackgroundRuns()
    const cleanup = deferred<RunResult>()
    const saved = checkpoint()
    let signal!: AbortSignal
    const terminal = vi.fn()
    await runs.dispatch('owner', async context => { signal = context.signal; context.onCheckpoint(saved); return cleanup.promise }, terminal)
    expect(signal.aborted).toBe(false)
    expect(runs.cancel('owner', saved.runId).status).toBe('cancelled')
    expect(signal.aborted).toBe(true)
    await expect(runs.dispatch('owner', async () => result(saved), terminal)).rejects.toThrow(/active/i)
    expect(terminal).not.toHaveBeenCalled()
    cleanup.resolve(result(saved, 'failed'))
    await runs.shutdown()
    expect(runs.get('owner', saved.runId)?.status).toBe('cancelled')
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it('shutdown aborts work, refuses admission and awaits owned cleanup', async () => {
    const runs = new BackgroundRuns()
    const cleanup = deferred<RunResult>()
    const saved = checkpoint()
    let signal!: AbortSignal
    await runs.dispatch('owner', async context => { signal = context.signal; context.onCheckpoint(saved); return cleanup.promise }, () => {})
    let stopped = false
    const shutdown = runs.shutdown().then(() => { stopped = true })
    await flush()
    expect(signal.aborted).toBe(true)
    expect(stopped).toBe(false)
    await expect(runs.dispatch('new', async () => result(saved), () => {})).rejects.toThrow(/shut|closed/i)
    cleanup.resolve(result(saved, 'failed'))
    await shutdown
    expect(stopped).toBe(true)
  })

  it('rejects startup failure without notifying and releases the owner reservation', async () => {
    const runs = new BackgroundRuns()
    const terminal = vi.fn()
    await expect(runs.dispatch('owner', async () => { throw new Error('preflight failed') }, terminal)).rejects.toThrow('preflight failed')
    expect(terminal).not.toHaveBeenCalled()
    const saved = checkpoint()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return result(saved, 'plan-only') }, terminal)
    await runs.shutdown()
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it('rejects a launch that settles without a committed checkpoint', async () => {
    const runs = new BackgroundRuns()
    await expect(runs.dispatch('owner', async () => result(checkpoint()), () => {})).rejects.toThrow(/checkpoint/i)
    await runs.shutdown()
  })

  it.each(['blocked', 'failed', 'plan-only'] as const)('retains %s outcomes and contains notification errors', async status => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    const terminal = vi.fn(() => { throw new Error('notification unavailable') })
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return result(saved, status) }, terminal)
    await flush()
    await runs.shutdown()
    expect(runs.get('owner', saved.runId)?.status).toBe(status)
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it('shutdown waits for a terminal notification already in progress', async () => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    const notification = deferred<void>()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return result(saved) }, () => notification.promise)
    await flush()
    expect(runs.active('owner')).toBeUndefined()
    let stopped = false
    const shutdown = runs.shutdown().then(() => { stopped = true })
    await flush()
    expect(stopped).toBe(false)
    notification.resolve()
    await shutdown
    expect(stopped).toBe(true)
  })

  it('wait joins execution cleanup and terminal delivery before returning an independent final snapshot', async () => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    const execution = deferred<RunResult>()
    const notification = deferred<void>()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return execution.promise }, () => notification.promise)
    let finished = false
    const waiting = runs.wait('owner', saved.runId).then(snapshot => { finished = true; return snapshot })
    await flush()
    expect(finished).toBe(false)
    execution.resolve(result(saved))
    await flush()
    expect(runs.active('owner')).toBeUndefined()
    expect(finished).toBe(false)
    // Joining after execution ended still joins the already running notification.
    let lateFinished = false
    const late = runs.wait('owner', saved.runId).then(() => { lateFinished = true })
    await flush()
    expect(lateFinished).toBe(false)
    notification.resolve()
    const snapshot = await waiting
    await late
    expect(snapshot.status).toBe('completed')
    snapshot.result!.summary = 'changed returned copy'
    expect((await runs.wait('owner', saved.runId)).result!.summary).toBe('Saved')
    await runs.shutdown()
  })

  it('wait returns cancelled only after the cancelled execution has cleaned up', async () => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    const cleanup = deferred<RunResult>()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return cleanup.promise }, () => {})
    runs.cancel('owner', saved.runId)
    let finished = false
    const waiting = runs.wait('owner', saved.runId).then(snapshot => { finished = true; return snapshot })
    await flush()
    expect(finished).toBe(false)
    cleanup.resolve(result(saved, 'failed'))
    expect((await waiting).status).toBe('cancelled')
    await runs.shutdown()
  })

  it('wait rejects missing and cross-owner identities', async () => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return result(saved) }, () => {})
    await expect(runs.wait('other', saved.runId)).rejects.toThrow(/not found|owner/i)
    await expect(runs.wait('owner', 'unknown')).rejects.toThrow(/not found|owner/i)
    await runs.shutdown()
  })

  it('records post-admission execution failures and catches rejected async notifications', async () => {
    const runs = new BackgroundRuns()
    const saved = checkpoint()
    const execution = deferred<RunResult>()
    await runs.dispatch('owner', async ({ onCheckpoint }) => { onCheckpoint(saved); return execution.promise }, async () => { throw new Error('delivery failed') })
    execution.reject(new Error('worker broke'))
    await flush()
    expect(runs.get('owner', saved.runId)).toMatchObject({ status: 'failed', error: 'worker broke' })
    await runs.shutdown()
  })
})
