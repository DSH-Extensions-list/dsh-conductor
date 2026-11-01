/** A process-local child admission slot shared across all run owners. @module */
interface Waiter {
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  onAbort: () => void
}

/** FIFO admission. A holder releases only after its child has fully disposed. */
export class ChildLane {
  private held = false
  private closed = false
  private readonly queue: Waiter[] = []

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error('Child lane is closed'))
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Child admission cancelled'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal, resolve, reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter)
          if (index === -1) return
          this.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort)
          reject(signal.reason ?? new Error('Child admission cancelled'))
        },
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.admit()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.queue.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(new Error('Child lane is closed'))
    }
  }

  private admit(): void {
    if (this.held || this.closed) return
    const waiter = this.queue.shift()
    if (waiter === undefined) return
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.held = true
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      this.held = false
      this.admit()
    })
  }
}
