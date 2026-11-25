import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { ADMIT_MS, apiOf, claudeAgentsVia, INPUT_SCHEMA, loadLocks, machineBudget, release, releaseSession, respond, sharedDirOf, sweep } from './engine'
import type { Input, Ops } from './engine'
import { budgetQueueOf, guardVerdictOf, roomOf } from './table'
import { bandModelOf } from './band'
import { stackBands } from './bands'
import type { BandModel, BandView, Slot } from './band'

const bandView = atom({ plugin: 'machine-locks', key: 'band' } as const, null as BandView | null)

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

const TOOL = 'locks'
const TOOL_ID = 'mcp__machine-locks__locks'

const DESCRIPTION = `Exclusive resources shared by every Claude session on this machine (a simulator or device, a local database, fixed ports, build capacity), so two sessions never use one at once.
Actions: "list" (every resource with its capacity, holders and queue); "history" (per resource, how often a slot was queued for and how long slots waited and were held: what to size a capacity or memoryGb on); "define" (resource, capacity; add memoryGb and/or cores, what one slot uses, and the resource draws on the machine's memory and cores, shared with every other resource defined so, capacity becoming its own max; add guard to have Bash refuse the commands that need a slot of it, or that act on every session's instance at once); "acquire" (resource, label: answers granted, or queued with how many are ahead; when queued, do not touch the resource and end your turn on "Waiting on <resource> for <label>": a GRANTED <resource> message wakes you once a slot frees); "release" (resource, label: frees your slot as soon as you are done, and the next session in line is told); "remove" (resource, refused while another session holds or waits on it).
"label" says what the slot is for, such as a task id; a second slot of the same resource takes another label (T2#2). Every slot of this session is freed when it exits.`

type FileIo = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<unknown>
  write: (path: string, text: string) => Promise<void>
  run: Ops['run']
  env: () => Promise<Record<string, string>>
  tag: () => Promise<string>
}

/**
 * The table's files, shared with every Claude and Codex session on the machine; a write lands whole, by a rename.
 * Only a file that does not exist reads as absent: one that cannot be read throws, rather than pass for an empty table.
 */
function sharedFilesOf(io: FileIo): Pick<Ops, 'readShared' | 'writeShared'> {
  let dir: string | null = null
  const dirOf = async () => (dir ??= sharedDirOf(await io.env()))
  return {
    readShared: async name => {
      const file = `${await dirOf()}/${name}.json`
      if (!(await io.exists(file))) return undefined
      const text = await io.read(file)
      if (typeof text !== 'string') throw new Error(`machine-locks: ${file} is not text`)
      return JSON.parse(text)
    },
    writeShared: async (name, value) => {
      const file = `${await dirOf()}/${name}.json`
      const tmp = `${file}.${await io.tag()}.tmp`
      await io.write(tmp, JSON.stringify(value))
      const moved = await io.run(['mv', '-f', tmp, file], 2000)
      if (moved.exitCode !== 0) throw new Error(`machine-locks: ${tmp} could not replace ${file}`)
    },
  }
}

let ownName: { id: string; name: string } | null = null

/** This session's name as `claude agents` lists it, else its folder's: what another session's board shows for its slots. */
async function selfNameOf(id: string, cwd: () => Promise<string>, run: Ops['run']): Promise<string> {
  if (ownName?.id === id) return ownName.name
  const listed = (await claudeAgentsVia(run))?.find(r => r.sessionId === id)?.name
  ownName = { id, name: listed || (await cwd()).split('/').filter(Boolean).pop() || id.slice(0, 8) }
  return ownName.name
}

/**
 * What the lock engine needs of `$`, built from a hook's or from the one `engine.create` returns: the engine
 * takes `$` only as `$.noun.event(...)` at the call site, so that one is never handed to a function.
 */
const opsOf = ($: EngineInterface): Ops => {
  const run: Ops['run'] = (argv, timeoutMs) => $.process.run(argv, { timeoutMs })
  return {
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    ...sharedFilesOf({ exists: file => $.fs.exists(file), read: file => $.fs.read(file), write: (file, text) => $.fs.write(file, text), run, env: () => $.process.hookEnv(), tag: () => $.session.id() }),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    id: () => $.session.id(),
    name: async () => selfNameOf(await $.session.id(), () => $.session.cwd(), run),
    run,
    log: text => $.ui.log(text, { to: 'debug' }),
    tool: TOOL_ID,
    send: async (sessionId, text) => (await $.session.send({ to: { sessionId }, text })).isDelivered,
    sendAgent: async (agentId, text) => (await $.session.send({ to: { agentId }, text })).isDelivered,
    submit: text => $.prompt.submit({ text }),
    agents: () => claudeAgentsVia(run),
  }
}

/** Measures the machine only when the band will draw it: a session with nothing held, queued or waited on spawns nothing. */
async function refreshBand($: EngineInterface, o: Ops): Promise<void> {
  const locks = await loadLocks(o)
  const session = await o.id()
  const isInvolved = Object.values(locks).some(l => [...l.holders, ...l.queue].some(h => h.session === session)) || budgetQueueOf(locks).length > 0
  const budget = isInvolved && Object.values(locks).some(l => l.scale) ? await machineBudget(o) : null
  const now = await o.now()
  await update($, bandView, () => ({ session, at: now, locks, room: budget ? roomOf(locks, budget, now) : null, totalMb: budget?.totalMb ?? null }))
}

const answer = (text: string) => ({ result: text }) as never

/** A subagent loop and every loop above it: a worker holds the slot its own verification subagent uses. */
async function lineageOf($: EngineInterface, agentId: string): Promise<string[]> {
  const parents = new Map((await $.agent.list().catch(() => [])).map(a => [a.id, a.parentId] as const))
  const lineage = [agentId]
  for (let id = parents.get(agentId); id !== undefined && lineage.length < 8; id = parents.get(id)) lineage.push(id)
  return lineage
}

const ACCENT = '#d97757'
const WARN = '#f5a524'
const RULE = '#3e4451'
const GAUGE_CELLS = 10

const slotName = (s: Slot) => s.label || s.resource

async function releaseFromBand($: EngineInterface, slot: Slot): Promise<void> {
  const o = opsOf($)
  await release(o, slot.resource, { session: await o.id(), label: slot.label })
  await refreshBand($, o)
}

/** One line for the machine and the locks in use, then this session's buttons. */
function drawBand($: EngineInterface, e: RenderEvent, model: BandModel) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const filled = Math.round(model.gauge ? model.gauge.share * GAUGE_CELLS : 0)
  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap" columnGap={3}>
        <Text dimColor>verrous</Text>
        {model.gauge && (
          <Text key="gauge">
            <Text dimColor>machine </Text>
            <Text color={model.gauge.isFull ? WARN : ACCENT}>{'█'.repeat(filled)}</Text>
            <Text color={RULE}>{'░'.repeat(GAUGE_CELLS - filled)}</Text>
            <Text dimColor>{` ${model.gauge.freeGb} Go libres sur ${model.gauge.usableGb}`}</Text>
          </Text>
        )}
        {model.rows.map(r => (
          <Text key={`lock-${r.resource}`}>
            <Text dimColor={!r.isOwn}>{`${r.resource} `}</Text>
            <Text color={r.held > 0 ? ACCENT : RULE}>{'●'.repeat(Math.min(r.held, r.max))}</Text>
            <Text color={RULE}>{'○'.repeat(Math.max(0, r.max - r.held))}</Text>
            {r.holders.length > 0 && <Text dimColor>{` ${r.holders.join(', ')}`}</Text>}
            {r.queued > 0 && <Text color={WARN}>{` +${r.queued} en file`}</Text>}
          </Text>
        ))}
      </Box>
      {(model.held.length > 0 || model.queued.length > 0) && (
        <Box flexWrap="wrap" columnGap={2}>
          {model.held.map(s => (
            <Button key={`release-${s.resource}-${s.label}`} label={`Libérer ${slotName(s)}`} variant="secondary" onPress={() => releaseFromBand($, s)} />
          ))}
          {model.queued.map(s => (
            <Box key={`queued-${s.resource}-${s.label}`} columnGap={1}>
              <Text color={WARN}>{`en file #${s.position} ${slotName(s)}`}</Text>
              <Button key={`leave-${s.resource}-${s.label}`} label="Quitter la file" variant="secondary" onPress={() => releaseFromBand($, s)} />
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

/** The tool's answer to one call, from whichever loop made it. */
async function answerCall($: EngineInterface, e: { agentId?: string }): Promise<string> {
  const ownGrants: string[] = []
  const input = e as unknown as Input
  // Every subagent of a session shares its id: a slot taken with no label is labelled by its loop, never the session's.
  const o = { ...opsOf($), ownGrants, ...(e.agentId ? { agent: e.agentId } : {}) }
  const reply = await respond(o, e.agentId && !input.label ? { ...input, label: e.agentId } : input)
  await refreshBand($, o).catch(error => o.log(`machine-locks band: ${String(error)}`))
  return [reply, ...ownGrants].join('\n')
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const view = await read($, bandView)
    const model = view && bandModelOf(view)
    return model ? stackBands(below, 'machine-locks', drawBand($, e, model)) : below
  })

  on('engine.create', async (_$, e, next) => {
    const built = await next(e)
    const run: Ops['run'] = (argv, timeoutMs) => built.process.run(argv, { timeoutMs })
    const ops: Ops = {
      get: key => built.store.get(key),
      set: (key, value) => built.store.set(key, value),
      ...sharedFilesOf({ exists: file => built.fs.exists(file), read: file => built.fs.read(file), write: (file, text) => built.fs.write(file, text), run, env: () => built.process.hookEnv(), tag: () => built.session.id() }),
      now: () => built.clock.now(),
      sleep: ms => built.clock.sleep(ms),
      id: () => built.session.id(),
      name: async () => selfNameOf(await built.session.id(), () => built.session.cwd(), run),
      run,
      log: text => built.ui.log(text, { to: 'debug' }),
      tool: TOOL_ID,
      send: async (sessionId, text) => (await built.session.send({ to: { sessionId }, text })).isDelivered,
      sendAgent: async (agentId, text) => (await built.session.send({ to: { agentId }, text })).isDelivered,
      submit: text => built.prompt.submit({ text }),
      agents: () => claudeAgentsVia(run),
    }
    return { ...built, machineLocks: apiOf(ops) }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const o = opsOf($)
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
    })
    $.clock.every(ADMIT_MS, () => {
      void sweep(o)
        .then(() => refreshBand($, o))
        .catch(error => o.log(`machine-locks sweep: ${String(error)}`))
    })
    await refreshBand($, o).catch(error => o.log(`machine-locks band: ${String(error)}`))
    return started
  })

  // A failed hook is absent, and the call then reads as a tool nobody answers. Every action is safe to
  // ask twice, so the call is tried again, and what failed is said in the answer either way.
  on('tool.call', { tool: TOOL_ID }, async ($, e) => answer(await answerCall($, e))).catch(async ($, e, next) => {
    const failed = `${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}`
    try {
      return answer(`${await answerCall($, e)}\n(machine-locks answered on its second try; the first failed, ${failed})`)
    } catch (error) {
      return answer(`machine-locks could not answer, twice (${failed}; then ${String(error)}). The table may not have changed: call "list" to read it, then ask again.`)
    }
  })

  // Matching the command text, not what it runs: a script that boots a device passes, this only stops the slip.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)
    const reason = guardVerdictOf(await loadLocks(opsOf($)), command, await $.session.id(), TOOL_ID, e.agentId ? await lineageOf($, e.agentId) : undefined)
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
