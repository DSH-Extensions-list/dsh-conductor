import { ChildLane } from './child-lane.js'

/** Shared child lifetime capacity; BharatCode waiters reserve only their provider lane. */
export class WorkerAdmission {
  private readonly shared: ChildLane
  private readonly bharatcode = new ChildLane()

  constructor(capacity: () => number) { this.shared = new ChildLane(capacity) }

  async acquire(provider: string | undefined, signal: AbortSignal): Promise<() => void> {
    const providerRelease = provider === 'bharatcode' ? await this.bharatcode.acquire(signal) : () => {}
    try {
      const sharedRelease = await this.shared.acquire(signal)
      if (signal.aborted) { sharedRelease(); throw signal.reason ?? new Error('Child admission cancelled') }
      let released = false
      return () => {
        if (released) return
        released = true
        sharedRelease(); providerRelease()
      }
    } catch (error) { providerRelease(); throw error }
  }

  close(): void { this.shared.close(); this.bharatcode.close() }
}
