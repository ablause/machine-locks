import type { MachineLocksGuard as Guard, MachineLocksHold as Hold, MachineLocksHolder as Holder, MachineLocksLock as Lock, MachineLocksScale as LockScale, MachineLocksTable as Locks } from '../types'

/** The `$.store` key every session on the machine shares. */
export const LOCKS_KEY = 'locks'

type Slot = { session: string; label?: string }

const isSame = (a: Slot, b: Slot) => a.session === b.session && (a.label ?? '') === (b.label ?? '')
// A release without a label frees every slot of the session on that resource.
const isMatch = (h: Holder, slot: Slot) => h.session === slot.session && (slot.label === undefined || (h.label ?? '') === slot.label)

// A budgeted lock only queues here: admitIn grants it against the whole machine, in the order every session asked.
export function acquireIn(all: Locks, resource: string, holder: Holder): { next: Locks; outcome: 'granted' | 'queued' | 'unknown'; ahead: number } {
  const lock = all[resource]
  if (!lock) return { next: all, outcome: 'unknown', ahead: 0 }
  if (lock.holders.some(h => isSame(h, holder))) return { next: all, outcome: 'granted', ahead: 0 }
  if (!lock.scale && lock.holders.length < lock.capacity) {
    const updated: Lock = { ...lock, holders: [...lock.holders, holder], queue: lock.queue.filter(q => !isSame(q, holder)) }
    return { next: { ...all, [resource]: updated }, outcome: 'granted', ahead: 0 }
  }
  const queued = lock.queue.findIndex(q => isSame(q, holder))
  if (queued >= 0) return { next: all, outcome: 'queued', ahead: queued }
  return { next: { ...all, [resource]: { ...lock, queue: [...lock.queue, holder] } }, outcome: 'queued', ahead: lock.queue.length }
}

/** Fills the free slots from the queue, in order; a promoted holder starts its hold now, not when it queued. A budgeted lock is left to admitIn. */
function fill(lock: Lock, now: number): { lock: Lock; promoted: Holder[] } {
  if (lock.scale) return { lock, promoted: [] }
  const room = Math.max(0, lock.capacity - lock.holders.length)
  const promoted = lock.queue.slice(0, room).map(h => ({ ...h, since: now, waitedMs: h.since === undefined ? 0 : now - h.since }))
  return { lock: { ...lock, holders: [...lock.holders, ...promoted], queue: lock.queue.slice(promoted.length) }, promoted }
}

export function releaseIn(all: Locks, resource: string, slot: Slot, now: number): { next: Locks; released: Holder[]; promoted: Holder[]; holds: Hold[] } {
  const lock = all[resource]
  if (!lock) return { next: all, released: [], promoted: [], holds: [] }
  const released = [...lock.holders, ...lock.queue].filter(h => isMatch(h, slot))
  const holds = lock.holders.filter(h => isMatch(h, slot)).map(h => holdOf(resource, h, now))
  const { lock: updated, promoted } = fill({ ...lock, holders: lock.holders.filter(h => !isMatch(h, slot)), queue: lock.queue.filter(q => !isMatch(q, slot)) }, now)
  return { next: { ...all, [resource]: updated }, released, promoted, holds }
}

const holdOf = (resource: string, h: Holder, now: number): Hold => ({
  resource,
  name: h.name,
  ...(h.label ? { label: h.label } : {}),
  releasedAt: now,
  heldMs: h.since === undefined ? 0 : now - h.since,
  waitedMs: h.waitedMs ?? 0,
})

/** The holds kept: enough weeks of work to size a capacity on, far under what `$.store` takes. */
export const HISTORY_SIZE = 500

export const historyWith = (history: readonly Hold[], holds: readonly Hold[]): Hold[] => [...history, ...holds].slice(-HISTORY_SIZE)

const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
const minutesOf = (ms: number) => Math.round(ms / 6_000) / 10

/** Per resource: how many holds, how often one queued, and the median and 90th percentile wait and hold, in minutes. */
export function historyStatsOf(history: readonly Hold[]) {
  const byResource = new Map<string, Hold[]>()
  for (const h of history) byResource.set(h.resource, [...(byResource.get(h.resource) ?? []), h])
  return Object.fromEntries(
    [...byResource].map(([resource, holds]) => {
      const waits = holds.map(h => h.waitedMs).sort((x, y) => x - y)
      const helds = holds.map(h => h.heldMs).sort((x, y) => x - y)
      return [
        resource,
        {
          holds: holds.length,
          queued: holds.filter(h => h.waitedMs > 0).length,
          waitMinutes: { p50: minutesOf(percentile(waits, 0.5)), p90: minutesOf(percentile(waits, 0.9)) },
          holdMinutes: { p50: minutesOf(percentile(helds, 0.5)), p90: minutesOf(percentile(helds, 0.9)) },
          since: holds[0]?.releasedAt,
        },
      ]
    }),
  )
}

// A raised capacity grants the queue at once: a release only ever fills the slots it frees.
// `scale` and `guard` left undefined keep the lock's own, so a rescale never drops them; null turns them off.
export function defineIn(all: Locks, resource: string, capacity: number, now: number, scale?: LockScale | null, guard?: Guard | null): { next: Locks; promoted: Holder[] } {
  const kept = scale === undefined ? all[resource]?.scale : (scale ?? undefined)
  const keptGuard = guard === undefined ? all[resource]?.guard : (guard ?? undefined)
  const base: Lock = { capacity, holders: all[resource]?.holders ?? [], queue: all[resource]?.queue ?? [], ...(kept ? { scale: kept } : {}), ...(keptGuard ? { guard: keptGuard } : {}) }
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

/** What the machine can still give budgeted slots: memory above the floor and idle cores. */
export type Room = { memoryMb: number; cores: number }

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0)

/**
 * The machine's room less every budgeted slot, whatever its resource, granted too recently for its device to be in
 * the measure yet: an iOS simulator still booting counts against the Android emulator asked for next.
 */
export function roomOf(all: Locks, budget: Budget, now: number): Room {
  const warming = Object.values(all).flatMap(l => (l.scale ? l.holders.filter(h => h.since !== undefined && now - h.since < WARMUP_MS).map(() => l.scale as LockScale) : []))
  return {
    memoryMb: budget.freeMb - budget.totalMb * MEMORY_FLOOR - sum(warming.map(s => s.memoryMb ?? 0)),
    cores: budget.cores - budget.load - sum(warming.map(s => s.cores ?? 0)),
  }
}

const fits = (scale: LockScale, room: Room) => (scale.memoryMb ?? 0) <= room.memoryMb && (scale.cores ?? 0) <= room.cores

/** Every session waiting on a budgeted lock, whatever its resource, in the order it asked. */
export const budgetQueueOf = (all: Locks): { resource: string; holder: Holder }[] =>
  Object.entries(all)
    .flatMap(([resource, lock]) => (lock.scale ? lock.queue.map(holder => ({ resource, holder })) : []))
    .sort((x, y) => (x.holder.since ?? 0) - (y.holder.since ?? 0))

/**
 * Grants the budgeted waiters in the order they asked, across resources, while the machine's room covers each one.
 * The first that does not fit stops the line, so a costly slot is never passed forever by cheaper ones; one whose
 * lock is at its max waits on that lock, not on the machine, and is passed. Without a measure, only the max counts.
 */
export function admitIn(all: Locks, room: Room | null, now: number): { next: Locks; promoted: { resource: string; holder: Holder }[] } {
  let next = all
  let left = room
  const promoted: { resource: string; holder: Holder }[] = []
  for (const { resource, holder } of budgetQueueOf(all)) {
    const lock = next[resource] as Lock
    const scale = lock.scale as LockScale
    if (lock.holders.length >= scale.max) continue
    if (left && !fits(scale, left)) break
    if (left) left = { memoryMb: left.memoryMb - (scale.memoryMb ?? 0), cores: left.cores - (scale.cores ?? 0) }
    const granted = { ...holder, since: now, waitedMs: holder.since === undefined ? 0 : now - holder.since }
    next = { ...next, [resource]: { ...lock, capacity: scale.max, holders: [...lock.holders, granted], queue: lock.queue.filter(q => !isSame(q, holder)) } }
    promoted.push({ resource, holder: granted })
  }
  return { next, promoted }
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

/** `/proc/loadavg`, `nproc` and `/proc/meminfo` on Linux, read as what the machine has left. */
export function linuxBudgetOf(loadavg: string, nproc: string, meminfo: string): Budget | null {
  const kbOf = (field: string) => Number(meminfo.match(new RegExp(`^${field}:\\s*(\\d+)\\s*kB`, 'm'))?.[1] ?? NaN)
  const totalMb = kbOf('MemTotal') / 1024
  const freeMb = kbOf('MemAvailable') / 1024
  const load = Number(loadavg.trim().split(/\s+/)[0])
  const cores = Number(nproc.trim())
  if (![totalMb, freeMb, load, cores].every(Number.isFinite) || cores === 0 || loadavg.trim() === '') return null
  return { totalMb, freeMb, load, cores }
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

const DEVICE_SCRIPT = String.raw`(?:scripts/device|\$D|\bdevice)\s+up\s+`

/** What `ios-simulator` and `android-emulator` watch when defined without a guard of their own: the simctl and emulator CLIs, and agent-device's `device up`. */
export const KNOWN_GUARDS: Record<string, Guard> = {
  'ios-simulator': {
    needs: [`${DEVICE_SCRIPT}ios\\b`, String.raw`\bsimctl\s+(?:boot|create|clone)\b`],
    forbid: [String.raw`\bsimctl\s+(?:shutdown|erase|delete)\s+all\b`, String.raw`\bsimctl\s+(?!list\b)\S+\b.*\bbooted\b`, String.raw`\bkillall\b.*\bSimulator\b`],
  },
  'android-emulator': {
    needs: [`${DEVICE_SCRIPT}android\\b`, String.raw`\bemulator\s+(?:-avd\b|@)`],
    forbid: [String.raw`\badb\s+kill-server\b`, String.raw`\b(?:killall|pkill)\b.*\b(?:emulator|qemu)`],
  },
}

const matchOf = (sources: readonly string[] | undefined, command: string): string | null => {
  for (const source of sources ?? []) {
    try {
      const found = new RegExp(source).exec(command)
      if (found) return found[0]
    } catch {
      // A pattern that does not compile guards nothing: a typo in one define never blocks the shell.
    }
  }
  return null
}

/**
 * Why `command` may not run in `session`, or null: a forbidden command first, then a guarded one without a held slot.
 * From a subagent loop, `lineage` names that loop and the loops above it: a slot another worker of the same session
 * took is not this one's, while one its own worker or the main loop took is.
 */
export function guardVerdictOf(all: Locks, command: string, session: string, tool: string, lineage?: readonly string[]): string | null {
  const isOwn = (h: Holder) => h.session === session && (lineage === undefined || h.agent === undefined || lineage.includes(h.agent))
  for (const [resource, lock] of Object.entries(all)) {
    const guard = lock.guard ?? KNOWN_GUARDS[resource]
    const forbidden = matchOf(guard?.forbid, command)
    if (forbidden) return `machine-locks: "${forbidden}" acts on every session's ${resource} at once. Target your own instance by its id instead.`
    const needed = matchOf(guard?.needs, command)
    if (needed && !lock.holders.some(isOwn)) {
      const waiting = lock.queue.some(isOwn)
      return waiting
        ? `machine-locks: "${needed}" needs a ${resource} slot and this session is still queued for one. End the turn on "Waiting on ${resource}": a GRANTED message wakes you.`
        : `machine-locks: "${needed}" needs a ${resource} slot. Take one first through ${tool} (action acquire, resource ${resource}, your task as label), then run it again.`
    }
  }
  return null
}
