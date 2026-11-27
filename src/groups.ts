import { agentKind, agentName } from './screen'
import { sameTerminal } from './engine'
import { unbound } from './inbox'
import type { Schedule, TerminalRef } from './engine'
import type { TerminalOption } from './protocol'

export type Group = { key: string; ref: TerminalRef; live: TerminalOption | null; recurring: Schedule[]; once: Schedule[] }

/** The block of a terminal reference. Schedules from the inbox that have no terminal yet share one block
 *  per workspace and agent — what their line shows. */
export const keyOf = (ref: TerminalRef, live: TerminalOption | null = null): string =>
  live?.leafId || ref.leafId || live?.handle || ref.handle || `none:${ref.workspaceId || ref.workspace}:${ref.agent}`

/** Schedules by terminal — a closed terminal keeps its block. */
export function groupsOf(list: Schedule[], open: TerminalOption[] | null): Group[] {
  const groups = new Map<string, Group>()
  for (const s of list) {
    const live = open?.find((t) => sameTerminal(t, s.terminal)) ?? null
    const key = keyOf(s.terminal, live)
    const g = groups.get(key) ?? { key, ref: live ?? s.terminal, live, recurring: [], once: [] }
    ;(s.once ? g.once : g.recurring).push(s)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.ref.workspace.localeCompare(b.ref.workspace) || a.ref.title.localeCompare(b.ref.title))
}

/** True when the search is empty or one of the texts contains it (`q` lower-cased). */
export const matches = (q: string, texts: string[]): boolean => !q || texts.some((t) => t.toLowerCase().includes(q))

export const terminalTexts = (t: TerminalRef): string[] => {
  const kind = agentKind(t.agent)
  return [t.title, t.workspace, kind ? agentName[kind] : t.agent]
}

/** A block whose terminal matches stays whole; otherwise it keeps only the schedules whose name — or, for
 *  one from the inbox, whose writer — matches. */
export function filterGroup(g: Group, q: string): Group | null {
  if (matches(q, terminalTexts(g.ref))) return g
  // Who wrote it into the inbox counts as well — "bot" finds what the bot added.
  const recurring = g.recurring.filter((s) => matches(q, [s.name, s.source?.by ?? '']))
  const once = g.once.filter((s) => matches(q, [s.name]))
  return recurring.length + once.length > 0 ? { ...g, recurring, once } : null
}

/** The block a schedule belongs to. */
export const holds = (g: Group, s: Schedule): boolean =>
  sameTerminal(g.ref, s.terminal) || (!!g.live && sameTerminal(g.live, s.terminal)) || (unbound(s.terminal) && g.key === keyOf(s.terminal))
