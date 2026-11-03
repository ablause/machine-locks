// Band stacking, after hamzafer/claude-code-mods shared/bands.ts (MIT).
//   Every band mod (~/.claude/mods/*, skills/clickup-ticket) ships this same file: edit one, copy it over the others.
//   Each mod wraps its band in a Box keyed `band:<name>` and returns one column keyed `bands`;
//   the next band mod unpacks that column, adds its own band and sorts again, so the last one
//   to draw sorts them all, whatever order the mods loaded in.
import type { RenderElement, RenderNode } from 'claude-code'

/** Top to bottom: the last sits right above the prompt. One blank line separates two bands, none sits inside one. */
export const ORDER = ['machine-locks', 'clickup-flow', 'pr-lifecycle', 'review-nudge', 'voir', 'attente', 'where-we-are']

const COLUMN = 'bands'
const PREFIX = 'band:'

export function stackBands(rest: RenderElement | null | undefined, name: string, mine: RenderNode): RenderElement {
  const own: RenderElement = { type: 'Box', props: { key: PREFIX + name, flexDirection: 'column', marginTop: 1 }, children: [mine] }
  return { type: 'Box', props: { key: COLUMN, flexDirection: 'column' }, children: sorted([own, ...unpack(rest)]) }
}

function unpack(rest: RenderElement | null | undefined): RenderNode[] {
  if (!rest) return []
  if (!isColumn(rest)) return [rest]
  const owner = rest.part?.plugin
  // The engine stamps the column with its owner: that stamp belongs on the owner's own band.
  return (rest.children ?? []).map(k => (owner && typeof k !== 'string' && bandName(k) === owner && !('part' in k && k.part) ? { ...k, part: rest.part } : k))
}

function isColumn(el: RenderElement): el is RenderElement & { type: 'Box' } {
  return el.type === 'Box' && el.props?.key === COLUMN
}

function bandName(node: RenderNode): string | undefined {
  if (typeof node === 'string' || node.type !== 'Box') return undefined
  const key = node.props?.key
  return typeof key === 'string' && key.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined
}

/** What is no band (the engine's own rows) stays first; bands follow in ORDER. */
function sorted(items: RenderNode[]): RenderNode[] {
  const rank = (n: RenderNode) => {
    const name = bandName(n)
    return name === undefined ? -1 : ORDER.indexOf(name)
  }
  return items.map((n, i) => ({ n, i, r: rank(n) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.n)
}
