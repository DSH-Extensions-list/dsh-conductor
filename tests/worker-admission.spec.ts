import { describe, expect, it } from 'vitest'
import { WorkerAdmission } from '../src/worker-admission.ts'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const signal = () => new AbortController().signal

describe('provider-aware worker admission', () => {
  it('allows Luna and Muse alongside one BharatCode while a second BharatCode waits without consuming capacity', async () => {
    const admission = new WorkerAdmission(() => 3)
    const first = await admission.acquire('bharatcode', signal())
    let secondStarted = false
    const second = admission.acquire('bharatcode', signal()).then(release => { secondStarted = true; return release })
    let lunaStarted = false, museStarted = false
    const luna = admission.acquire('codex', signal()).then(release => { lunaStarted = true; return release })
    const muse = admission.acquire('muse', signal()).then(release => { museStarted = true; return release })
    await flush()
    expect(secondStarted).toBe(false)
    expect(lunaStarted).toBe(true)
    expect(museStarted).toBe(true)
    let overflowStarted = false
    const overflow = admission.acquire('other', signal()).then(release => { overflowStarted = true; return release })
    await flush(); expect(overflowStarted).toBe(false)
    ;(await luna)(); (await overflow)(); (await muse)()
    expect(secondStarted).toBe(false)
    first(); (await second)(); admission.close()
  })

  it('releases a reserved BharatCode permit when cancelled while the shared capacity is full', async () => {
    const admission = new WorkerAdmission(() => 1)
    const native = await admission.acquire('codex', signal())
    const controller = new AbortController()
    const cancelled = admission.acquire('bharatcode', controller.signal)
    await flush()
    const rejected = expect(cancelled).rejects.toThrow('cancel reservation')
    controller.abort(new Error('cancel reservation')); await rejected
    let bharatStarted = false
    const bharat = admission.acquire('bharatcode', signal()).then(release => { bharatStarted = true; return release })
    await flush(); expect(bharatStarted).toBe(false)
    native(); (await bharat)(); admission.close()
  })

  it('cancels a provider waiter without releasing the active BharatCode child', async () => {
    const admission = new WorkerAdmission(() => 3)
    const first = await admission.acquire('bharatcode', signal())
    const controller = new AbortController()
    const cancelled = admission.acquire('bharatcode', controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('cancel waiting')
    controller.abort(new Error('cancel waiting')); await rejected
    let nextStarted = false
    const next = admission.acquire('bharatcode', signal()).then(release => { nextStarted = true; return release })
    await flush(); expect(nextStarted).toBe(false)
    first(); (await next)(); admission.close()
  })

  it('rejects pending provider and shared waiters when closed', async () => {
    const admission = new WorkerAdmission(() => 1)
    const first = await admission.acquire('bharatcode', signal())
    const provider = expect(admission.acquire('bharatcode', signal())).rejects.toThrow('closed')
    const shared = expect(admission.acquire('muse', signal())).rejects.toThrow('closed')
    admission.close(); await Promise.all([provider, shared]); first()
    await expect(admission.acquire('bharatcode', signal())).rejects.toThrow('closed')
  })
})
