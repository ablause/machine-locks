import { expect, test } from 'claude-code/testing'

import { bandModelOf } from '../hooks/band'
import type { MachineLocksBandView } from '../types'

const TOOL = 'mcp__machine-locks__locks'

const view = (locks: MachineLocksBandView['locks'], session = 'a'): MachineLocksBandView => ({
  session,
  at: 15 * 60_000,
  locks,
  room: { memoryMb: 8192, cores: 4 },
  totalMb: 32_768,
})

const ios = { max: 6, memoryMb: 4096 }

test('a session with nothing held, queued or waited on draws no band', () => {
  expect(bandModelOf(view({ 'ios-simulator': { capacity: 6, holders: [{ session: 'b', name: 'beta', since: 0 }], queue: [], scale: ios } }))).toBeNull()
})

test('the band shows the room, its own slots first and its place in line', () => {
  const model = bandModelOf(
    view({
      'ios-simulator': { capacity: 6, holders: [{ session: 'b', name: 'beta', since: 0 }, { session: 'a', name: 'alpha', label: 'T1', since: 3 * 60_000 }], queue: [], scale: ios },
      'android-emulator': { capacity: 4, holders: [], queue: [{ session: 'c', name: 'gamma', since: 1 }, { session: 'a', name: 'alpha', label: 'T2', since: 2 }], scale: ios },
    }),
  )
  expect(model?.gauge).toEqual({ freeGb: 8, usableGb: 25.6, share: 1 - 8192 / 26_214.4, isFull: false })
  expect(model?.rows[0]).toEqual({ resource: 'ios-simulator', held: 2, max: 6, isOwn: true, holders: ['toi T1, 12 min', 'beta'], queued: 0 })
  expect(model?.held).toEqual([{ resource: 'ios-simulator', label: 'T1' }])
  expect(model?.queued).toEqual([{ resource: 'android-emulator', label: 'T2', position: 2 }])
})

test('sessions waiting on the machine show the band to everyone, the gauge marked full', () => {
  const model = bandModelOf({ ...view({ 'android-emulator': { capacity: 4, holders: [], queue: [{ session: 'c', name: 'gamma', since: 1 }], scale: ios } }), room: { memoryMb: 1000, cores: 4 } })
  expect(model?.gauge?.isFull).toBe(true)
  expect(model?.held).toEqual([])
})

test('the band draws above the prompt and its button frees the slot', async ($, on) => {
  const store = new Map<string, unknown>()
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine-band' }) as never
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const files = new Map<string, string>()
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.hookEnv', () => ({ value: { HOME: '/h' } }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.id', () => ({ value: 'a' }))
  on('session.cwd', () => ({ value: '/w/a' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'mv') {
      files.set(e.argv[3] ?? '', files.get(e.argv[2] ?? '') ?? '')
      files.delete(e.argv[2] ?? '')
    }
    return { value: { exitCode: e.argv[0] === 'claude' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/w/a', surface: null, isInteractive: false })
  await $.tool.call({ tool: TOOL, action: 'define', resource: 'db', capacity: 1 } as never)
  await $.tool.call({ tool: TOOL, action: 'acquire', resource: 'db', label: 'T1' } as never)
  const band = await $.ui.mount({ plugin: 'machine-locks', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 90 } } as never)
  expect(await band.find({ type: 'Box', key: 'engine-band' })).toBeDefined()
  await band.press({ key: 'release-db-T1' })
  expect((JSON.parse(files.get('/h/.local/state/machine-locks/locks.json') ?? '{}') as Record<string, { holders: unknown[] }>).db?.holders).toEqual([])
  expect(await band.find({ type: 'Button', key: 'release-db-T1' })).toBeUndefined()
  await band.unmount()
})
