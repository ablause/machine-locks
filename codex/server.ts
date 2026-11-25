import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { INPUT_SCHEMA, releaseSession, respond } from '../hooks/engine'
import type { Input, Ops } from '../hooks/engine'
import { CODEX_TOOL, codexPidOf, nodeFiles, run, sessionOf } from './node'

/** How long one acquire call waits before answering still queued: under the server's tool_timeout_sec in config.toml. */
const WAIT_MS = Number(process.env.MACHINE_LOCKS_WAIT_SEC ?? 1500) * 1000

const DESCRIPTION = `Exclusive resources shared by every Codex and Claude Code session on this machine (a simulator or device, a local database, fixed ports, build capacity), so two sessions never use one at once.
Actions: "list" (every resource with its capacity, holders and queue); "history" (per resource, how often a slot was queued for and how long slots waited and were held); "define" (resource, capacity; add memoryGb and/or cores, what one slot uses, to grant slots from the machine's free memory and cores; add guard to have Bash refuse the commands that need a slot, or that act on every session's instance at once); "acquire" (resource, label: answers once the slot is yours; it can take minutes while another session holds it, and if it answers still queued, call it again with the same resource and label to keep your place); "release" (resource, label: frees your slot as soon as you are done, and the next session in line gets it); "remove" (resource, refused while another session holds or waits on it).
"label" says what the slot is for, such as a task id. Every slot of this session is freed when it exits.`

const INSTRUCTIONS = `Before you boot a simulator or emulator, use a shared local database or bind a fixed port, acquire the matching resource through the locks tool, and release it as soon as you are done. Never use a resource while acquire answers queued.`

const pid = await codexPidOf()
const session = sessionOf(pid)
const scratch = new Map<string, unknown>()

const ops: Ops = {
  get: async key => scratch.get(key),
  set: async (key, value) => void scratch.set(key, value),
  ...nodeFiles(),
  now: async () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  id: async () => session,
  name: async () => `codex ${basename(process.cwd())}`,
  run,
  log: text => void process.stderr.write(`${text}\n`),
  tool: CODEX_TOOL,
  pid,
  waitMs: WAIT_MS,
}

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> }

const send = (message: object) => void process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id: Message['id'], result: object) => send({ jsonrpc: '2.0', id, result })

async function callTool(id: Message['id'], params: Record<string, unknown>): Promise<void> {
  if (params.name !== 'locks') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } })
  const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
  let ticks = 0
  const ownGrants: string[] = []
  const callOps: Ops = {
    ...ops,
    ownGrants,
    ...(token === undefined ? {} : { progress: (message: string) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message } }) }),
  }
  try {
    const text = await respond(callOps, (params.arguments ?? {}) as Input)
    reply(id, { content: [{ type: 'text', text: [text, ...ownGrants].join('\n') }], isError: false })
  } catch (error) {
    reply(id, { content: [{ type: 'text', text: `machine-locks could not answer (${String(error)}). Call "list" to read the table, then ask again.` }], isError: true })
  }
}

function handle(message: Message): void {
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'machine-locks', version: '0.2.0' },
      instructions: INSTRUCTIONS,
    })
  }
  if (method === 'tools/list') return reply(id, { tools: [{ name: 'locks', description: DESCRIPTION, inputSchema: INPUT_SCHEMA }] })
  if (method === 'tools/call') return void callTool(id, params)
  if (method === 'ping') return reply(id, {})
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported: ${method}` } })
}

// A session that ends frees its slots; one killed outright is freed by the next waiter's sweep, once its process is gone.
let isClosing = false
async function close(): Promise<void> {
  if (isClosing) return
  isClosing = true
  await releaseSession(ops, session).catch(error => ops.log(`machine-locks end: ${String(error)}`))
  process.exit(0)
}

createInterface({ input: process.stdin })
  .on('line', line => {
    if (!line.trim()) return
    try {
      handle(JSON.parse(line) as Message)
    } catch (error) {
      ops.log(`machine-locks: unreadable message (${String(error)})`)
    }
  })
  .on('close', () => void close())
process.on('SIGTERM', () => void close())
process.on('SIGINT', () => void close())
