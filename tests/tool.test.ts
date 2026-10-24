import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const TOOL = 'mcp__machine-locks__locks'

/** Two sessions of one machine: they share the store, and `as` switches which one is calling. */
function machine(on: On, live: string[] = ['a', 'b', 'c'], sysctl?: { stdout: string; pressure: string }) {
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  let me = 'a'
  on('session.id', () => ({ value: me }))
  on('session.cwd', () => ({ value: `/w/${me}` }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const sent: { to: string; text: string }[] = []
  const unreachable = new Set<string>()
  on('session.send', (_$, e) => {
    sent.push({ to: JSON.stringify(e.to), text: e.text })
    return [...unreachable].some(s => JSON.stringify(e.to).includes(s)) ? { isDelivered: false as const, reason: 'gone' } : { isDelivered: true as const }
  })
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  // The mutex folder, as `mkdir`, `rmdir` and `stat -f %m` see it: the second it was made at, or absent.
  const mutex: { madeAt?: number } = {}
  const runs: string[] = []
  on('process.run', (_$, e) => {
    runs.push(e.argv[0] ?? '')
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'mkdir') {
      if (mutex.madeAt !== undefined) return done(1)
      mutex.madeAt = Math.floor(clock.now() / 1000)
      return done(0)
    }
    if (e.argv[0] === 'rmdir') {
      if (mutex.madeAt === undefined) return done(1)
      delete mutex.madeAt
      return done(0)
    }
    if (e.argv[0] === 'stat') return mutex.madeAt === undefined ? done(1) : done(0, `${mutex.madeAt}\n`)
    const rows = live.map(s => ({ sessionId: s, name: `session-${s}`, state: 'working' }))
    return done(0, e.argv[0] === 'claude' ? JSON.stringify(rows) : e.argv[0] === 'sysctl' ? (sysctl?.stdout ?? '') : (sysctl?.pressure ?? ''))
  })
  return { store, clock, sent, prompts, unreachable, mutex, runs, as: (session: string) => void (me = session) }
}

const call = async ($: Engine, input: Record<string, unknown>) =>
  String(((await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: unknown }).result)

test('the second session waits, and is told GRANTED when the first releases', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  expect(await call($, { action: 'define', resource: 'simulator', capacity: 1 })).toBe('simulator defined, capacity 1')
  expect(await call($, { action: 'acquire', resource: 'simulator', label: 'T1' })).toContain('simulator granted')
  m.as('b')
  expect(await call($, { action: 'acquire', resource: 'simulator' })).toContain('queued, 0 ahead')
  m.as('a')
  expect(await call($, { action: 'release', resource: 'simulator' })).toBe('simulator released, granted to session-b')
  expect(m.sent).toHaveLength(1)
  expect(m.sent[0]?.to).toContain('b')
  expect(m.sent[0]?.text).toStartWith('GRANTED simulator:')
})

test('a session queued for a second slot of its own resource is told GRANTED in the release answer', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator', label: 'T1' })
  expect(await call($, { action: 'acquire', resource: 'simulator', label: 'T2' })).toContain('queued')
  const released = await call($, { action: 'release', resource: 'simulator', label: 'T1' })
  expect(released).toStartWith('simulator released, granted to session-a')
  expect(released).toContain('GRANTED simulator T2:')
  expect(m.prompts).toEqual([])
})

test('a GRANTED that reaches nobody passes the slot to the next in line', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator' })
  m.as('b')
  await call($, { action: 'acquire', resource: 'simulator' })
  m.as('c')
  await call($, { action: 'acquire', resource: 'simulator' })
  m.unreachable.add('"b"')
  m.as('a')
  expect(await call($, { action: 'release', resource: 'simulator' })).toBe('simulator released, granted to session-c')
  const table = m.store.get('locks') as Record<string, { holders: { session: string }[]; queue: unknown[] }>
  expect(table.simulator?.holders.map(h => h.session)).toEqual(['c'])
  expect(table.simulator?.queue).toEqual([])
})

test('another live session keeps its slot; a gone one can be freed by name', async ($, on) => {
  const m = machine(on, ['a', 'b'])
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'db', capacity: 1 })
  m.as('b')
  await call($, { action: 'acquire', resource: 'db' })
  m.as('a')
  expect(await call($, { action: 'release', resource: 'db', holder: 'session-b' })).toContain('still running')
  m.as('c')
  await call($, { action: 'acquire', resource: 'db' })
  m.as('a')
  m.store.set('locks', { db: { capacity: 1, holders: [{ session: 'gone', name: 'old' }], queue: [] } })
  expect(await call($, { action: 'release', resource: 'db', holder: 'old' })).toBe('db released')
})

test('a session that exits frees its slots and the next in line is told', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator' })
  m.as('b')
  await call($, { action: 'acquire', resource: 'simulator' })
  m.as('a')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' } as never)
  expect(m.sent.map(s => s.text.split(':')[0])).toEqual(['GRANTED simulator'])
})

test('a paused background session keeps its slots', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator' })
  await $.session.end({ reason: 'other', sessionId: 'a' } as never)
  const table = m.store.get('locks') as Record<string, { holders: unknown[] }>
  expect(table.simulator?.holders).toHaveLength(1)
})

test('the sweep frees a dead holder someone waits on, and warns a long holder once', async ($, on) => {
  const m = machine(on, ['a', 'b'])
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  m.store.set('locks', {
    simulator: { capacity: 1, holders: [{ session: 'dead', name: 'old', since: 0 }], queue: [{ session: 'b', name: 'session-b' }] },
    build: { capacity: 1, holders: [{ session: 'a', name: 'session-a', since: 1_000_000 }], queue: [] },
  })
  await m.clock.advance(3 * 60_000)
  expect(m.sent.map(s => s.text.split(':')[0])).toEqual(['GRANTED simulator'])
  await m.clock.advance(45 * 60_000)
  expect(m.prompts.filter(p => p.startsWith('[machine-locks] This session has held'))).toHaveLength(1)
  await m.clock.advance(3 * 60_000)
  expect(m.prompts.filter(p => p.startsWith('[machine-locks] This session has held'))).toHaveLength(1)
})

test('a scaled lock is sized from the machine at define', async ($, on) => {
  machine(on, ['a'], { stdout: '{ 1.00 1.00 1.00 }\n10\n34359738368\n', pressure: 'System-wide memory free percentage: 50%' })
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  expect(await call($, { action: 'define', resource: 'simulator', capacity: 4, memoryGb: 4 })).toBe('simulator defined, scaled: capacity 2 of max 4')
})

test('every change of the table holds the machine mutex and frees it', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator' })
  expect(m.runs.filter(r => r === 'mkdir' || r === 'rmdir')).toEqual(['mkdir', 'rmdir', 'mkdir', 'rmdir'])
  expect(m.mutex.madeAt).toBeUndefined()
})

test('a mutex left by a session killed mid-change is taken over', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  m.mutex.madeAt = Math.floor(m.clock.now() / 1000) - 60
  expect(await call($, { action: 'define', resource: 'simulator', capacity: 1 })).toBe('simulator defined, capacity 1')
  expect(m.mutex.madeAt).toBeUndefined()
})

test('a change waits while another session holds the mutex', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  m.mutex.madeAt = Math.floor(m.clock.now() / 1000)
  const defined = call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await m.clock.advance(100)
  expect(m.store.get('locks')).toBeUndefined()
  delete m.mutex.madeAt
  await m.clock.advance(100)
  expect(await defined).toBe('simulator defined, capacity 1')
})

test('Bash refuses a device boot until the session holds a slot', async ($, on) => {
  machine(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'booted' }) as never)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'ios-simulator', capacity: 1 })
  const boot = () => $.tool.call({ tool: 'Bash', command: 'xcrun simctl boot 1234' } as never) as Promise<{ deny?: string; result?: unknown }>
  expect((await boot()).deny).toContain('needs a ios-simulator slot')
  await call($, { action: 'acquire', resource: 'ios-simulator', label: 'T1' })
  expect((await boot()).result).toBe('booted')
})

test('history reports what the released slots waited and held', async ($, on) => {
  const m = machine(on)
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await call($, { action: 'define', resource: 'simulator', capacity: 1 })
  await call($, { action: 'acquire', resource: 'simulator' })
  m.as('b')
  await call($, { action: 'acquire', resource: 'simulator' })
  await m.clock.advance(5 * 60_000)
  m.as('a')
  await call($, { action: 'release', resource: 'simulator' })
  await m.clock.advance(10 * 60_000)
  m.as('b')
  await call($, { action: 'release', resource: 'simulator' })
  expect(JSON.parse(await call($, { action: 'history' })).simulator).toMatchObject({ holds: 2, queued: 1, waitMinutes: { p90: 5 }, holdMinutes: { p50: 10 } })
})
