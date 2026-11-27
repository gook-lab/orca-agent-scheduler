// Schedules that come from outside the panel. A bot or an agent that was asked for a schedule writes one
// JSON file into the inbox folder (~/.orca-agent-scheduler/inbox); the worker reads the folder at every
// check and keeps one schedule per item id. The folder is only read — the writer owns its files, and the
// last item applied per id is remembered in the plugin's storage instead (README "Inbox").
import { type LiveTerminal, type Schedule, type TerminalRef, blankSchedule, blankTerminal, nextAfter, sameTerminal } from './engine'
import { parseCron } from './cron'
import { agentKind } from './screen'

/** Where the prompt should go: a workspace and an agent, since the writer has no terminal to point at. */
export type Target = {
  /** The workspace's folder (or a folder inside it), or its Orca workspace id. */
  workspace: string
  /** claude · codex · gemini. */
  agent: string
  /** Narrows it to the terminal with this title; '' = any. */
  title: string
}

/** One file of the inbox, as the README gives the format. */
export type Item = {
  /** The writer's own id for this schedule — the same id again replaces, `deleted` removes. */
  id: string
  /** Who wrote it, as the panel shows it ('' = not said). */
  source: string
  name: string
  cron: string
  prompt: string
  target: Target
  /** Start a new conversation (Schedule.clearFirst). */
  newConversation: boolean
  /** Ask for a one-line result (Schedule.report). */
  askResult: boolean
  enabled: boolean
}

/** Why a file was passed by — worded by src/i18n.ts for the log and Settings. */
export type ProblemCode = 'unreadable' | 'json' | 'id' | 'name' | 'cron' | 'never' | 'prompt' | 'workspace' | 'agent' | 'duplicate'

export type Entry = { file: string } & ({ item: Item } | { remove: string } | { problem: ProblemCode })

/** The last thing applied per item id: the item, or that it was deleted. Kept in storage. */
export type Seen = Record<string, { item: Item } | { deleted: true }>

export type Workspace = { id: string; name: string; path: string }

/** What a target is matched against. `terminals` is null when the list could not be read. */
export type Places = { workspaces: Workspace[]; terminals: LiveTerminal[] | null; home: string }

export const ID_MAX = 200

/** The id a schedule from the inbox gets here. */
export const inboxId = (id: string): string => `inbox-${id}`

/** No terminal yet — a schedule that came in before a terminal matched its target. */
export const unbound = (t: Pick<TerminalRef, 'handle' | 'leafId'>): boolean => !t.handle && !t.leafId

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** An item read field by field, or what is wrong with it. `now` decides whether its times ever come. */
export function itemFrom(value: unknown, now: number): Item | ProblemCode {
  const v = record(value)
  const id = text(v?.id).trim()
  if (!v || !id || id.length > ID_MAX) return 'id'
  const name = text(v.name).trim()
  if (!name) return 'name'
  const cron = text(v.cron).trim()
  if (!parseCron(cron)) return 'cron'
  if (nextAfter(cron, now) === null) return 'never'
  const prompt = text(v.prompt)
  if (!prompt.trim()) return 'prompt'
  const t = record(v.target)
  const workspace = trimSlash(text(t?.workspace).trim())
  if (!workspace) return 'workspace'
  const agent = agentKind(text(t?.agent).trim())
  if (!agent) return 'agent'
  return {
    id,
    source: text(v.source).trim().slice(0, 60),
    name,
    cron,
    prompt,
    target: { workspace, agent, title: text(t?.title).trim() },
    newConversation: v.newConversation === true,
    // On unless the file says no — as a new schedule in the form.
    askResult: v.askResult !== false,
    enabled: v.enabled !== false
  }
}

/** The folder's files as entries, in file-name order. `text` is null for what is not a plain file of a
 *  sane size. An id in two files counts once — the first file's. */
export function entriesFrom(files: { file: string; text: string | null }[], now: number): Entry[] {
  const ids = new Set<string>()
  return [...files]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, text: body }): Entry => {
      if (body === null) return { file, problem: 'unreadable' }
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        return { file, problem: 'json' }
      }
      const v = record(value)
      const id = text(v?.id).trim()
      if (!v || !id || id.length > ID_MAX) return { file, problem: 'id' }
      if (ids.has(id)) return { file, problem: 'duplicate' }
      ids.add(id)
      if (v.deleted === true) return { file, remove: id }
      const item = itemFrom(v, now)
      return typeof item === 'string' ? { file, problem: item } : { file, item }
    })
}

/** What storage holds, read as loosely as the schedules are. */
export function seenFrom(value: unknown): Seen {
  const out: Seen = {}
  for (const [id, v] of Object.entries(record(value) ?? {})) {
    const r = record(v)
    if (r?.deleted === true) out[id] = { deleted: true }
    else {
      // Its times may have passed since — it is still what was applied.
      const item = itemFrom(r?.item, 0)
      if (typeof item !== 'string') out[id] = { item }
    }
  }
  return out
}

/**
 * The terminal a target names: the one terminal in that workspace running that agent (with that title,
 * when one is given). None, or more than one, and the reference comes back without a terminal — the card
 * then asks the person to pick. Nothing is guessed between two: with "Start a new conversation" the wrong
 * guess would erase a conversation.
 */
export function terminalFor(target: Target, places: Places): TerminalRef {
  const asked = target.workspace
  const path = trimSlash(asked === '~' || asked.startsWith('~/') ? `${places.home}${asked.slice(1)}` : asked)
  let held = places.workspaces.filter((w) => w.id === asked || (w.path && trimSlash(w.path) === path))
  if (held.length === 0) {
    // A writer inside a subfolder gives its own folder: the workspace that holds it, the deepest one.
    const around = places.workspaces.filter((w) => w.path && path.startsWith(`${trimSlash(w.path)}/`))
    const deepest = Math.max(0, ...around.map((w) => trimSlash(w.path).length))
    held = around.filter((w) => trimSlash(w.path).length === deepest)
  }
  const ids = new Set(held.map((w) => w.id))
  const kind = agentKind(target.agent)
  const title = target.title.toLowerCase()
  const fits = (places.terminals ?? []).filter(
    (t) => ids.has(t.workspaceId) && agentKind(t.agent) === kind && (!title || t.title.trim().toLowerCase() === title)
  )
  const nameOf = (id: string): string | undefined => held.find((w) => w.id === id)?.name
  const none: TerminalRef = {
    ...blankTerminal(),
    title: target.title,
    agent: target.agent,
    workspaceId: held[0]?.id ?? '',
    workspace: held[0]?.name ?? path.split('/').filter(Boolean).pop() ?? asked
  }
  if (fits.length !== 1) return none
  const [t] = fits
  return { handle: t.handle, title: t.title, agent: t.agent as string, workspaceId: t.workspaceId, workspace: nameOf(t.workspaceId) ?? none.workspace, tabId: t.tabId, leafId: t.leafId }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export type SyncResult = { list: Schedule[]; seen: Seen; added: Schedule[]; log: string[] }

/**
 * Brings the schedules in line with the inbox. Schedules already in `list` are changed in place.
 *
 * - An item whose id is new adds a schedule; one that reads the same as last time does nothing, so what a
 *   person edited — or deleted — in the panel stands until the writer changes the file.
 * - A changed item replaces only the fields whose value in the file changed. A field the writer left as it
 *   was keeps the person's edit.
 * - `deleted` removes the schedule.
 * - A schedule still without a terminal takes the one its target names once exactly one is open.
 *
 * `places` is asked for only when a target has to be matched.
 */
export async function sync(list: Schedule[], seen: Seen, entries: Entry[], places: () => Promise<Places>, now: number): Promise<SyncResult> {
  let out = list
  const next: Seen = { ...seen }
  const added: Schedule[] = []
  const log: string[] = []
  const from = (s: Schedule): string => s.source?.by || 'inbox'

  for (const e of entries) {
    if ('problem' in e) continue
    if ('remove' in e) {
      const prev = next[e.remove]
      if (prev && 'deleted' in prev) continue
      const had = out.find((s) => s.source?.id === e.remove)
      if (had) {
        out = out.filter((s) => s !== had)
        log.push(`${had.name}: removed by ${from(had)} (${e.file})`)
      }
      next[e.remove] = { deleted: true }
      continue
    }
    const { item } = e
    const prev = next[item.id]
    const before = prev && 'item' in prev ? prev.item : null
    if (before && same(before, item)) continue
    const s = out.find((x) => x.source?.id === item.id)
    if (!s) {
      const fresh: Schedule = {
        ...blankSchedule(inboxId(item.id)),
        name: item.name,
        terminal: terminalFor(item.target, await places()),
        cron: item.cron,
        prompt: item.prompt,
        enabled: item.enabled,
        clearFirst: item.newConversation,
        report: item.askResult,
        nextRunAt: item.enabled ? nextAfter(item.cron, now) : null,
        source: { id: item.id, by: item.source }
      }
      out = [...out, fresh]
      added.push(fresh)
      log.push(`${fresh.name}: added by ${from(fresh)} (${e.file})${unbound(fresh.terminal) ? ' — no terminal yet' : ` → ${fresh.terminal.title}`}`)
    } else {
      const changed = (k: keyof Item): boolean => !before || !same(before[k], item[k])
      // Its end is read off the terminal it was sent to — the file is applied once the run has ended.
      if (changed('target') && s.sentAt !== null) continue
      if (changed('name')) s.name = item.name
      if (changed('prompt')) s.prompt = item.prompt
      if (changed('newConversation')) s.clearFirst = item.newConversation
      if (changed('askResult')) s.report = item.askResult
      if (changed('cron')) s.cron = item.cron
      if (changed('enabled')) {
        s.enabled = item.enabled
        if (!s.enabled) {
          s.pendingSince = null
          s.waitNote = null
        }
      }
      if (changed('cron') || changed('enabled')) s.nextRunAt = s.enabled ? nextAfter(s.cron, now) : null
      if (changed('target')) {
        const ref = terminalFor(item.target, await places())
        if (!sameTerminal(ref, s.terminal)) {
          s.terminal = ref
          // A /clear typed into the old terminal says nothing about the new one.
          s.clearedFor = null
        }
      }
      s.source = { id: item.id, by: item.source }
      log.push(`${s.name}: updated by ${from(s)} (${e.file})`)
    }
    next[item.id] = { item }
  }

  for (const s of out) {
    const last = s.source ? next[s.source.id] : undefined
    if (!last || !('item' in last) || !unbound(s.terminal)) continue
    const ref = terminalFor(last.item.target, await places())
    if (unbound(ref)) continue
    s.terminal = ref
    log.push(`${s.name}: found its terminal → ${ref.title}`)
  }

  // A file that could not be read may be the one an id here belongs to — forget ids only on a clean read.
  // Forgotten too early, a schedule a person deleted in the panel would come back with the next read.
  if (!entries.some((e) => 'problem' in e)) {
    const filed = new Set(entries.map((e) => ('item' in e ? e.item.id : 'remove' in e ? e.remove : '')))
    for (const id of Object.keys(next)) if (!filed.has(id) && !out.some((s) => s.source?.id === id)) delete next[id]
  }
  return { list: out, seen: next, added, log }
}
