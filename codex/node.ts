import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sharedDirOf } from '../hooks/engine'
import type { Ops, Run } from '../hooks/engine'

export const run: Ops['run'] = (argv, timeoutMs) =>
  new Promise<Run>(resolve =>
    execFile(argv[0] ?? '', argv.slice(1), { timeout: timeoutMs }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code
      resolve({ exitCode: error ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout ?? '') })
    }),
  )

/** The table's files, the same the Claude Code mod reads: a write lands whole, by a rename. */
export function nodeFiles(dir = sharedDirOf(process.env)): Pick<Ops, 'readShared' | 'writeShared'> {
  return {
    readShared: async name => {
      const file = join(dir, `${name}.json`)
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    },
    writeShared: async (name, value) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `${name}.json`)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value))
      renameSync(tmp, file)
    },
  }
}

/**
 * The nearest `codex` process above this one: the session the MCP server and the Bash hook both run under, since
 * Codex hands neither of them its session id. It lives as long as the session, which is what a holder's pid stands for.
 */
export async function codexPidOf(from = process.pid): Promise<number> {
  let pid = from
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const ps = await run(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], 2000)
    const found = /^\s*(\d+)\s+(.+?)\s*$/.exec(ps.stdout)
    if (!found) break
    if (pid !== from && /(^|\/)codex[^/]*$/.test(found[2] ?? '')) return pid
    pid = Number(found[1])
  }
  return process.ppid
}

export const sessionOf = (pid: number) => `codex:${pid}`

/** How Codex names this server's tool to the model. */
export const CODEX_TOOL = 'the machine-locks `locks` tool'
