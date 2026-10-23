import type { MachineLocksHolder as Holder, MachineLocksLock as Lock, MachineLocksScale as LockScale, MachineLocksTable as Locks } from '../types'

/** The `$.store` key every session on the machine shares. */
export const LOCKS_KEY = 'locks'

type Slot = { session: string; label?: string }

const isSame = (a: Slot, b: Slot) => a.session === b.session && (a.label ?? '') === (b.label ?? '')
// A release without a label frees every slot of the session on that resource.
const isMatch = (h: Holder, slot: Slot) => h.session === slot.session && (slot.label === undefined || (h.label ?? '') === slot.label)

export function acquireIn(all: Locks, resource: string, holder: Holder): { next: Locks; outcome: 'granted' | 'queued' | 'unknown'; ahead: number } {
  const lock = all[resource]
  if (!lock) return { next: all, outcome: 'unknown', ahead: 0 }
  if (lock.holders.some(h => isSame(h, holder))) return { next: all, outcome: 'granted', ahead: 0 }
  if (lock.holders.length < lock.capacity) {
    const updated: Lock = { ...lock, holders: [...lock.holders, holder], queue: lock.queue.filter(q => !isSame(q, holder)) }
    return { next: { ...all, [resource]: updated }, outcome: 'granted', ahead: 0 }
  }
  const queued = lock.queue.findIndex(q => isSame(q, holder))
  if (queued >= 0) return { next: all, outcome: 'queued', ahead: queued }
  return { next: { ...all, [resource]: { ...lock, queue: [...lock.queue, holder] } }, outcome: 'queued', ahead: lock.queue.length }
}

/** Fills the free slots from the queue, in order; a promoted holder starts its hold now, not when it queued. */
function fill(lock: Lock, now: number): { lock: Lock; promoted: Holder[] } {
  const room = Math.max(0, lock.capacity - lock.holders.length)
  const promoted = lock.queue.slice(0, room).map(h => ({ ...h, since: now }))
  return { lock: { ...lock, holders: [...lock.holders, ...promoted], queue: lock.queue.slice(promoted.length) }, promoted }
}

export function releaseIn(all: Locks, resource: string, slot: Slot, now: number): { next: Locks; released: Holder[]; promoted: Holder[] } {
  const lock = all[resource]
  if (!lock) return { next: all, released: [], promoted: [] }
  const released = [...lock.holders, ...lock.queue].filter(h => isMatch(h, slot))
  const { lock: updated, promoted } = fill({ ...lock, holders: lock.holders.filter(h => !isMatch(h, slot)), queue: lock.queue.filter(q => !isMatch(q, slot)) }, now)
  return { next: { ...all, [resource]: updated }, released, promoted }
}

// A raised capacity grants the queue at once: a release only ever fills the slots it frees.
// `scale` left undefined keeps the lock's own, so a rescale never drops it; null turns scaling off.
export function defineIn(all: Locks, resource: string, capacity: number, now: number, scale?: LockScale | null): { next: Locks; promoted: Holder[] } {
  const kept = scale === undefined ? all[resource]?.scale : (scale ?? undefined)
  const base: Lock = { capacity, holders: all[resource]?.holders ?? [], queue: all[resource]?.queue ?? [], ...(kept ? { scale: kept } : {}) }
  const { lock, promoted } = fill(base, now)
  return { next: { ...all, [resource]: lock }, promoted }
}

/** A resource another session still holds or waits on is kept: removing it would free slots that session counts on. */
export function removeIn(all: Locks, resource: string, session: string): { next: Locks; heldBy: string[] } {
  const lock = all[resource]
  if (!lock) return { next: all, heldBy: [] }
  const heldBy = [...lock.holders, ...lock.queue].filter(h => h.session !== session).map(nameOf)
  if (heldBy.length > 0) return { next: all, heldBy }
  return { next: Object.fromEntries(Object.entries(all).filter(([r]) => r !== resource)), heldBy: [] }
}

export const nameOf = (h: Holder) => (h.label ? `${h.name} (${h.label})` : h.name)

export type Budget = { totalMb: number; freeMb: number; load: number; cores: number }

/** A slot granted this recently has not booted its device yet, so its cost is not in the free memory: it is reserved. */
export const WARMUP_MS = 3 * 60_000
/** The share of memory always left free: below it macOS compresses and swaps, and kills devices and servers at random. */
export const MEMORY_FLOOR = 0.2

/**
 * What a scaled lock holds plus what the machine still has room for, between 1 and its max. It rises on every whole
 * slot of room and falls only once it is more than half a slot short, inside the memory floor, so one sweep never
 * undoes the last. A lower capacity never evicts a holder: it only stops granting.
 */
export function scaledCapacityOf(lock: Lock, budget: Budget, now: number): number {
  const { scale } = lock
  if (!scale) return lock.capacity
  const warming = lock.holders.filter(h => h.since !== undefined && now - h.since < WARMUP_MS).length
  const rooms = [
    ...(scale.memoryMb ? [(budget.freeMb - budget.totalMb * MEMORY_FLOOR) / scale.memoryMb - warming] : []),
    ...(scale.cores ? [(budget.cores - budget.load) / scale.cores - warming] : []),
  ]
  if (rooms.length === 0) return scale.max
  const room = Math.min(...rooms)
  const higher = lock.holders.length + Math.floor(room)
  const lower = lock.holders.length + Math.floor(room + 0.5)
  const next = higher > lock.capacity ? higher : Math.min(lower, lock.capacity)
  return Math.min(scale.max, Math.max(1, next))
}

/** `sysctl -n vm.loadavg hw.ncpu hw.memsize` and `memory_pressure -Q`, read as what the machine has left. */
export function budgetOf(sysctl: string, pressure: string): Budget | null {
  const [loadLine = '', cpuLine = '', memLine = ''] = sysctl.trim().split('\n')
  const freeShare = pressure.match(/free percentage:\s*(\d+)%/)
  const totalMb = Number(memLine) / 1024 / 1024
  const load = Number(loadLine.replace(/[{}]/g, '').trim().split(/\s+/)[0])
  const cores = Number(cpuLine)
  if (!freeShare || ![totalMb, load, cores].every(Number.isFinite)) return null
  return { totalMb, freeMb: (totalMb * Number(freeShare[1])) / 100, load, cores }
}

export const LONG_HOLD_MS = 45 * 60_000

const spentOf = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`
}

/**
 * One line per slot this session has held past LONG_HOLD_MS, once per hold: a job that keeps printing (a native
 * build under load) never looks stuck on screen, so only the holder can tell whether it still needs the slot.
 */
export function longHeldOf(all: Locks, session: string, now: number, alerted: Record<string, number>): { key: string; line: string }[] {
  const found: { key: string; line: string }[] = []
  for (const [resource, lock] of Object.entries(all)) {
    for (const h of lock.holders) {
      if (h.session !== session || h.since === undefined || now - h.since < LONG_HOLD_MS) continue
      const key = `${resource}:${h.session}:${h.label ?? ''}:${h.since}`
      if (alerted[key]) continue
      found.push({ key, line: `- ${resource}${h.label ? ` (${h.label})` : ''}, held for ${spentOf(now - h.since)}${lock.queue.length ? `, ${lock.queue.length} waiting` : ''}` })
    }
  }
  return found
}

/** A row of `claude agents --json --all`. */
export type AgentRow = { sessionId?: string; name?: string; state?: string | null }

/** A failed background session never runs again on its own; a paused one comes back on a message, so it still holds. */
export const liveSessionsOf = (rows: readonly AgentRow[]) => new Set(rows.filter(r => r.sessionId && r.state !== 'failed').map(r => r.sessionId as string))

/** The holders of a lock someone waits on whose session is gone: nobody would ever release their slot. */
export function deadHoldersOf(all: Locks, live: ReadonlySet<string>): { resource: string; holder: Holder }[] {
  return Object.entries(all).flatMap(([resource, lock]) => (lock.queue.length === 0 ? [] : lock.holders.filter(h => !live.has(h.session)).map(holder => ({ resource, holder }))))
}
