/** Own background execution independently of any conversational tool or turn. @module */
import type { Checkpoint, OrchestrationRunId } from './runner.js'
import type { OrchestrationResult } from './types.js'

export type RunResult = OrchestrationResult & { runId: OrchestrationRunId }
export interface BackgroundSnapshot {
  runId: OrchestrationRunId
  ownerId: string
  status: 'running' | 'completed' | 'plan-only' | 'blocked' | 'failed' | 'cancelled'
  checkpoint?: Checkpoint
  result?: RunResult
  error?: string
}

interface OwnedRun {
  controller: AbortController
  snapshot?: BackgroundSnapshot
  done: Promise<void>
}

/** One active invocation per owner, retaining immutable snapshots after settlement. */
export class BackgroundRuns {
  private readonly owners = new Map<string, OwnedRun>()
  private readonly snapshots = new Map<string, Map<string, BackgroundSnapshot>>()
  private readonly settlements = new WeakMap<BackgroundSnapshot, Promise<void>>()
  private readonly pending = new Set<Promise<void>>()
  private closed = false
  private stopping?: Promise<void>

  dispatch(
    ownerId: string,
    launch: (context: { signal: AbortSignal; onCheckpoint: (checkpoint: Checkpoint) => void }) => Promise<RunResult>,
    onTerminal: (snapshot: BackgroundSnapshot) => Promise<void> | void,
  ): Promise<BackgroundSnapshot> {
    if (this.closed) return Promise.reject(new Error('Background runs are shut down'))
    if (this.owners.has(ownerId)) return Promise.reject(new Error('This owner already has an active run'))
    const controller = new AbortController()
    let accept!: (snapshot: BackgroundSnapshot) => void
    let reject!: (error: unknown) => void
    const receipt = new Promise<BackgroundSnapshot>((resolve, fail) => { accept = resolve; reject = fail })
    const owned: OwnedRun = { controller, done: Promise.resolve() }
    this.owners.set(ownerId, owned)
    const store = (): void => {
      if (owned.snapshot === undefined) return
      let records = this.snapshots.get(ownerId)
      if (records === undefined) this.snapshots.set(ownerId, records = new Map())
      records.set(owned.snapshot.runId, owned.snapshot)
    }
    const onCheckpoint = (checkpoint: Checkpoint): void => {
      if (owned.snapshot === undefined) {
        controller.signal.throwIfAborted()
        owned.snapshot = { ownerId, runId: checkpoint.runId, status: 'running', checkpoint: structuredClone(checkpoint) }
        store()
        this.settlements.set(owned.snapshot, owned.done)
        accept(structuredClone(owned.snapshot))
      } else {
        if (checkpoint.runId !== owned.snapshot.runId) throw new Error('Background checkpoint changed run identity')
        owned.snapshot.checkpoint = structuredClone(checkpoint)
        store()
      }
    }
    // Starting in a microtask reserves the owner before any caller-supplied code runs.
    owned.done = Promise.resolve().then(async () => {
      try {
        const result = await launch({ signal: controller.signal, onCheckpoint })
        if (owned.snapshot === undefined) throw new Error('Background launch settled without a committed checkpoint')
        if (result.runId !== owned.snapshot.runId) throw new Error('Background result changed run identity')
        owned.snapshot.result = structuredClone(result)
        owned.snapshot.status = controller.signal.aborted ? 'cancelled' : result.status
      } catch (error) {
        if (owned.snapshot === undefined) reject(error)
        else {
          owned.snapshot.status = controller.signal.aborted ? 'cancelled' : 'failed'
          owned.snapshot.error = error instanceof Error ? error.message : String(error)
        }
      } finally {
        store()
        if (this.owners.get(ownerId) === owned) this.owners.delete(ownerId)
      }
      if (owned.snapshot !== undefined) {
        // Notification failure must never change the durable run result or reject cleanup.
        try { await onTerminal(structuredClone(owned.snapshot)) } catch { /* owner can inspect status */ }
      }
    })
    this.pending.add(owned.done)
    void owned.done.then(() => this.pending.delete(owned.done))
    return receipt
  }

  active(ownerId: string): BackgroundSnapshot | undefined {
    const snapshot = this.owners.get(ownerId)?.snapshot
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  get(ownerId: string, runId: string): BackgroundSnapshot | undefined {
    const snapshot = this.snapshots.get(ownerId)?.get(runId)
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  /** Join this exact invocation, including cleanup and terminal notification. */
  async wait(ownerId: string, runId: string): Promise<BackgroundSnapshot> {
    const snapshot = this.snapshots.get(ownerId)?.get(runId)
    if (snapshot === undefined) throw new Error('Run not found for this owner')
    await this.settlements.get(snapshot)
    return structuredClone(snapshot)
  }

  cancel(ownerId: string, runId: string): BackgroundSnapshot {
    const snapshot = this.snapshots.get(ownerId)?.get(runId)
    if (snapshot === undefined) throw new Error('Run not found for this owner')
    const owned = this.owners.get(ownerId)
    if (owned?.snapshot === snapshot) {
      snapshot.status = 'cancelled'
      owned.controller.abort(new Error('Background run cancelled'))
    }
    return structuredClone(snapshot)
  }

  shutdown(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.closed = true
    const owned = [...this.owners.values()]
    for (const run of owned) {
      if (run.snapshot !== undefined) run.snapshot.status = 'cancelled'
      run.controller.abort(new Error('Background runs shut down'))
    }
    this.stopping = Promise.all([...this.pending]).then(() => undefined)
    return this.stopping
  }
}
