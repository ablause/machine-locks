import type { EngineInterface, Register } from 'claude-code'
import type { MachineLocks, MachineLocksGuard as Guard, MachineLocksHolder as Holder, MachineLocksRelease as Release, MachineLocksTable as Locks } from '../types'
import { acquireIn, budgetOf, deadHoldersOf, defineIn, guardVerdictOf, liveSessionsOf, LOCKS_KEY, longHeldOf, nameOf, releaseIn, removeIn, scaledCapacityOf } from './table'
import type { AgentRow, Budget } from './table'

type Run = { exitCode: number; stdout: string }

/**
 * What the lock code needs of `$`, built from a hook's or from the one `engine.create` returns: the engine
 * takes `$` only as `$.noun.event(...)` at the call site, so that one is never handed to a function.
 */
type Ops = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  id: () => Promise<string>
  cwd: () => Promise<string>
  run: (argv: string[], timeoutMs: number) => Promise<Run>
  send: (sessionId: string, text: string) => Promise<boolean>
  submit: (text: string) => Promise<unknown>
  log: (text: string) => void
  /** Set inside a tool.call hook, where a prompt.submit would wait on the very turn the hook holds: grants to this session land here and go out in the tool's answer. */
  ownGrants?: string[]
}

const opsOf = ($: EngineInterface): Ops => ({
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  now: () => $.clock.now(),
  sleep: ms => $.clock.sleep(ms),
  id: () => $.session.id(),
  cwd: () => $.session.cwd(),
  run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
  send: async (sessionId, text) => (await $.session.send({ to: { sessionId }, text })).isDelivered,
  submit: text => $.prompt.submit({ text }),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const TOOL = 'locks'
const TOOL_ID = 'mcp__machine-locks__locks'
const SWEEP_MS = 3 * 60_000
const SWEEP_KEY = 'sweepAt'
const ALERTED_KEY = 'alerted'

const DESCRIPTION = `Exclusive resources shared by every Claude session on this machine (a simulator or device, a local database, fixed ports, build capacity), so two sessions never use one at once.
Actions: "list" (every resource with its capacity, holders and queue); "define" (resource, capacity; add memoryGb and/or cores, what one slot uses, and capacity becomes the max: the capacity then follows the machine's free memory and load; add guard to have Bash refuse the commands that need a slot of it, or that act on every session's instance at once); "acquire" (resource, label: answers granted, or queued with how many are ahead; when queued, do not touch the resource and end your turn on "Waiting on <resource> for <label>": a GRANTED <resource> message wakes you once a slot frees); "release" (resource, label: frees your slot as soon as you are done, and the next session in line is told); "remove" (resource, refused while another session holds or waits on it).
"label" says what the slot is for, your task id in a coordinator run; a second slot of the same resource takes another label (T2#2). Every slot of this session is freed when it exits.`

async function loadLocks(o: Ops): Promise<Locks> {
  return ((await o.get(LOCKS_KEY)) as Locks | undefined) ?? {}
}

/** A `mkdir` either creates the folder or fails, atomically: the claim every session of the machine takes before changing the table. */
const MUTEX_DIR = '/tmp/claude-machine-locks.mutex'
/** A change holds the mutex for milliseconds: one older than this was left by a session killed mid-change. */
const MUTEX_STALE_MS = 10_000
const MUTEX_WAIT_MS = 5_000

const runOrNull = (o: Ops, argv: string[]) => o.run(argv, 2000).catch(() => null)

async function isMutexStale(o: Ops): Promise<boolean> {
  const stat = await runOrNull(o, ['stat', '-f', '%m', MUTEX_DIR])
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

// `$.store` has no compare-and-set across processes: without the mutex, two sessions that acquire at once both
// read the same table and the last write drops the other's slot, which then believes it holds one.
async function changeLocks<T extends { next: Locks }>(o: Ops, change: (all: Locks) => T): Promise<T> {
  return withMutex(o, async () => {
    const result = change(await loadLocks(o))
    await o.set(LOCKS_KEY, result.next)
    return result
  })
}

async function agentRows(o: Ops): Promise<AgentRow[] | null> {
  const listed = await o.run(['claude', 'agents', '--json', '--all'], 15_000).catch(() => null)
  if (!listed || listed.exitCode !== 0) return null
  try {
    return JSON.parse(listed.stdout) as AgentRow[]
  } catch {
    return null
  }
}

let ownName: { id: string; name: string } | null = null

/** This session's name as `claude agents` lists it, else its folder's: what another session's board shows for its slots. */
async function selfName(o: Ops): Promise<string> {
  const id = await o.id()
  if (ownName?.id === id) return ownName.name
  const listed = (await agentRows(o))?.find(r => r.sessionId === id)?.name
  ownName = { id, name: listed || (await o.cwd()).split('/').filter(Boolean).pop() || id.slice(0, 8) }
  return ownName.name
}

const grantText = (resource: string, h: Holder) =>
  `GRANTED ${resource}${h.label ? ` ${h.label}` : ''}: the slot you queued for is yours now. Release it through ${TOOL_ID} as soon as you are done with it.`

/** Tells the session it now holds the slot; false when it cannot be reached. */
async function notify(o: Ops, resource: string, h: Holder): Promise<boolean> {
  if (h.session === (await o.id())) {
    if (o.ownGrants) o.ownGrants.push(grantText(resource, h))
    else await o.submit(`[machine-locks] ${grantText(resource, h)}`)
    return true
  }
  try {
    return await o.send(h.session, grantText(resource, h))
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

async function release(o: Ops, resource: string, slot: { session: string; label?: string }): Promise<Release[]> {
  const now = await o.now()
  const { released, promoted } = await changeLocks(o, all => releaseIn(all, resource, slot, now))
  return released.length === 0 ? [] : [{ resource, released, granted: await grant(o, resource, promoted) }]
}

async function releaseSession(o: Ops, session: string): Promise<Release[]> {
  const all = await loadLocks(o)
  const held = Object.entries(all).filter(([, l]) => [...l.holders, ...l.queue].some(h => h.session === session))
  // One after the other: each release rewrites the whole table.
  const done: Release[] = []
  for (const [resource] of held) done.push(...(await release(o, resource, { session })))
  return done
}

const apiOf = (o: Ops): MachineLocks => ({
  list: () => loadLocks(o),
  release: (resource, session, label) => release(o, resource, label === undefined ? { session } : { session, label }),
  releaseSession: session => releaseSession(o, session),
})

async function machineBudget(o: Ops): Promise<Budget | null> {
  const sys = await o.run(['sysctl', '-n', 'vm.loadavg', 'hw.ncpu', 'hw.memsize'], 5000)
  const pressure = await o.run(['memory_pressure', '-Q'], 5000)
  if (sys.exitCode !== 0 || pressure.exitCode !== 0) return null
  return budgetOf(sys.stdout, pressure.stdout)
}

/** Sets every scaled lock to what the machine has room for now, and grants the queue when that rises. */
async function scaleLocks(o: Ops): Promise<void> {
  if (!Object.values(await loadLocks(o)).some(l => l.scale)) return
  const budget = await machineBudget(o)
  if (!budget) return
  const now = await o.now()
  const changes: { resource: string; from: number; to: number; promoted: Holder[] }[] = []
  await changeLocks(o, all => {
    let next = all
    for (const [resource, lock] of Object.entries(all)) {
      const to = scaledCapacityOf(lock, budget, now)
      if (to === lock.capacity) continue
      const scaled = defineIn(next, resource, to, now)
      next = scaled.next
      changes.push({ resource, from: lock.capacity, to, promoted: scaled.promoted })
    }
    return { next }
  })
  for (const c of changes) {
    o.log(`machine-locks: ${c.resource} capacity ${c.from} -> ${c.to}, ${Math.round(budget.freeMb / 1024)} GB free, load ${budget.load.toFixed(1)}`)
    await grant(o, c.resource, c.promoted)
  }
}

/** A holder whose session is gone never releases: when someone waits on its lock, its slot goes to the next in line. */
async function freeDead(o: Ops): Promise<void> {
  const all = await loadLocks(o)
  if (!Object.values(all).some(l => l.queue.length > 0)) return
  const rows = await agentRows(o)
  if (!rows) return
  for (const { resource, holder } of deadHoldersOf(all, liveSessionsOf(rows))) {
    o.log(`machine-locks: ${nameOf(holder)} is gone, its ${resource} slot is released`)
    await release(o, resource, { session: holder.session, label: holder.label ?? '' })
  }
}

async function alertLongHolds(o: Ops, now: number): Promise<void> {
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
    `[machine-locks] This session has held a shared machine slot for long:\n${found.map(f => f.line).join('\n')}\nRelease each one you no longer use through ${TOOL_ID}; when a job still runs under it, check it is not stuck, and stop it past its budget.`,
  )
}

/** Scaling and the dead-holder check run once per sweep for the whole machine, whichever session gets there first. */
async function sweep(o: Ops): Promise<void> {
  const now = await o.now()
  await alertLongHolds(o, now)
  const last = Number((await o.get(SWEEP_KEY)) ?? 0)
  if (now - last < SWEEP_MS - 10_000) return
  await o.set(SWEEP_KEY, now)
  await scaleLocks(o)
  await freeDead(o)
}

const answer = (text: string) => ({ result: text }) as never

type Input = { action?: string; resource?: string; capacity?: number; memoryGb?: number; cores?: number; label?: string; holder?: string; guard?: Guard }

async function define(o: Ops, resource: string, input: Input): Promise<string> {
  const capacity = Math.max(1, Math.floor(input.capacity ?? 1))
  const now = await o.now()
  const isScaled = (input.memoryGb ?? 0) > 0 || (input.cores ?? 0) > 0
  const scale = isScaled ? { max: capacity, ...(input.memoryGb ? { memoryMb: Math.round(input.memoryGb * 1024) } : {}), ...(input.cores ? { cores: input.cores } : {}) } : null
  const budget = isScaled ? await machineBudget(o) : null
  const { next, promoted } = await changeLocks(o, all => {
    const draft = defineIn(all, resource, capacity, now, scale).next[resource]
    return defineIn(all, resource, budget && draft ? scaledCapacityOf(draft, budget, now) : capacity, now, scale, input.guard)
  })
  const granted = await grant(o, resource, promoted)
  const effective = next[resource]?.capacity ?? capacity
  const sizing = isScaled ? `, scaled: capacity ${effective} of max ${capacity}${budget ? '' : ' (machine not measured yet)'}` : `, capacity ${capacity}`
  return `${resource} defined${sizing}${granted.length ? `, granted to ${granted.map(nameOf).join(', ')}` : ''}`
}

async function acquire(o: Ops, resource: string, label: string): Promise<string> {
  const holder: Holder = { session: await o.id(), name: await selfName(o), ...(label ? { label } : {}), since: await o.now() }
  const { outcome, ahead } = await changeLocks(o, all => acquireIn(all, resource, holder))
  if (outcome === 'unknown') return `${resource} is not defined: "list" shows the resources, "define" adds one`
  if (outcome === 'granted') return `${resource} granted: it is yours until you release it`
  return `${resource} queued, ${ahead} ahead: do not use it yet, end your turn on "Waiting on ${resource}${label ? ` for ${label}` : ''}"; a GRANTED ${resource} message wakes you`
}

/** Another session's slot is freed only once that session is gone: a live one is asked to release it itself. */
async function releaseFor(o: Ops, resource: string, input: Input): Promise<string> {
  const lock = (await loadLocks(o))[resource]
  if (!lock) return `${resource} is not defined`
  const own = await o.id()
  const target = input.holder
    ? [...lock.holders, ...lock.queue].find(h => h.session === input.holder || h.name === input.holder)?.session
    : own
  if (!target) return `${input.holder} holds no slot of ${resource}`
  if (target !== own) {
    const rows = await agentRows(o)
    if (rows === null || liveSessionsOf(rows).has(target)) return `${input.holder} is still running: ask it to release ${resource}; nothing released`
  }
  const done = await release(o, resource, input.label ? { session: target, label: input.label } : { session: target })
  if (done.length === 0) return `${resource}: no slot of this session to release`
  const handed = done.flatMap(d => d.granted.map(nameOf))
  return `${resource} released${handed.length ? `, granted to ${handed.join(', ')}` : ''}`
}

async function respond(o: Ops, input: Input): Promise<string> {
  const { action = '', resource = '', label = '' } = input
  if (action === 'list') return JSON.stringify(await loadLocks(o), null, 1)
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

export const register: Register = on => {
  on('engine.create', async (_$, e, next) => {
    const built = await next(e)
    const ops: Ops = {
      get: key => built.store.get(key),
      set: (key, value) => built.store.set(key, value),
      now: () => built.clock.now(),
      sleep: ms => built.clock.sleep(ms),
      id: () => built.session.id(),
      cwd: () => built.session.cwd(),
      run: (argv, timeoutMs) => built.process.run(argv, { timeoutMs }),
      send: async (sessionId, text) => (await built.session.send({ to: { sessionId }, text })).isDelivered,
      submit: text => built.prompt.submit({ text }),
      log: text => built.ui.log(text, { to: 'debug' }),
    }
    return { ...built, machineLocks: apiOf(ops) }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const o = opsOf($)
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: { enum: ['list', 'define', 'acquire', 'release', 'remove'] },
          resource: { type: 'string' },
          capacity: { type: 'number' },
          memoryGb: { type: 'number', description: 'define: the memory one slot uses, device and dev server included' },
          cores: { type: 'number', description: 'define: the cores one slot uses' },
          label: { type: 'string', description: 'acquire, release: what the slot is for, your task id in a coordinator run' },
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
      },
    })
    $.clock.every(SWEEP_MS, () => {
      void sweep(o).catch(error => o.log(`machine-locks sweep: ${String(error)}`))
    })
    return started
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const ownGrants: string[] = []
    const reply = await respond({ ...opsOf($), ownGrants }, e as unknown as Input)
    return answer([reply, ...ownGrants].join('\n'))
  })

  // Matching the command text, not what it runs: a script that boots a device passes, this only stops the slip.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)
    const reason = guardVerdictOf(await loadLocks(opsOf($)), command, await $.session.id(), TOOL_ID)
    return reason ? { deny: reason } : next(e)
  })

  // A session that ends for good frees its slots. A background session paused by its supervisor ends with
  // `other` and comes back on a message, so it keeps them; a gone one is freed by the sweep once someone waits.
  on('session.end', async ($, e, next) => {
    const o = opsOf($)
    if (e.reason === 'prompt_input_exit' || e.reason === 'clear' || e.reason === 'logout') {
      await releaseSession(o, e.sessionId).catch(error => o.log(`machine-locks end: ${String(error)}`))
    }
    return next(e)
  })
}
