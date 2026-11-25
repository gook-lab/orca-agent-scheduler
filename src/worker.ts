// Schedule worker. It owns a status bar item, so it keeps running while the plugin is on (checks every 30 s).
// Schedules live in storage 'schedules' and only this file edits them; the panel asks by request and hears by post.
// The terminal list and sending go through the Orca CLI (why: src/cli.ts).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { type CliRunner, cliRunner, findCli, holdAgents, runCheck, sendArgs, sentFrom, terminalsFrom } from './cli'
import {
  askedSoon,
  blankSchedule,
  blankTerminal,
  type CheckResult,
  inspectOnEvent,
  type Io,
  limits,
  locate,
  needsAttention,
  newMemory,
  nextAfter,
  type Notice,
  onAgentStatus,
  type RunRecord,
  sameTerminal,
  type Schedule,
  type StatusEvent,
  type TerminalRef,
  tick
} from './engine'
import { type Lang, langOf, lateText, type Note, noteText, type Status, statuses, statusText, words } from './i18n'
import { importedId, itemsFrom, scheduleFrom } from './orcacron'
import { type ImportList, LANG_KEY, type RunnerStatus, type ScheduleDraft, type TerminalOption } from './protocol'
import { isWebLink } from './report'
import { agentKind } from './screen'
import { messageOf } from './text'
import { clock } from './timespec'

export const KEY = 'schedules'
export const TICK_MS = 30_000
/** Wait after a stop event before reading the screen — a question dialog is drawn a moment after the first event. */
export const SETTLE_MS = 1500
export const TITLE = 'Agent Scheduler'

/** Finished one-off sends kept as records; older ones are dropped. */
export const ONCE_KEEP = 20

type HostError = Error & { code?: string }

/** Screen-read errors to retry on the next check — busy, timeout, consent while the plugin reloads. */
const transientRead = new Set(['rate_limited', 'unavailable', 'timeout', 'consent_required'])

function invalid(message: string): HostError {
  const e: HostError = new Error(message)
  e.code = 'invalid_params'
  return e
}

const isNote = (v: unknown): v is Note => typeof v === 'object' && v !== null && typeof (v as Note).code === 'string'
const isStatus = (v: unknown): v is Status => (statuses as readonly unknown[]).includes(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function recordFrom(v: unknown): RunRecord | null {
  const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const at = time(r.at)
  if (at === null || !isStatus(r.status)) return null
  const tookMs = time(r.tookMs)
  const lateMs = time(r.lateMs)
  return {
    at,
    status: r.status,
    ...(tookMs !== null ? { tookMs } : {}),
    ...(isNote(r.note) ? { note: r.note } : {}),
    ...(lateMs !== null ? { lateMs } : {}),
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    ...(typeof r.link === 'string' && isWebLink(r.link) ? { link: r.link } : {})
  }
}

/** A terminal reference read field by field — what is not text stays empty. */
function terminalFrom(value: unknown): TerminalRef {
  const from = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const terminal = blankTerminal()
  for (const k of Object.keys(terminal) as (keyof TerminalRef)[]) if (typeof from[k] === 'string') terminal[k] = from[k]
  return terminal
}

/**
 * Schedules as storage holds them, read field by field. Older shapes miss fields or hold what this
 * version cannot show, and one entry that cannot be read must not stop the rest — a number where the
 * times go made every check throw. Times that are not text become none, so that schedule never sends.
 */
export function normalize(value: unknown): Schedule[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof v.id === 'string')
    .map((v) => {
      return {
        id: v.id as string,
        name: text(v.name),
        terminal: terminalFrom(v.terminal),
        cron: text(v.cron),
        prompt: text(v.prompt),
        enabled: v.enabled !== false,
        clearFirst: v.clearFirst === true,
        report: v.report === true,
        once: v.once === true,
        precheck: text(v.precheck),
        nextRunAt: time(v.nextRunAt),
        pendingSince: time(v.pendingSince),
        waitNote: isNote(v.waitNote) ? v.waitNote : null,
        clearedFor: time(v.clearedFor),
        sentAt: time(v.sentAt),
        lateMs: time(v.lateMs),
        sawWorking: v.sawWorking === true,
        blocked: isNote(v.blocked) ? v.blocked : null,
        lastStatus: isStatus(v.lastStatus) ? v.lastStatus : null,
        history: (Array.isArray(v.history) ? v.history : []).map(recordFrom).filter((r): r is RunRecord => r !== null)
      }
    })
}

/** `repo::/path/to/dir` → `dir`; folder workspaces have no path in the id. */
const nameFromId = (id: string): string => id.split('::')[1]?.split('/').filter(Boolean).pop() ?? id

let timer: ReturnType<typeof setInterval> | undefined
/** The look taken within seconds at a run asked for by hand (limits.askedCheckMs). */
let soon: ReturnType<typeof setTimeout> | undefined

/** CLI runner — when empty, the running Orca app's CLI is found and used. Tests swap in a fake. */
export const cli: { run: CliRunner | null } = { run: null }

/** The app's schedules file is a few kilobytes; anything far past that is not it. */
const ORCA_CRON_MAX_BYTES = 5_000_000

/** Where OrcaCron keeps its data, and how a file there is read (null = not there). Tests swap these.
 *  Only a plain file is read: the read is synchronous, and on a pipe it would never return — every
 *  check and every panel request would wait behind it. */
/** How a precheck command is run (src/cli.ts runCheck). Tests swap in a fake. */
export const checks: { run: (command: string, cwd: string) => Promise<CheckResult> } = { run: (command, cwd) => runCheck(command, cwd) }

export const orcaCron: { dir: () => string; read: (path: string) => string | null } = {
  dir: () => process.env.ORCA_CRON_HOME || `${homedir()}/.orca-cron`,
  read: (path) => {
    const stat = statSync(path, { throwIfNoEntry: false })
    return stat?.isFile() && stat.size <= ORCA_CRON_MAX_BYTES ? readFileSync(path, 'utf8') : null
  }
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const stored = await orca.storage.get(KEY)
  let list = normalize(stored)
  // They are left out of the next write, so say so once.
  if (Array.isArray(stored) && stored.length !== list.length) orca.log(`${stored.length - list.length} stored schedule(s) could not be read and are dropped`)
  let saved = JSON.stringify(list)
  let lang: Lang = langOf(await orca.storage.get(LANG_KEY))
  const memory = newMemory()
  const bin = cli.run ? null : findCli(process.execPath)
  const run: CliRunner | null = cli.run ?? (bin ? cliRunner(bin) : null)
  const status: RunnerStatus = { lastTickAt: null, log: [], cli: run !== null }
  orca.log(run ? `Orca CLI: ${bin ?? 'test'}` : `Orca CLI not found (worker: ${process.execPath})`)

  // One at a time — checks and panel edits must not overwrite each other.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const seenAgents = new Map<string, { agent: string; at: number }>()
  const io: Io = {
    async read(handle) {
      try {
        const r = await orca.host.call('terminal.read', { terminalId: handle, maxLines: 200 })
        return r.lines
      } catch (error) {
        const code = (error as HostError).code
        if (code && transientRead.has(code)) throw error
        orca.log(`terminal.read ${handle}: ${code ?? ''} ${messageOf(error)}`)
        return null
      }
    },
    async send(handle, text) {
      if (!run) return { error: 'Orca CLI not found' }
      const r = sentFrom(await run(sendArgs(handle, text)))
      if ('error' in r) orca.log(`terminal send ${handle}: ${r.error}`)
      return r
    },
    async terminals() {
      if (!run) return null
      const list = terminalsFrom(await run(['terminal', 'list']))
      // Read at least once a check, so two checks cover the last time the agent was seen.
      return list && holdAgents(list, seenAgents, Date.now(), 2 * TICK_MS)
    },
    async check(command, workspaceId) {
      return checks.run(command, await folderOf(workspaceId))
    }
  }

  /** The workspace's folder when it is on this computer; else the home folder. A workspace on an SSH host
   *  or a paired Orca server has its folder there, and the command runs here. */
  const folderOf = async (workspaceId: string): Promise<string> => {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const w = workspaces.find((x) => x.id === workspaceId)
      if (w?.path && (w.hostId === null || w.hostId === 'local') && statSync(w.path, { throwIfNoEntry: false })?.isDirectory()) return w.path
    } catch {
      // the home folder, as below
    }
    return homedir()
  }

  const noticeText = (n: Notice): string => {
    if (n.status === 'doneWaiting') return `${n.name}: ${words(lang).awaitingAnswer}`
    const parts = [n.status ? statusText(lang, n.status) : '', n.note ? noteText(lang, n.note) : '', lateText(lang, n.lateMs), n.summary ?? ''].filter(Boolean)
    return `${n.name}: ${parts.join(' — ')}`
  }

  const notify = (notices: Notice[]): void => {
    for (const n of notices) {
      void orca.host.call('notifications.show', { title: TITLE, body: noticeText(n) }).catch(() => undefined)
    }
  }

  const updateStatusBar = (): void => {
    const w = words(lang)
    const stuck = list.filter(needsAttention)
    const next = list
      .filter((s) => s.enabled && s.nextRunAt !== null)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
    const at = next?.nextRunAt ? new Date(next.nextRunAt) : null
    const text = stuck.length > 0 ? w.bar.attention(stuck.length) : at ? `${clock(at.getHours() * 60 + at.getMinutes())} ${next.name}` : w.bar.none
    const tooltip = [
      at ? `${w.bar.next}: ${at.toLocaleString(w.locale)} · ${next.name}` : w.bar.noActive,
      ...stuck.map((s) => `${s.name}: ${noteText(lang, (s.blocked ?? s.waitNote) as Note)}`)
    ].join('\n')
    void orca.host
      .call('statusBar.update', { id: 'next', text, tone: stuck.length > 0 ? 'warning' : 'neutral', tooltip })
      .catch(() => undefined)
  }

  const persist = async (): Promise<void> => {
    const text = JSON.stringify(list)
    if (text === saved) return
    await orca.storage.set(KEY, list)
    // Only once the write went through: marked saved before it, a write that failed was never tried again.
    saved = text
    orca.panels.post('schedules.changed', { schedules: list })
    updateStatusBar()
  }

  /**
   * A panel edit is all or nothing. When storage refuses the write the list goes back to what it was, so
   * the panel's "could not save" stays true: kept in memory, the edit showed up with the next check, and
   * a second press of Create added a second copy.
   */
  const edit = <T>(change: () => T | Promise<T>): Promise<T> =>
    serial(async () => {
      const before = structuredClone(list)
      try {
        const out = await change()
        await persist()
        return out
      } catch (error) {
        list = before
        throw error
      }
    })

  // At most one check waits behind the one running. A hung CLI call takes up to a minute; the 30-second
  // timer then stacked checks, and every panel edit waited behind all of them.
  let lined = false
  const runTick = (): Promise<void> => {
    if (lined) return Promise.resolve()
    lined = true
    return serial(async () => {
      lined = false
      const now = Date.now()
      const r = await tick(list, io, memory, now, lang)
      status.lastTickAt = now
      status.log = [...r.log.map((l) => `${new Date(now).toLocaleTimeString('en-GB')} ${l}`), ...status.log].slice(0, 50)
      for (const l of r.log) orca.log(l)
      notify(r.notices)
      // A run a person asked for that waits for something passing by itself: at the 30-second pace "now"
      // took a minute and a half on a resting agent. Not once the plugin is off (no timer) — a check that
      // was still running then would start the looks again.
      if (timer && !soon && askedSoon(list, memory, Date.now())) {
        soon = setTimeout(() => {
          soon = undefined
          void runTick()
        }, limits.askedCheckMs)
      }
      // A write that fails here is tried again by the next check — what was sent stays known meanwhile.
      await persist()
    })
      .then(() => pushTerminals())
      .catch((error) => orca.log(`check failed: ${messageOf(error)}`))
  }

  // The panel shows which terminals are open; tell it when that changes.
  let pushed = ''
  const pushTerminals = async (): Promise<void> => {
    if (!run) return
    const options = await terminalOptions().catch(() => null)
    const text = options ? JSON.stringify(options) : ''
    if (!options || text === pushed) return
    pushed = text
    orca.panels.post('terminals.changed', { terminals: options })
  }

  const find = (id: string): Schedule => {
    const s = list.find((x) => x.id === id)
    if (!s) throw invalid(words(lang).error.unknown)
    return s
  }

  /** Agent terminals open now, with workspace names, for the panel's picker. */
  const terminalOptions = async (): Promise<TerminalOption[]> => {
    const live = (await io.terminals()) ?? []
    let names = new Map<string, string>()
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      names = new Map(workspaces.map((w) => [w.id, w.name]))
    } catch {
      // names fall back to the folder name in the id
    }
    return live
      .filter((t) => agentKind(t.agent))
      .map((t) => ({
        handle: t.handle,
        title: t.title,
        agent: t.agent as string,
        workspaceId: t.workspaceId,
        workspace: names.get(t.workspaceId) ?? nameFromId(t.workspaceId),
        tabId: t.tabId,
        leafId: t.leafId
      }))
      .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.title.localeCompare(b.title))
  }

  orca.events.on('agent.status.changed', (e) =>
    serial(async () => {
      const ev = e as StatusEvent
      if (ev.terminalId) memory.agents.set(ev.terminalId, ev.state)
      const going = list.filter((s) => s.sentAt !== null)
      const seen = await inspectOnEvent(list, ev, io, SETTLE_MS)
      const r = seen.hold ? { changed: false, notices: [] } : onAgentStatus(list, ev, seen.reports)
      // How each run ended is in the log: by the agent's event here, or "by screen" / "result line" from a check.
      for (const s of going) if (s.sentAt === null) orca.log(`${s.name}: ${s.lastStatus} (agent ${ev.state})`)
      notify([...seen.notices, ...r.notices])
      if (seen.changed || r.changed) await persist()
    }).catch((error) => orca.log(`agent event failed: ${messageOf(error)}`))
  )

  orca.storage.onDidChange((change) => {
    if (change.key !== LANG_KEY) return
    void orca.storage.get(LANG_KEY).then((v) => {
      lang = langOf(v)
      updateStatusBar()
    })
  })

  orca.panels.handle('schedules.list', () => list)

  orca.panels.handle('terminals.list', async () => {
    const options = await terminalOptions()
    pushed = JSON.stringify(options)
    return options
  })

  orca.panels.handle('terminals.focus', async ({ handle }) => {
    if (!run) return { ok: false }
    const r = await run(['terminal', 'switch', `--terminal=${handle}`])
    if (!r.ok) orca.log(`terminal switch ${handle}: ${r.error}`)
    return { ok: r.ok }
  })

  orca.panels.handle('schedules.save', (given: ScheduleDraft) =>
    edit(() => {
      const e = words(lang).error
      // Read as loosely as storage is: a caller other than the panel may leave fields out.
      const draft = (typeof given === 'object' && given !== null ? given : {}) as Partial<ScheduleDraft>
      const name = text(draft.name).trim()
      const prompt = text(draft.prompt)
      const terminal = terminalFrom(draft.terminal)
      if (!name && !draft.once) throw invalid(e.name)
      if (!terminal.handle || !agentKind(terminal.agent)) throw invalid(e.terminal)
      if (!prompt.trim()) throw invalid(e.prompt)
      if (draft.once) {
        const s: Schedule = {
          ...blankSchedule(newId()),
          name: name || firstLine(prompt),
          terminal,
          cron: '',
          prompt,
          clearFirst: draft.clearFirst === true,
          report: draft.report === true,
          once: true,
          pendingSince: Date.now()
        }
        list = pruneOnce([...list, s])
        memory.asked.add(s.id)
        // Lined up behind this edit, so it runs once the schedule is stored.
        void runTick()
        return s
      }
      const cron = text(draft.cron).trim()
      const nextRunAt = nextAfter(cron, Date.now())
      if (nextRunAt === null) throw invalid(e.never)
      const old = draft.id ? list.find((s) => s.id === draft.id) : undefined
      const moved = old !== undefined && !sameTerminal(old.terminal, terminal)
      // Its end is read off the terminal it was sent to — moved now, the run would be closed by whatever
      // the other terminal's agent is doing.
      if (moved && old.sentAt !== null) throw invalid(e.running)
      const id = old?.id ?? (typeof draft.id === 'string' && draft.id ? draft.id : newId())
      const s: Schedule = {
        ...(old ?? blankSchedule(id)),
        id,
        name,
        terminal,
        cron,
        prompt,
        enabled: draft.enabled !== false,
        clearFirst: draft.clearFirst === true,
        report: draft.report === true,
        precheck: text(draft.precheck).trim()
      }
      // A /clear typed into the old terminal says nothing about the new one.
      if (moved) s.clearedFor = null
      s.nextRunAt = s.enabled ? nextRunAt : null
      list = old ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]
      // A terminal opened since the last check would show as closed until the next one.
      void pushTerminals()
      return s
    })
  )

  orca.panels.handle('schedules.delete', ({ id }) =>
    edit(() => {
      list = list.filter((s) => s.id !== id)
      return { ok: true as const }
    })
  )

  orca.panels.handle('schedules.restore', ({ schedule }) =>
    edit(() => {
      const [s] = normalize([schedule])
      if (!s) throw invalid(words(lang).error.unknown)
      if (!list.some((x) => x.id === s.id)) {
        s.nextRunAt = s.enabled && !s.once ? nextAfter(s.cron, Date.now()) : null
        list = [...list, s]
        void pushTerminals()
      }
      return s
    })
  )

  orca.panels.handle('schedules.toggle', ({ id, enabled }) =>
    edit(() => {
      const s = find(id)
      s.enabled = enabled
      s.nextRunAt = enabled ? nextAfter(s.cron, Date.now()) : null
      if (!enabled) {
        s.pendingSince = null
        s.waitNote = null
      }
      return s
    })
  )

  orca.panels.handle('schedules.runNow', async ({ id }) => {
    const s = await edit(() => {
      const s = find(id)
      // One run at a time — a press while its run is going would send the prompt again when that ends.
      if (s.pendingSince === null && s.sentAt === null) s.pendingSince = Date.now()
      return s
    })
    // A person asked and is looking at the terminal — the run need not sit out the full minute.
    memory.asked.add(s.id)
    void runTick()
    return s
  })

  orca.panels.handle('runner.status', () => status)

  /** OrcaCron's schedules with their terminals matched to the ones open now. */
  const importable = async (): Promise<{ list: ImportList; items: ReturnType<typeof itemsFrom>; open: TerminalOption[] }> => {
    const dir = orcaCron.dir()
    const shown = dir.startsWith(`${homedir()}/`) ? `~${dir.slice(homedir().length)}` : dir
    let file: unknown = null
    let found = false
    try {
      const text = orcaCron.read(`${dir}/schedules.json`)
      found = text !== null
      file = text === null ? null : JSON.parse(text)
    } catch (error) {
      orca.log(`OrcaCron schedules: ${messageOf(error)}`)
    }
    const items = itemsFrom(file, `${dir}/tasks`)
    const open = items.length > 0 ? await terminalOptions().catch(() => []) : []
    return {
      items,
      open,
      list: {
        found,
        dir: shown,
        items: items.map((i) => {
          const live = locate(i.terminal, open)
          return {
            id: i.id,
            name: i.name,
            cron: i.cron,
            terminal: live ?? i.terminal,
            open: live !== null,
            imported: list.some((s) => s.id === importedId(i.id)),
            badCron: i.badCron
          }
        })
      }
    }
  }

  orca.panels.handle('orcacron.list', async () => (await importable()).list)

  orca.panels.handle('orcacron.import', ({ ids }) =>
    edit(async () => {
      const { items, open } = await importable()
      const wanted = new Set(Array.isArray(ids) ? ids : [])
      const fresh = items
        .filter((i) => wanted.has(i.id) && !i.badCron && !list.some((s) => s.id === importedId(i.id)))
        .map((i) => scheduleFrom(i, locate(i.terminal, open) ?? i.terminal))
      if (fresh.length > 0) {
        list = [...list, ...fresh]
        void pushTerminals()
      }
      return { added: fresh.length }
    })
  )

  updateStatusBar()
  if (timer) clearInterval(timer)
  if (soon) clearTimeout(soon)
  soon = undefined
  timer = setInterval(() => void runTick(), TICK_MS)
  void runTick()
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  if (soon) clearTimeout(soon)
  soon = undefined
}

/** The first line of a prompt, short enough for a name. */
function firstLine(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/** Keep the newest ONCE_KEEP finished one-off sends; waiting and running ones always stay. */
function pruneOnce(list: Schedule[]): Schedule[] {
  const done = list
    .filter((s) => s.once && s.pendingSince === null && s.sentAt === null)
    .sort((a, b) => (b.history[0]?.at ?? 0) - (a.history[0]?.at ?? 0))
  const drop = new Set(done.slice(ONCE_KEEP).map((s) => s.id))
  return drop.size ? list.filter((s) => !drop.has(s.id)) : list
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}
