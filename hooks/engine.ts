import type { MachineLocks, MachineLocksGuard as Guard, MachineLocksHold as Hold, MachineLocksHolder as Holder, MachineLocksRelease as Release, MachineLocksTable as Locks } from '../types'
import {
  acquireIn,
  admitIn,
  alivePidsOf,
  budgetOf,
  budgetQueueOf,
  deadHoldersOf,
  defineIn,
  historyStatsOf,
  historyWith,
  holderPidsOf,
  linuxBudgetOf,
  liveSessionsOf,
  LOCKS_KEY,
  longHeldOf,
  nameOf,
  releaseIn,
  removeIn,
  roomOf,
  untoldOf,
  withHolder,
} from './table'
import type { AgentRow, Budget } from './table'

export type Run = { exitCode: number; stdout: string }

/**
 * What the lock engine needs of its host: Claude Code's `$` in the mod, or a Node process in the Codex MCP server.
 * The table and its history are files every host on the machine shares; `get` and `set` keep what only this host
 * reads (when it last swept, which long holds it already flagged).
 */
export type Ops = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  readShared: (name: string) => Promise<unknown>
  writeShared: (name: string, value: unknown) => Promise<void>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  id: () => Promise<string>
  /** What another session's list shows for this one's slots. */
  name: () => Promise<string>
  run: (argv: string[], timeoutMs: number) => Promise<Run>
  log: (text: string) => void
  /** How the answers name the lock tool. */
  tool: string
  /** This session's `codex` process: set in Codex, whose holders are known by it. */
  pid?: number
  /** Messages another session: absent in Codex, where a Claude session granted a slot is marked untold instead. */
  send?: (sessionId: string, text: string) => Promise<boolean>
  /** Reaches one subagent of this session, which a message to the session itself would not. */
  sendAgent?: (agentId: string, text: string) => Promise<boolean>
  submit?: (text: string) => Promise<unknown>
  /** `claude agents --json --all`, null when it cannot be read: what tells a Claude holder alive. */
  agents?: () => Promise<AgentRow[] | null>
  /** Set where nothing can wake a waiting session: `acquire` then waits for the slot that long before answering. */
  waitMs?: number
  /** Tells the caller of a waiting `acquire` it is still in line. */
  progress?: (text: string) => void
  /** Set inside a tool call, where a prompt.submit would wait on the very turn the hook holds: grants to this session land here and go out in the tool's answer. */
  ownGrants?: string[]
  /** The subagent loop the tool call runs in, absent on the main loop: workers of one session are told apart by it. */
  agent?: string
}

/** Where every host on the machine keeps the table, unless MACHINE_LOCKS_DIR says otherwise. */
export const sharedDirOf = (env: Record<string, string | undefined>) => env.MACHINE_LOCKS_DIR || `${env.HOME ?? '/tmp'}/.local/state/machine-locks`

/** A `mkdir` either creates the folder or fails, atomically: the claim every session of the machine takes before changing the table. */
export const MUTEX_DIR = '/tmp/claude-machine-locks.mutex'
/** A change holds the mutex for milliseconds: one older than this was left by a session killed mid-change. */
const MUTEX_STALE_MS = 10_000
const MUTEX_WAIT_MS = 5_000

const HISTORY_KEY = 'history'
const SWEEP_KEY = 'sweepAt'
/** How often a waiter on the machine's budget is checked again: memory frees as a device shuts down, not at its release. */
export const ADMIT_MS = 30_000
const ADMIT_KEY = 'admitAt'
const ALERTED_KEY = 'alerted'
const SWEEP_MS = 3 * 60_000
/** How often a waiting `acquire` reads the table again. */
export const WAIT_POLL_MS = 2_000

const runOrNull = (o: Ops, argv: string[]) => o.run(argv, 2000).catch(() => null)

async function isMutexStale(o: Ops): Promise<boolean> {
  // BSD stat first, GNU stat when it fails.
  let stat = await runOrNull(o, ['stat', '-f', '%m', MUTEX_DIR])
  if (!stat || stat.exitCode !== 0 || !/^\d+$/.test(stat.stdout.trim())) stat = await runOrNull(o, ['stat', '-c', '%Y', MUTEX_DIR])
  if (!stat || stat.exitCode !== 0) return false
  return (await o.now()) - Number(stat.stdout.trim()) * 1000 > MUTEX_STALE_MS
}

/** Runs `body` holding the machine's mutex; a mutex that cannot be taken never blocks the lock, it is only logged. */
async function withMutex<T>(o: Ops, body: () => Promise<T>): Promise<T> {
  const start = await o.now()
  let isHeld = false
  for (;;) {
    const made = await runOrNull(o, ['mkdir', MUTEX_DIR])
    if (!made) break
    if (made.exitCode === 0) {
      isHeld = true
      break
    }
    if ((await o.now()) - start > MUTEX_WAIT_MS) break
    if (await isMutexStale(o)) await runOrNull(o, ['rmdir', MUTEX_DIR])
    else await o.sleep(20)
  }
  if (!isHeld) o.log(`machine-locks: ${MUTEX_DIR} not taken, the table changes without it`)
  try {
    return await body()
  } finally {
    if (isHeld) await runOrNull(o, ['rmdir', MUTEX_DIR])
  }
}

/** The table as every session on the machine shares it; before its file exists, the one Claude Code's store held. */
export async function loadLocks(o: Ops): Promise<Locks> {
  return ((await o.readShared('locks')) ?? (await o.get(LOCKS_KEY)) ?? {}) as Locks
}

// A file has no compare-and-set across processes: without the mutex, two sessions that acquire at once both read
// the same table and the last write drops the other's slot, which then believes it holds one.
async function changeLocks<T extends { next: Locks }>(o: Ops, change: (all: Locks) => T): Promise<T> {
  return withMutex(o, async () => {
    const result = change(await loadLocks(o))
    await o.writeShared('locks', result.next)
    return result
  })
}

/** `claude agents --json --all`, null when it cannot be read. */
export async function claudeAgentsVia(run: Ops['run']): Promise<AgentRow[] | null> {
  const listed = await run(['claude', 'agents', '--json', '--all'], 15_000).catch(() => null)
  if (!listed || listed.exitCode !== 0) return null
  try {
    return JSON.parse(listed.stdout) as AgentRow[]
  } catch {
    return null
  }
}

async function alivePids(o: Ops, pids: readonly number[]): Promise<Set<number>> {
  if (pids.length === 0) return new Set()
  const ps = await runOrNull(o, ['ps', '-o', 'pid=', '-p', pids.join(',')])
  // ps exits 1 when none of them runs, and prints nothing.
  return ps ? alivePidsOf(ps.stdout) : new Set(pids)
}

const grantText = (o: Ops, resource: string, h: Holder) =>
  `GRANTED ${resource}${h.label ? ` ${h.label}` : ''}: the slot you queued for is yours now. Release it through ${o.tool} as soon as you are done with it.`

async function markUntold(o: Ops, resource: string, h: Holder): Promise<boolean> {
  await changeLocks(o, all => ({ next: withHolder(all, resource, h, { untold: true }) }))
  return true
}

/**
 * Tells the holder it now has the slot; false when it cannot be reached. A Codex holder reads its grant from the
 * table, and a Claude one granted from Codex is marked for its own sweep to tell. A slot taken from a subagent loop
 * belongs to that loop: only its own session can message it, and another session's grant reaches the session,
 * whose main loop passes it on by its label.
 */
async function notify(o: Ops, resource: string, h: Holder): Promise<boolean> {
  if (h.pid !== undefined) return true
  const text = grantText(o, resource, h)
  try {
    if (h.session !== (await o.id())) return o.send ? await o.send(h.session, text) : await markUntold(o, resource, h)
    if ((h.agent ?? '') === (o.agent ?? '')) {
      if (o.ownGrants) o.ownGrants.push(text)
      else await o.submit?.(`[machine-locks] ${text}`)
      return true
    }
    if (h.agent && o.sendAgent) return await o.sendAgent(h.agent, text)
    await o.submit?.(`[machine-locks] ${text}`)
    return true
  } catch {
    return false
  }
}

/** Tells each promoted session; one that cannot be reached is gone, so its slot goes on to the next in line. */
async function grant(o: Ops, resource: string, promoted: Holder[]): Promise<Holder[]> {
  const granted: Holder[] = []
  const pending = [...promoted]
  while (pending.length > 0) {
    const h = pending.shift() as Holder
    if (await notify(o, resource, h)) {
      granted.push(h)
      continue
    }
    o.log(`machine-locks: GRANTED ${resource} did not reach ${nameOf(h)}, its slot goes to the next in line`)
    const now = await o.now()
    pending.push(...(await changeLocks(o, all => releaseIn(all, resource, { session: h.session, label: h.label ?? '' }, now))).promoted)
  }
  return granted
}

export const loadHistory = async (o: Ops) => ((await o.readShared(HISTORY_KEY)) ?? (await o.get(HISTORY_KEY)) ?? []) as Hold[]

async function record(o: Ops, holds: Hold[]): Promise<void> {
  if (holds.length === 0) return
  await withMutex(o, async () => o.writeShared(HISTORY_KEY, historyWith(await loadHistory(o), holds))).catch(error => o.log(`machine-locks history: ${String(error)}`))
}

export async function release(o: Ops, resource: string, slot: { session: string; label?: string }): Promise<Release[]> {
  const now = await o.now()
  const { released, promoted, holds } = await changeLocks(o, all => releaseIn(all, resource, slot, now))
  await record(o, holds)
  if (released.length === 0) return []
  return [{ resource, released, granted: [...(await grant(o, resource, promoted)), ...(await admit(o))] }]
}

/** Grants every budgeted waiter the machine has room for now, across resources, and tells each. */
async function admit(o: Ops, self?: Holder): Promise<Holder[]> {
  if (budgetQueueOf(await loadLocks(o)).length === 0) return []
  const budget = await machineBudget(o)
  const now = await o.now()
  const { promoted } = await changeLocks(o, all => admitIn(all, budget ? roomOf(all, budget, now) : null, now))
  const granted: Holder[] = []
  let isLost = false
  for (const { resource, holder } of promoted) {
    if (self && holder.session === self.session && (holder.label ?? '') === (self.label ?? '')) continue
    const told = await grant(o, resource, [holder])
    granted.push(...told)
    if (told.length === 0) isLost = true
  }
  // A grant that reached nobody freed its slot without promoting anyone: the machine's room goes to the next in line.
  return isLost ? [...granted, ...(await admit(o, self))] : granted
}

export async function releaseSession(o: Ops, session: string): Promise<Release[]> {
  const all = await loadLocks(o)
  const held = Object.entries(all).filter(([, l]) => [...l.holders, ...l.queue].some(h => h.session === session))
  // One after the other: each release rewrites the whole table.
  const done: Release[] = []
  for (const [resource] of held) done.push(...(await release(o, resource, { session })))
  return done
}

export const apiOf = (o: Ops): MachineLocks => ({
  list: () => loadLocks(o),
  release: (resource, session, label) => release(o, resource, label === undefined ? { session } : { session, label }),
  releaseSession: session => releaseSession(o, session),
})

export async function machineBudget(o: Ops): Promise<Budget | null> {
  const sys = await runOrNull(o, ['sysctl', '-n', 'vm.loadavg', 'hw.ncpu', 'hw.memsize'])
  const pressure = await runOrNull(o, ['memory_pressure', '-Q'])
  if (sys?.exitCode === 0 && pressure?.exitCode === 0) return budgetOf(sys.stdout, pressure.stdout)
  const [loadavg, nproc, meminfo] = await Promise.all([runOrNull(o, ['cat', '/proc/loadavg']), runOrNull(o, ['nproc']), runOrNull(o, ['cat', '/proc/meminfo'])])
  if (loadavg?.exitCode !== 0 || nproc?.exitCode !== 0 || meminfo?.exitCode !== 0) return null
  return linuxBudgetOf(loadavg.stdout, nproc.stdout, meminfo.stdout)
}

/** A holder whose session is gone never releases: when someone waits on its lock, its slot goes to the next in line. */
async function freeDead(o: Ops): Promise<void> {
  const all = await loadLocks(o)
  if (!Object.values(all).some(l => l.queue.length > 0)) return
  const rows = o.agents ? await o.agents() : null
  const alive = await alivePids(o, holderPidsOf(all))
  for (const { resource, holder } of deadHoldersOf(all, rows ? liveSessionsOf(rows) : null, alive)) {
    o.log(`machine-locks: ${nameOf(holder)} is gone, its ${resource} slot is released`)
    await release(o, resource, { session: holder.session, label: holder.label ?? '' })
  }
}

/** Sends the GRANTED that a Codex session could not: it marked the slot untold for this session to find. */
async function tellUntold(o: Ops): Promise<void> {
  const session = await o.id()
  for (const { resource, holder } of untoldOf(await loadLocks(o), session)) {
    await changeLocks(o, all => ({ next: withHolder(all, resource, holder, { untold: undefined }) }))
    const { untold: _, ...told } = holder
    if (await notify(o, resource, told)) continue
    await release(o, resource, { session, label: holder.label ?? '' })
  }
}

async function alertLongHolds(o: Ops, now: number): Promise<void> {
  if (!o.submit) return
  const session = await o.id()
  const all = await loadLocks(o)
  const alerted = ((await o.get(ALERTED_KEY)) as Record<string, number> | undefined) ?? {}
  const found = longHeldOf(all, session, now, alerted)
  if (found.length === 0) return
  // Keys of holds that ended are dropped, so the record never outgrows the table.
  const current = new Set(Object.entries(all).flatMap(([r, l]) => l.holders.map(h => `${r}:${h.session}:${h.label ?? ''}:${h.since}`)))
  const kept = Object.fromEntries(Object.entries(alerted).filter(([k]) => current.has(k)))
  await o.set(ALERTED_KEY, { ...kept, ...Object.fromEntries(found.map(f => [f.key, now])) })
  void o.submit(
    `[machine-locks] This session has held a shared machine slot for long:\n${found.map(f => f.line).join('\n')}\nRelease each one you no longer use through ${o.tool}; when a job still runs under it, check it is not stuck, and stop it past its budget.`,
  )
}

/** True for the one session that gets there first in this period: each machine-wide check runs once, not once per session. */
async function isDue(o: Ops, key: string, periodMs: number, now: number): Promise<boolean> {
  if (now - Number((await o.get(key)) ?? 0) < periodMs - periodMs / 10) return false
  await o.set(key, now)
  return true
}

export async function sweep(o: Ops): Promise<void> {
  const now = await o.now()
  await tellUntold(o)
  await alertLongHolds(o, now)
  if (await isDue(o, ADMIT_KEY, ADMIT_MS, now)) await admit(o)
  if (await isDue(o, SWEEP_KEY, SWEEP_MS, now)) await freeDead(o)
}

export type Input = { action?: string; resource?: string; capacity?: number; memoryGb?: number; cores?: number; label?: string; holder?: string; guard?: Guard }

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { enum: ['list', 'history', 'define', 'acquire', 'release', 'remove'] },
    resource: { type: 'string' },
    capacity: { type: 'number' },
    memoryGb: { type: 'number', description: 'define: the memory one slot uses, device and dev server included' },
    cores: { type: 'number', description: 'define: the cores one slot uses' },
    label: { type: 'string', description: 'acquire, release: what the slot is for, such as a task id' },
    holder: { type: 'string', description: 'release: the session id or name of a session that is gone, to free its slot' },
    guard: {
      type: 'object',
      description: 'define: regular expressions matched against Bash commands. ios-simulator and android-emulator watch their device commands without one',
      properties: {
        needs: { type: 'array', items: { type: 'string' }, description: 'commands that run only while this session holds a slot' },
        forbid: { type: 'array', items: { type: 'string' }, description: 'commands that never run: they act on every session at once' },
      },
    },
  },
  required: ['action'],
} as const

async function define(o: Ops, resource: string, input: Input): Promise<string> {
  const capacity = Math.max(1, Math.floor(input.capacity ?? 1))
  const now = await o.now()
  const isBudgeted = (input.memoryGb ?? 0) > 0 || (input.cores ?? 0) > 0
  const scale = isBudgeted ? { max: capacity, ...(input.memoryGb ? { memoryMb: Math.round(input.memoryGb * 1024) } : {}), ...(input.cores ? { cores: input.cores } : {}) } : null
  const { promoted } = await changeLocks(o, all => defineIn(all, resource, capacity, now, scale, input.guard))
  const granted = [...(await grant(o, resource, promoted)), ...(await admit(o))]
  const cost = [input.memoryGb ? `${input.memoryGb} GB` : '', input.cores ? `${input.cores} cores` : ''].filter(Boolean).join(' and ')
  const sizing = isBudgeted ? `, up to ${capacity} slots of ${cost} each, granted from the machine's memory and cores shared with every budgeted resource` : `, capacity ${capacity}`
  return `${resource} defined${sizing}${granted.length ? `, granted to ${granted.map(nameOf).join(', ')}` : ''}`
}

const isSlot = (h: Holder, slot: Holder) => h.session === slot.session && (h.label ?? '') === (slot.label ?? '')

/** Where `holder` stands in its line: a budgeted lock's line runs across every budgeted resource. */
function aheadOf(all: Locks, resource: string, holder: Holder): number {
  const lock = all[resource]
  if (!lock) return -1
  return lock.scale ? budgetQueueOf(all).findIndex(w => isSlot(w.holder, holder)) : lock.queue.findIndex(q => isSlot(q, holder))
}

const grantedText = (resource: string) => `${resource} granted: it is yours until you release it`

async function acquire(o: Ops, resource: string, label: string): Promise<string> {
  const holder: Holder = { session: await o.id(), name: await o.name(), ...(label ? { label } : {}), ...(o.agent ? { agent: o.agent } : {}), ...(o.pid !== undefined ? { pid: o.pid } : {}), since: await o.now() }
  const queued = await changeLocks(o, all => acquireIn(all, resource, holder))
  let { outcome, ahead } = queued
  if (outcome === 'queued' && queued.next[resource]?.scale) {
    await admit(o, holder)
    const all = await loadLocks(o)
    if (all[resource]?.holders.some(h => isSlot(h, holder))) outcome = 'granted'
    else ahead = aheadOf(all, resource, holder)
  }
  if (outcome === 'unknown') return `${resource} is not defined: "list" shows the resources, "define" adds one`
  if (outcome === 'granted') return grantedText(resource)
  if (o.waitMs !== undefined) return waitForGrant(o, resource, holder)
  return `${resource} queued, ${ahead} ahead: do not use it yet, end your turn on "Waiting on ${resource}${label ? ` for ${label}` : ''}"; a GRANTED ${resource} message wakes you`
}

/**
 * Holds the call until the slot is granted, for hosts that cannot be woken by a message. Past `waitMs` it answers
 * still queued and keeps the place: the same acquire, called again, goes on waiting from there.
 */
async function waitForGrant(o: Ops, resource: string, holder: Holder): Promise<string> {
  const start = await o.now()
  for (;;) {
    const all = await loadLocks(o)
    const lock = all[resource]
    if (!lock) return `${resource} was removed while this session waited for it`
    if (lock.holders.some(h => isSlot(h, holder))) return grantedText(resource)
    if (!lock.queue.some(q => isSlot(q, holder))) return `${resource}: this session's place in line was released; call acquire again to queue`
    const now = await o.now()
    const ahead = aheadOf(all, resource, holder)
    const minutes = Math.floor((now - start) / 60_000)
    if (now - start >= (o.waitMs ?? 0)) {
      return `${resource} still queued, ${ahead} ahead, after ${minutes} min: your place is kept. Do not use ${resource} yet; call acquire again with the same resource and label to go on waiting.`
    }
    o.progress?.(`${resource}: queued, ${ahead} ahead, ${minutes} min so far`)
    await o.sleep(WAIT_POLL_MS)
    if (lock.scale && (await isDue(o, ADMIT_KEY, ADMIT_MS, await o.now()))) await admit(o, holder)
    if (await isDue(o, SWEEP_KEY, ADMIT_MS, await o.now())) await freeDead(o)
  }
}

/** Another session's slot is freed only once that session is gone: a live one is asked to release it itself. */
async function releaseFor(o: Ops, resource: string, input: Input): Promise<string> {
  const lock = (await loadLocks(o))[resource]
  if (!lock) return `${resource} is not defined`
  const own = await o.id()
  const found = input.holder ? [...lock.holders, ...lock.queue].find(h => h.session === input.holder || h.name === input.holder) : undefined
  const target = input.holder ? found?.session : own
  if (!target) return `${input.holder} holds no slot of ${resource}`
  if (target !== own) {
    const isRunning =
      found?.pid !== undefined
        ? (await alivePids(o, [found.pid])).has(found.pid)
        : await (async () => {
            const rows = o.agents ? await o.agents() : null
            return rows === null || liveSessionsOf(rows).has(target)
          })()
    if (isRunning) return `${input.holder} is still running: ask it to release ${resource}; nothing released`
  }
  const done = await release(o, resource, input.label ? { session: target, label: input.label } : { session: target })
  if (done.length === 0) return `${resource}: no slot of this session to release`
  const handed = done.flatMap(d => d.granted.map(nameOf))
  return `${resource} released${handed.length ? `, granted to ${handed.join(', ')}` : ''}`
}

export async function respond(o: Ops, input: Input): Promise<string> {
  const { action = '', resource = '', label = '' } = input
  if (action === 'list') return JSON.stringify(await loadLocks(o), null, 1)
  if (action === 'history') return JSON.stringify(historyStatsOf(await loadHistory(o)), null, 1)
  if (resource === '') return 'resource is required'
  if (action === 'define') return define(o, resource, input)
  if (action === 'acquire') return acquire(o, resource, label)
  if (action === 'release') return releaseFor(o, resource, input)
  if (action === 'remove') {
    const session = await o.id()
    const { heldBy } = await changeLocks(o, all => removeIn(all, resource, session))
    return heldBy.length ? `${resource} kept: another session still holds or waits on it (${heldBy.join(', ')})` : `${resource} removed`
  }
  return `unknown action ${action}`
}
