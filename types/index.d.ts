/**
 * A session holding or waiting on one slot. `label` tells two slots of one session apart (`T2#2`) and says what it is for.
 * `since` is when it queued, then when it was granted; `waitedMs` how long it queued before that.
 */
export type MachineLocksHolder = { session: string; name: string; label?: string; since?: number; waitedMs?: number }

/** One slot from its grant to its release, kept to size capacities on what the machine went through. */
export type MachineLocksHold = { resource: string; name: string; label?: string; releasedAt: number; heldMs: number; waitedMs: number }

/** What one slot of a scaled lock costs the machine; its capacity then follows what is left, up to `max`. */
export type MachineLocksScale = { max: number; memoryMb?: number; cores?: number }

/**
 * The Bash commands a lock watches, as regular expression sources: `needs` runs only for a session holding a slot of
 * it, `forbid` never runs, since it acts on every session's instance at once.
 */
export type MachineLocksGuard = { needs?: string[]; forbid?: string[] }

export type MachineLocksLock = { capacity: number; holders: MachineLocksHolder[]; queue: MachineLocksHolder[]; scale?: MachineLocksScale; guard?: MachineLocksGuard }

export type MachineLocksTable = Record<string, MachineLocksLock>

/** The slots freed on one resource, held or queued, and the sessions that were granted them and told so. */
export type MachineLocksRelease = { resource: string; released: MachineLocksHolder[]; granted: MachineLocksHolder[] }

/**
 * The machine-wide lock table, for other mods: every call reads the table as every session on the machine shares it.
 * A promoted session is told GRANTED directly; one that cannot be reached is dropped and the next one is tried.
 */
export type MachineLocks = {
  list: () => Promise<MachineLocksTable>
  /** Frees the slots (held or queued) of `session` on `resource`, only the one labelled `label` when given. */
  release: (resource: string, session: string, label?: string) => Promise<MachineLocksRelease[]>
  /** Frees every slot `session` holds or waits for, on every resource. */
  releaseSession: (session: string) => Promise<MachineLocksRelease[]>
}

declare module 'claude-code' {
  interface EngineInterface {
    machineLocks: MachineLocks
  }
}
