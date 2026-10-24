import { expect, test } from 'claude-code/testing'

import { acquireIn, budgetOf, deadHoldersOf, defineIn, guardVerdictOf, historyStatsOf, historyWith, HISTORY_SIZE, liveSessionsOf, longHeldOf, LONG_HOLD_MS, releaseIn, removeIn, scaledCapacityOf } from '../hooks/table'

const one = { simulator: { capacity: 1, holders: [], queue: [] } }
const a = { session: 'a', name: 'alpha', since: 0 }
const b = { session: 'b', name: 'beta', since: 0 }

test('the second session queues once the first fills the slot', () => {
  const first = acquireIn(one, 'simulator', a)
  const second = acquireIn(first.next, 'simulator', b)
  expect([first.outcome, second.outcome, second.ahead]).toEqual(['granted', 'queued', 0])
})

test('asking again for a slot already held or queued changes nothing', () => {
  const held = acquireIn(one, 'simulator', a).next
  const queued = acquireIn(held, 'simulator', b).next
  expect(acquireIn(queued, 'simulator', a).next).toBe(queued)
  expect(acquireIn(queued, 'simulator', b)).toEqual({ next: queued, outcome: 'queued', ahead: 0 })
})

test('a release hands the slot to the first in line, its hold starting now', () => {
  const queued = acquireIn(acquireIn(one, 'simulator', a).next, 'simulator', b).next
  const { next, released, promoted } = releaseIn(queued, 'simulator', { session: 'a' }, 500)
  expect(released.map(h => h.session)).toEqual(['a'])
  expect(promoted).toEqual([{ ...b, since: 500, waitedMs: 500 }])
  expect(next.simulator?.holders).toEqual([{ ...b, since: 500, waitedMs: 500 }])
})

test('a labelled release frees only that slot of the session', () => {
  const two = { build: { capacity: 2, holders: [{ ...a, label: 'T1' }, { ...a, label: 'T1#2' }], queue: [] } }
  const { next } = releaseIn(two, 'build', { session: 'a', label: 'T1#2' }, 1)
  expect(next.build?.holders.map(h => h.label)).toEqual(['T1'])
})

test('a resource nobody else holds is removed, one another session waits on is kept', () => {
  const queued = acquireIn(acquireIn(one, 'simulator', a).next, 'simulator', b).next
  expect(removeIn(queued, 'simulator', 'a').heldBy).toEqual(['beta'])
  expect(removeIn(acquireIn(one, 'simulator', a).next, 'simulator', 'a').next).toEqual({})
})

test('a raised capacity grants the queue at once', () => {
  const queued = acquireIn(acquireIn(one, 'simulator', a).next, 'simulator', b).next
  const { next, promoted } = defineIn(queued, 'simulator', 2, 9)
  expect(promoted.map(h => h.session)).toEqual(['b'])
  expect(next.simulator?.holders).toHaveLength(2)
})

const budget = { totalMb: 32_768, freeMb: 16_384, load: 2, cores: 10 }

test('a scaled lock follows the memory left above the floor', () => {
  const lock = { capacity: 1, holders: [], queue: [], scale: { max: 4, memoryMb: 4096 } }
  // 16 GB free less the 6.4 GB floor leaves room for two 4 GB slots.
  expect(scaledCapacityOf(lock, budget, 0)).toBe(2)
})

test('the machine budget is read from sysctl and memory_pressure', () => {
  expect(budgetOf('{ 2.50 2.00 1.00 }\n10\n34359738368\n', 'System-wide memory free percentage: 40%')).toEqual({ totalMb: 32_768, freeMb: 13_107.2, load: 2.5, cores: 10 })
  expect(budgetOf('', '')).toBeNull()
})

test('a long hold is reported once, to its own session only', () => {
  const held = { simulator: { capacity: 1, holders: [a], queue: [b] } }
  const found = longHeldOf(held, 'a', LONG_HOLD_MS + 60_000, {})
  expect(found.map(f => f.line)).toEqual(['- simulator, held for 46 min, 1 waiting'])
  expect(longHeldOf(held, 'a', LONG_HOLD_MS + 60_000, { [found[0]?.key ?? '']: 1 })).toEqual([])
  expect(longHeldOf(held, 'b', LONG_HOLD_MS + 60_000, {})).toEqual([])
})

test('a holder whose session is gone or failed is dead only where someone waits', () => {
  const live = liveSessionsOf([{ sessionId: 'b', state: 'blocked' }, { sessionId: 'c', state: 'failed' }])
  const waited = { simulator: { capacity: 1, holders: [a], queue: [b] }, db: { capacity: 1, holders: [{ ...a, session: 'z' }], queue: [] } }
  expect(deadHoldersOf(waited, live)).toEqual([{ resource: 'simulator', holder: a }])
})

const devices = {
  'ios-simulator': { capacity: 2, holders: [a], queue: [b] },
  'android-emulator': { capacity: 2, holders: [], queue: [] },
}
const verdict = (command: string, session = 'a') => guardVerdictOf(devices, command, session, 'locks')

test('booting a device needs a slot of its resource', () => {
  expect(verdict('U=$($D up ios "app T1")')).toBeNull()
  expect(verdict('xcrun simctl boot 1234')).toBeNull()
  expect(verdict('S=$(~/.claude/skills/mobile-devices/scripts/device up android "app T1")')).toContain('needs a android-emulator slot. Take one first')
  expect(verdict('nohup emulator -avd Pixel_9 &')).toContain('android-emulator')
  expect(verdict('xcrun simctl create x y z', 'b')).toContain('still queued')
})

test('reads and commands aimed at one device pass', () => {
  for (const command of ['xcrun simctl list devices booted', 'adb devices', 'adb -s emulator-5554 shell ls', 'xcrun simctl io 1234 screenshot s.png', 'git commit -m "up ios screen"']) {
    expect(verdict(command, 'c')).toBeNull()
  }
})

test('commands that hit every session at once never run, slot or not', () => {
  for (const command of ['xcrun simctl shutdown all', 'xcrun simctl openurl booted app://x', 'killall Simulator', 'adb kill-server', 'pkill -f qemu-system']) {
    expect(verdict(command)).toContain('acts on every session')
  }
})

test("a lock's own guard replaces the default, and a broken pattern guards nothing", () => {
  const table = { db: { capacity: 1, holders: [], queue: [], guard: { needs: ['\\bpsql\\b', '('] } }, 'ios-simulator': { capacity: 1, holders: [], queue: [], guard: {} } }
  expect(guardVerdictOf(table, 'psql -c "drop table x"', 'a', 'locks')).toContain('needs a db slot')
  expect(guardVerdictOf(table, 'xcrun simctl boot 1234', 'a', 'locks')).toBeNull()
})

test('define keeps a guard it is not given', () => {
  const guarded = defineIn({}, 'db', 1, 0, undefined, { needs: ['psql'] }).next
  expect(defineIn(guarded, 'db', 2, 0).next.db?.guard).toEqual({ needs: ['psql'] })
  expect(defineIn(guarded, 'db', 2, 0, undefined, null).next.db?.guard).toBeUndefined()
})

test('a release records the hold with the wait that preceded it', () => {
  const held = acquireIn(one, 'simulator', a).next
  const queued = acquireIn(held, 'simulator', { ...b, since: 60_000 }).next
  const first = releaseIn(queued, 'simulator', { session: 'a' }, 240_000)
  expect(first.holds).toEqual([{ resource: 'simulator', name: 'alpha', releasedAt: 240_000, heldMs: 240_000, waitedMs: 0 }])
  const second = releaseIn(first.next, 'simulator', { session: 'b' }, 600_000)
  expect(second.holds[0]).toMatchObject({ name: 'beta', heldMs: 360_000, waitedMs: 180_000 })
})

test('a queued slot given up records no hold, and the history keeps only the latest', () => {
  const queued = acquireIn(acquireIn(one, 'simulator', a).next, 'simulator', b).next
  expect(releaseIn(queued, 'simulator', { session: 'b' }, 1).holds).toEqual([])
  const hold = { resource: 'simulator', name: 'alpha', releasedAt: 0, heldMs: 0, waitedMs: 0 }
  expect(historyWith(Array(HISTORY_SIZE).fill(hold), [{ ...hold, name: 'last' }]).at(-1)?.name).toBe('last')
  expect(historyWith(Array(HISTORY_SIZE).fill(hold), [hold])).toHaveLength(HISTORY_SIZE)
})

test('history stats count the queued holds and read wait and hold in minutes', () => {
  const hold = (waitedMs: number, heldMs: number) => ({ resource: 'simulator', name: 'x', releasedAt: 0, heldMs, waitedMs })
  expect(historyStatsOf([hold(0, 600_000), hold(120_000, 1_200_000), hold(0, 1_800_000)])).toEqual({
    simulator: { holds: 3, queued: 1, waitMinutes: { p50: 0, p90: 2 }, holdMinutes: { p50: 20, p90: 30 }, since: 0 },
  })
})
