# machine-locks

A Claude Code mod that queues sessions for the exclusive resources of one machine: an iOS simulator, an
Android emulator, a local database, a fixed port, build capacity. When two worktrees, two background agents
or two sessions started by hand want the same resource, one of them waits in line instead of colliding with
the other.

What it adds to every session that loads it:

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

- Claude Code 2.1.326 or later, which provides the mods API (`$.tool`, `$.session.send`, `$.store`, bands).
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

## How it works

The table lives in the mod store that every session on the machine shares. `$.store` has no compare-and-set
across processes, so every change holds `/tmp/claude-machine-locks.mutex`, created by `mkdir`; one left by a
session killed mid-change is taken over after ten seconds. The pure logic (queue, budget, guards, history)
is in `hooks/table.ts`; `hooks/register.tsx` wires it to the tool, the hooks and the band.

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
