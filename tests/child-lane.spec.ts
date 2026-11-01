import { describe, expect, it } from 'vitest'
import { ChildLane } from '../src/child-lane.ts'

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

describe('ChildLane', () => {
  it('admits one child across owners and grants queued children in FIFO order', async () => {
    const lane = new ChildLane()
    const signal = new AbortController().signal
    const release = await lane.acquire(signal)
    const order: string[] = []
    let releaseSecond!: () => void
    let releaseThird!: () => void
    const second = lane.acquire(signal).then(unlock => { order.push('second owner'); releaseSecond = unlock })
    const third = lane.acquire(signal).then(unlock => { order.push('third owner'); releaseThird = unlock })
    await flush()
    expect(order).toEqual([])
    release()
    await second
    expect(order).toEqual(['second owner'])
    releaseSecond()
    await third
    expect(order).toEqual(['second owner', 'third owner'])
    releaseThird()
    lane.close()
  })

  it('makes release idempotent without unlocking the next active child', async () => {
    const lane = new ChildLane()
    const signal = new AbortController().signal
    const first = await lane.acquire(signal)
    const next = lane.acquire(signal)
    first()
    const second = await next
    let admitted = false
    const third = lane.acquire(signal).then(release => { admitted = true; return release })
    first()
    await flush()
    expect(admitted).toBe(false)
    second()
    ;(await third)()
  })

  it('rejects an already aborted caller without taking a slot', async () => {
    const lane = new ChildLane()
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(lane.acquire(controller.signal)).rejects.toThrow('already cancelled')
    ;(await lane.acquire(new AbortController().signal))()
  })

  it('removes an aborted waiter while preserving the remaining FIFO', async () => {
    const lane = new ChildLane()
    const signal = new AbortController().signal
    const first = await lane.acquire(signal)
    const controller = new AbortController()
    const cancelled = lane.acquire(controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('cancel queued child')
    let admitted = false
    const next = lane.acquire(signal).then(release => { admitted = true; return release })
    controller.abort(new Error('cancel queued child'))
    await rejected
    await flush()
    expect(admitted).toBe(false)
    first()
    ;(await next)()
  })

  it('does not revoke an admitted permit when its admission signal aborts', async () => {
    const lane = new ChildLane()
    const controller = new AbortController()
    const release = await lane.acquire(controller.signal)
    controller.abort()
    let admitted = false
    const next = lane.acquire(new AbortController().signal).then(unlock => { admitted = true; return unlock })
    await flush()
    expect(admitted).toBe(false)
    release()
    ;(await next)()
  })

  it('close rejects queued and new admissions while the active owner may release', async () => {
    const lane = new ChildLane()
    const signal = new AbortController().signal
    const release = await lane.acquire(signal)
    const queued = lane.acquire(signal)
    const rejected = expect(queued).rejects.toThrow(/closed/i)
    lane.close()
    lane.close()
    await rejected
    await expect(lane.acquire(signal)).rejects.toThrow(/closed/i)
    expect(() => { release(); release() }).not.toThrow()
    await expect(lane.acquire(signal)).rejects.toThrow(/closed/i)
  })
})
