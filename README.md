# machine-locks

Locks on the exclusive resources of this machine, shared by every Claude Code session that loads the mod:
an iOS simulator or Android emulator, a local database, fixed ports, the machine's build capacity. Two
handoffs, two coordinator runs or two sessions started by hand that want the same resource queue for it
instead of colliding.

Every session gets the `mcp__machine-locks__locks` tool:

- `define` a resource with its capacity; with `memoryGb` and/or `cores` (what one slot uses) the capacity
  becomes a maximum, and every three minutes one session sets it from the machine's free memory and load,
  always leaving a fifth of the memory free;
- `acquire` answers granted, or queued with how many are ahead. A queued session stops there: when a slot
  frees, the session that frees it sends it `GRANTED <resource>` directly, which wakes it;
- `release` frees the slot and tells the next in line; `list` and `remove` do what they say.

A slot is held by a session (its id, its name as `claude agents` lists it, and an optional label such as
a task id). A session that exits (`/exit`, `/clear`, logout) frees its slots. A background session paused
by its supervisor keeps them, since a message brings it back; a holder whose session is gone or failed is
freed by the sweep as soon as someone waits on its lock, and a GRANTED that reaches nobody passes the slot
on. A session that has held a slot for 45 minutes is asked, once per hold, whether it still needs it.

Other mods use the table through `$.machineLocks` (`list`, `release`, `releaseSession`), typed by
`types/index.d.ts`, after listing `machine-locks` under `dependencies` in their `plugin.json`: run-board
draws the table on its board and frees a task's slots when the task merges or its worker is gone.

The mod loads from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, with `~/.claude/mods/machine-locks`
at its end.
