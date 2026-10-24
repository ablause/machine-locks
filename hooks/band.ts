import type { MachineLocksBandView } from '../types'
import { budgetQueueOf, MEMORY_FLOOR } from './table'


/** What the band draws, as the last refresh of this session saw the machine. */
export type BandView = MachineLocksBandView

export type Slot = { resource: string; label: string }

export type BandModel = {
  gauge: { freeGb: number; usableGb: number; share: number; isFull: boolean } | null
  rows: { resource: string; held: number; max: number; isOwn: boolean; holders: string[]; queued: number }[]
  held: Slot[]
  queued: (Slot & { position: number })[]
}

const gbOf = (mb: number) => Math.round(mb / 102.4) / 10
const minutesOf = (ms: number) => `${Math.max(0, Math.floor(ms / 60_000))} min`

/**
 * The band is drawn only while it matters to this session: it holds or waits on a slot, or sessions wait on the
 * machine's budget. Otherwise null, and nothing is drawn above the prompt.
 */
export function bandModelOf(view: BandView): BandModel | null {
  const { locks, session, at } = view
  const held: Slot[] = []
  const queued: (Slot & { position: number })[] = []
  const line = budgetQueueOf(locks)
  for (const [resource, lock] of Object.entries(locks)) {
    for (const h of lock.holders) if (h.session === session) held.push({ resource, label: h.label ?? '' })
    lock.queue.forEach((h, i) => {
      if (h.session !== session) return
      const inLine = line.findIndex(w => w.resource === resource && w.holder.session === session && (w.holder.label ?? '') === (h.label ?? ''))
      queued.push({ resource, label: h.label ?? '', position: (inLine >= 0 ? inLine : i) + 1 })
    })
  }
  if (held.length === 0 && queued.length === 0 && line.length === 0) return null
  const rows = Object.entries(locks)
    .filter(([, l]) => l.holders.length > 0 || l.queue.length > 0)
    .map(([resource, l]) => {
      const own = l.holders.filter(h => h.session === session).map(h => `toi${h.label ? ` ${h.label}` : ''}${h.since === undefined ? '' : `, ${minutesOf(at - h.since)}`}`)
      const others = l.holders.filter(h => h.session !== session).map(h => h.name)
      return { resource, held: l.holders.length, max: l.scale?.max ?? l.capacity, isOwn: own.length > 0, holders: [...own, ...others], queued: l.queue.length }
    })
  const cheapest = Math.min(...Object.values(locks).flatMap(l => (l.scale?.memoryMb ? [l.scale.memoryMb] : [])))
  const usableMb = view.totalMb === null ? 0 : view.totalMb * (1 - MEMORY_FLOOR)
  const freeMb = Math.min(usableMb, Math.max(0, view.room?.memoryMb ?? 0))
  const gauge =
    view.room && usableMb > 0 && Number.isFinite(cheapest)
      ? { freeGb: gbOf(freeMb), usableGb: gbOf(usableMb), share: 1 - freeMb / usableMb, isFull: freeMb < cheapest }
      : null
  return { gauge, rows, held, queued }
}
