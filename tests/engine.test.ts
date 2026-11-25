import { expect, test } from 'claude-code/testing'

import { release, respond, sharedDirOf, sweep } from '../hooks/engine'
import type { Ops, Run } from '../hooks/engine'

/** One machine: the table's files, the mutex, the clock and the running processes every host shares. */
function machine() {
  const files = new Map<string, unknown>()
  const clock = { now: 1_000_000, onSleep: async () => {} }
  const running = new Set<number>()
  let mutex = false
  const run = async (argv: string[]): Promise<Run> => {
    if (argv[0] === 'mkdir') return mutex ? { exitCode: 1, stdout: '' } : ((mutex = true), { exitCode: 0, stdout: '' })
    if (argv[0] === 'rmdir') return (mutex = false), { exitCode: 0, stdout: '' }
    if (argv[0] === 'ps') {
      const alive = (argv[argv.length - 1] ?? '').split(',').map(Number).filter(pid => running.has(pid))
      return { exitCode: alive.length ? 0 : 1, stdout: alive.map(pid => `${pid}\n`).join('') }
    }
    return { exitCode: 1, stdout: '' }
  }
  const sent: { to: string; text: string }[] = []
  const submitted: string[] = []
  const base = (session: string): Ops => {
    const scratch = new Map<string, unknown>()
    return {
      get: async key => scratch.get(key),
      set: async (key, value) => void scratch.set(key, value),
      readShared: async name => (files.has(name) ? JSON.parse(JSON.stringify(files.get(name))) : undefined),
      writeShared: async (name, value) => void files.set(name, JSON.parse(JSON.stringify(value))),
      now: async () => clock.now,
      sleep: async ms => {
        clock.now += ms
        await clock.onSleep()
      },
      id: async () => session,
      name: async () => session,
      run,
      log: () => {},
      tool: 'locks',
    }
  }
  const claude = (session: string): Ops => ({
    ...base(session),
    send: async (to, text) => (sent.push({ to, text }), true),
    submit: async text => void submitted.push(text),
    agents: async () => [{ sessionId: 'claude-a', state: 'working' }, { sessionId: 'claude-b', state: 'working' }],
  })
  const codex = (pid: number, waitMs = 60_000): Ops => (running.add(pid), { ...base(`codex:${pid}`), pid, waitMs })
  return { files, clock, running, sent, submitted, claude, codex }
}

test('a Codex session waits in its acquire call until a Claude session releases, and is sent nothing', async () => {
  const m = machine()
  const a = m.claude('claude-a')
  await respond(a, { action: 'define', resource: 'db', capacity: 1 })
  expect(await respond(a, { action: 'acquire', resource: 'db' })).toContain('granted')
  let polls = 0
  m.clock.onSleep = async () => {
    if (++polls === 3) await release(a, 'db', { session: 'claude-a' })
  }
  expect(await respond(m.codex(41), { action: 'acquire', resource: 'db', label: 'T1' })).toBe('db granted: it is yours until you release it')
  expect(polls).toBe(3)
  expect(m.sent).toEqual([])
})

test('a waiting Codex acquire answers still queued past its wait, and the same call keeps its place', async () => {
  const m = machine()
  const a = m.claude('claude-a')
  await respond(a, { action: 'define', resource: 'db', capacity: 1 })
  await respond(a, { action: 'acquire', resource: 'db' })
  const x = m.codex(41, 10_000)
  expect(await respond(x, { action: 'acquire', resource: 'db', label: 'T1' })).toContain('db still queued, 0 ahead')
  await respond(m.codex(42, 4_000), { action: 'acquire', resource: 'db' })
  const table = (await x.readShared('locks')) as { db: { queue: { session: string }[] } }
  expect(table.db.queue.map(q => q.session)).toEqual(['codex:41', 'codex:42'])
})

test('a Claude session granted from Codex is marked untold, and its own sweep tells it once', async () => {
  const m = machine()
  const x = m.codex(41)
  await respond(x, { action: 'define', resource: 'db', capacity: 1 })
  await respond(x, { action: 'acquire', resource: 'db' })
  const a = m.claude('claude-a')
  expect(await respond(a, { action: 'acquire', resource: 'db' })).toContain('queued, 0 ahead')
  expect(await respond(x, { action: 'release', resource: 'db' })).toBe('db released, granted to claude-a')
  const table = (await x.readShared('locks')) as { db: { holders: { session: string; untold?: boolean }[] } }
  expect(table.db.holders).toEqual([expect.objectContaining({ session: 'claude-a', untold: true })])
  await sweep(a)
  await sweep(a)
  expect(m.submitted.filter(s => s.includes('GRANTED db'))).toHaveLength(1)
  const after = (await a.readShared('locks')) as { db: { holders: { untold?: boolean }[] } }
  expect(after.db.holders[0]?.untold).toBeUndefined()
})

test('a Codex holder whose process is gone is freed once someone waits, and a live one keeps its slot', async () => {
  const m = machine()
  const x = m.codex(41)
  await respond(x, { action: 'define', resource: 'db', capacity: 1 })
  await respond(x, { action: 'acquire', resource: 'db' })
  const a = m.claude('claude-a')
  await respond(a, { action: 'acquire', resource: 'db' })
  expect(await respond(a, { action: 'release', resource: 'db', holder: 'codex:41' })).toContain('still running')
  m.running.delete(41)
  expect(await respond(a, { action: 'release', resource: 'db', holder: 'codex:41' })).toBe('db released, granted to claude-a')
})

test('the table is read from the store until its file exists', async () => {
  const m = machine()
  const a = m.claude('claude-a')
  await a.set('locks', { db: { capacity: 1, holders: [], queue: [] } })
  expect(await respond(a, { action: 'acquire', resource: 'db' })).toContain('granted')
  expect(m.files.has('locks')).toBe(true)
})

test('the table lives under the home folder, never in a folder other users can write', () => {
  expect(sharedDirOf({ HOME: '/home/u' })).toBe('/home/u/.local/state/machine-locks')
  expect(sharedDirOf({ MACHINE_LOCKS_DIR: '/d', HOME: '/home/u' })).toBe('/d')
  expect(() => sharedDirOf({})).toThrow('neither MACHINE_LOCKS_DIR nor HOME')
})
