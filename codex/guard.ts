import { loadLocks } from '../hooks/engine'
import type { Ops } from '../hooks/engine'
import { guardVerdictOf } from '../hooks/table'
import { CODEX_TOOL, codexPidOf, nodeFiles, sessionOf } from './node'

/**
 * Codex's PreToolUse hook on Bash: the same check the Claude Code mod runs, against the same table. It reads the
 * command text, so it stops the slip, not a script that boots a device; and a guard that fails lets the command run.
 */
async function verdict(): Promise<string | null> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool_input?: { command?: unknown } }
  const command = input.tool_input?.command
  if (typeof command !== 'string') return null
  const reader = { ...nodeFiles(), get: async () => undefined } as unknown as Ops
  const session = sessionOf(await codexPidOf())
  return guardVerdictOf(await loadLocks(reader), command, session, CODEX_TOOL, undefined, false)
}

try {
  const reason = await verdict()
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
} catch (error) {
  process.stderr.write(`machine-locks guard: ${String(error)}\n`)
}
