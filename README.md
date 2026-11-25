# machine-locks

Queues coding-agent sessions for the exclusive resources of one machine: an iOS simulator, an Android
emulator, a local database, a fixed port, build capacity. When two worktrees, two background agents or two
sessions started by hand want the same resource, one of them waits in line instead of colliding with the
other. Claude Code sessions and [Codex](#codex) sessions share the same line.

What it adds to every Claude Code session that loads the mod:

- one tool, `mcp__machine-locks__locks`, to define, acquire and release a resource;
- a wake-up: a queued session ends its turn, and the session that frees the slot sends it `GRANTED <resource>`
  directly, so nobody polls;
- slots sized by the machine: a resource can say what one slot uses in memory and cores, and slots are then
  granted from what the machine has free, shared across every resource defined that way;
- Bash guards: a command that needs a slot runs only in a session that holds one, and a command that acts on
  every session's instance at once (`simctl shutdown all`, `adb kill-server`) never runs;
- a band above the prompt with what this session holds or waits on, and buttons to release a slot or leave
  the line;
- cleanup: a session that exits frees its slots, and a holder whose session is gone is freed as soon as
  someone waits on its lock.

## Requirements

- Claude Code 2.1.326 or later, which provides the mods API (`$.tool`, `$.session.send`, `$.fs`, bands).
- For Codex: Codex CLI with hooks (0.124 or later) and Node.js 22.18 or later, which runs the TypeScript
  sources as they are.
- macOS or Linux. Memory and load come from `sysctl` and `memory_pressure` on macOS, and from `/proc` and
  `nproc` on Linux. Without either, plain capacity counts still work and budgeted resources are not granted
  from the machine's free memory.

## Install

```sh
claude plugin marketplace add ablause/machine-locks
claude plugin install machine-locks@machine-locks
```

Every session started afterwards loads the mod. To work on it from a checkout instead, add the checkout's
folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

## Use

Claude calls the tool itself once a skill, a `CLAUDE.md` line or a prompt tells it which resource a task
needs. For example:

```text
Before booting a simulator, acquire the ios-simulator lock through mcp__machine-locks__locks,
and release it when you are done with the device.
```

The actions:

- `define` a resource with its `capacity`. Add `memoryGb` and/or `cores`, what one slot uses, and the
  resource is budgeted: its capacity becomes its own maximum, and its slots come from the machine's free
  memory and idle cores. Six simulators, or two simulators and two emulators: the machine decides, not a
  count per kind. A fifth of the memory always stays free, and a slot granted less than three minutes ago
  counts as used until its device has booted. Add `guard` to list the commands that need a slot (`needs`) or
  must never run (`forbid`), as regular expressions.
- `acquire` answers granted, or queued with how many sessions are ahead. Budgeted resources share one line,
  served in the order sessions asked, so an emulator is never passed forever by cheaper simulators. The line
  is checked again every thirty seconds while someone waits, since memory frees as a device shuts down
  rather than at its release.
- `release` frees the slot and tells the next session in line. `list` and `remove` do what they say.
- `history` gives, per resource, how many holds, how many queued first, and the median and 90th percentile
  wait and hold in minutes over the last 500 released slots: what to size a capacity or `memoryGb` on.

A slot is held by a session (its id, its name as `claude agents` lists it, and an optional label such as a
task id). Subagents of a session share its id: a slot one of them takes is labelled by its own loop, the
`GRANTED` for it goes to that loop, and a guarded command passes only for that loop and the subagents it
spawned. A background session paused by its supervisor keeps its slots, since a message brings it back. A
session that has held a slot for 45 minutes is asked, once per hold, whether it still needs it.

### Default guards

`ios-simulator` and `android-emulator`, when defined without a guard of their own, watch the usual CLIs:

| Resource           | Needs a slot                                           | Never runs                                                     |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| `ios-simulator`    | `simctl boot`, `simctl create`, `simctl clone`, `device up ios` | `simctl … all`, `simctl … booted`, `killall Simulator` |
| `android-emulator` | `emulator -avd`, `emulator @`, `device up android`     | `adb kill-server`, killing every emulator                      |

`device up` is the boot command of [agent-device](https://github.com/callstack/agent-device). The
guard reads the command text: it stops a slip, not a script that boots a device on its own, and a guard
that fails lets the command run.

## Codex

Codex loads the same lock engine as an MCP server, and the same Bash guards as a `PreToolUse` hook. Both read
and write the table the mod uses, so a Codex session and a Claude Code session queue for one simulator
together. From a clone of this repository, add to `~/.codex/config.toml`:

```toml
[mcp_servers.machine-locks]
command = "node"
args = ["/path/to/machine-locks/codex/server.mjs"]
# An acquire waits for its slot inside the call: give it longer than MACHINE_LOCKS_WAIT_SEC (1500 by default).
tool_timeout_sec = 1800
default_tools_approval_mode = "approve"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "node /path/to/machine-locks/codex/guard.mjs"
```

Codex runs a hook only once you have trusted it: review and trust this one in Codex after adding it.

Codex cannot be woken by a message, so it works differently from the mod in three ways:

- `acquire` holds the call until the slot is granted, sending progress notifications meanwhile. Past
  `MACHINE_LOCKS_WAIT_SEC` it answers still queued, the place in line kept, and the same call goes on waiting.
- Codex hands its MCP servers no session id, so a Codex session is known by its `codex` process, which the
  server and the hook both find among their parents. A holder is alive while that process runs. One Codex
  process that hosts several conversations at once (the desktop app) counts as one session.
- There is no band, and no reminder after a long hold.

A Claude Code session granted a slot by a Codex release is not messaged at once: its own sweep, every thirty
seconds, sends it the `GRANTED`.

## How it works

The table and the history of released slots live in `~/.local/state/machine-locks` (`MACHINE_LOCKS_DIR`
overrides it), written whole through a rename, so every Claude Code and Codex session on the machine reads the
same one. Every change holds `/tmp/claude-machine-locks.mutex`, created by `mkdir`; one left by a session killed
mid-change is taken over after ten seconds. The pure logic (queue, budget, guards, history) is in
`hooks/table.ts`, the lock engine that runs it against a host in `hooks/engine.ts`; `hooks/register.tsx` wires
it to Claude Code's tool, hooks and band, and `codex/` to Codex.

Other mods can read and change the table through `$.machineLocks` (`list`, `release`, `releaseSession`),
typed by `types/index.d.ts`, for instance to draw the locks on a board or to free a task's slots when its
worker is gone. Such a mod should not list `machine-locks` under `dependencies`: a plugin whose dependency
is missing does not load at all, so it would disappear from sessions started without this mod.

## Development

```sh
claude plugin test .
```

The tests import `claude-code/testing`, which only exists under that runner: `bun test` alone cannot
resolve it.

## License

MIT
