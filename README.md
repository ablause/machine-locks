# machine-locks

Locks on the exclusive resources of this machine, shared by every Claude Code session that loads the mod:
an iOS simulator or Android emulator, a local database, fixed ports, the machine's build capacity. Two
handoffs, two coordinator runs or two sessions started by hand that want the same resource queue for it
instead of colliding.

Every session gets the `mcp__machine-locks__locks` tool:

- `define` a resource with its capacity. With `memoryGb` and/or `cores`, what one slot uses, the resource is
  budgeted: its capacity becomes its own maximum, and its slots are granted from the machine's free memory and
  idle cores, which every budgeted resource shares. Six iOS simulators or two simulators and two emulators: the
  machine decides, not a count per kind. A fifth of the memory always stays free, and a slot granted less than
  three minutes ago counts as used until its device has booted, whatever its kind;
- `acquire` answers granted, or queued with how many are ahead. A queued session stops there: when a slot
  frees, the session that frees it sends it `GRANTED <resource>` directly, which wakes it. Budgeted resources
  share one line, served in the order sessions asked: the first that does not fit holds the others back, so an
  emulator is never passed forever by cheaper simulators. Memory frees as a device shuts down rather than at its
  release, so the line is checked again every thirty seconds while someone waits;
- `release` frees the slot and tells the next in line; `list` and `remove` do what they say;
- `history` gives, per resource, how many holds, how many queued first, and the median and 90th percentile wait
  and hold in minutes, over the last 500 slots released: what to set a capacity or `memoryGb` from.

Bash checks every command against the locks before it runs. A command a lock `needs` runs only in a session that
holds a slot of it; a command it `forbids` never runs, since it acts on every session's instance at once. Without a
`guard` of its own, `ios-simulator` watches `device up ios` and `simctl boot|create|clone` and forbids
`simctl … all`, `simctl … booted` and `killall Simulator`; `android-emulator` watches `device up android` and
`emulator -avd` and forbids `adb kill-server` and killing every emulator. The check reads the command text: it stops
the slip, not a script that boots a device, and a guard that fails lets the command run.

Every change of the table holds `/tmp/claude-machine-locks.mutex`, made by `mkdir`, so two sessions that acquire at
once never overwrite each other; one left by a session killed mid-change is taken over after ten seconds.

A band above the prompt shows while this session holds or waits on a slot, or while sessions wait on the
machine: the memory left for budgeted slots, each lock in use with its holders (this session's first, with how
long it has held), this session's place in line, and buttons to release a slot or leave the line.

A slot is held by a session (its id, its name as `claude agents` lists it, and an optional label such as
a task id). A session that exits (`/exit`, `/clear`, logout) frees its slots. A background session paused
by its supervisor keeps them, since a message brings it back; a holder whose session is gone or failed is
freed by the sweep as soon as someone waits on its lock, and a GRANTED that reaches nobody passes the slot
on. A session that has held a slot for 45 minutes is asked, once per hold, whether it still needs it.

Other mods use the table through `$.machineLocks` (`list`, `release`, `releaseSession`), typed by
`types/index.d.ts`: run-board draws the table on its board and frees a task's slots when the task merges
or its worker is gone. It does not list `machine-locks` under `dependencies`, because a plugin whose
dependency is missing does not load at all: a session started without this mod keeps its board, with no
locks on it.

The mod loads from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, with `~/.claude/mods/machine-locks`
at its end.
