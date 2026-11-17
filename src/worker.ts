// Schedule worker. It owns a status bar item, so it keeps running while the plugin is on (checks every 30 s).
// Schedules live in storage 'schedules' and only this file edits them; the panel asks by request and hears by post.
// The terminal list and sending go through the Orca CLI (why: src/cli.ts).
import type { OrcaWorkerApi } from 'orca/worker'
import { type CliRunner, cliRunner, findCli, holdAgents, sendArgs, sentFrom, terminalsFrom } from './cli'
import {
  blankSchedule,
  blankTerminal,
  inspectOnEvent,
  type Io,
  newMemory,
  nextAfter,
  type Notice,
  onAgentStatus,
  type Schedule,
  type StatusEvent,
  tick
} from './engine'
import { attentionCodes, type Lang, langOf, lateText, type Note, noteText, statuses, statusText, words } from './i18n'
import { LANG_KEY, type RunnerStatus, type ScheduleDraft, type TerminalOption } from './protocol'
import { agentKind } from './screen'
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
const isStatus = (v: unknown): boolean => (statuses as readonly unknown[]).includes(v)

/** Fill missing fields of older stored shapes; drop what this version cannot show. */
export function normalize(value: unknown): Schedule[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof v.id === 'string')
    .map((v) => {
      const { workspaceId: _w, workspace: _ws, agent: _a, terminalId: _t, delivered: _d, ...rest } = v
      const s: Schedule = { ...blankSchedule(v.id as string), ...(rest as Partial<Schedule>) }
      s.terminal = { ...blankTerminal(), ...(typeof v.terminal === 'object' && v.terminal !== null ? (v.terminal as object) : {}) }
      s.history = (Array.isArray(v.history) ? v.history : []).filter((r) => isStatus((r as { status?: unknown }).status))
      s.waitNote = isNote(v.waitNote) ? v.waitNote : null
      s.blocked = isNote(v.blocked) ? v.blocked : null
      s.lastStatus = isStatus(v.lastStatus) ? (v.lastStatus as Schedule['lastStatus']) : null
      s.clearFirst = v.clearFirst === true
      s.once = v.once === true
      return s
    })
}

/** `repo::/path/to/dir` → `dir`; folder workspaces have no path in the id. */
const nameFromId = (id: string): string => id.split('::')[1]?.split('/').filter(Boolean).pop() ?? id

let timer: ReturnType<typeof setInterval> | undefined

/** CLI runner — when empty, the running Orca app's CLI is found and used. Tests swap in a fake. */
export const cli: { run: CliRunner | null } = { run: null }

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let list = normalize(await orca.storage.get(KEY))
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
        orca.log(`terminal.read ${handle}: ${code ?? ''} ${(error as Error).message}`)
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
    }
  }

  const noticeText = (n: Notice): string => {
    if (n.status === 'doneWaiting') return `${n.name}: ${words(lang).awaitingAnswer}`
    const parts = [n.status ? statusText(lang, n.status) : '', n.note ? noteText(lang, n.note) : '', lateText(lang, n.lateMs)].filter(Boolean)
    return `${n.name}: ${parts.join(' — ')}`
  }

  const notify = (notices: Notice[]): void => {
    for (const n of notices) {
      void orca.host.call('notifications.show', { title: TITLE, body: noticeText(n) }).catch(() => undefined)
    }
  }

  const updateStatusBar = (): void => {
    const w = words(lang)
    const stuck = list.filter((s) => s.blocked || (s.pendingSince !== null && s.waitNote && attentionCodes.includes(s.waitNote.code)))
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
    saved = text
    await orca.storage.set(KEY, list)
    orca.panels.post('schedules.changed', { schedules: list })
    updateStatusBar()
  }

  const runTick = (): Promise<void> =>
    serial(async () => {
      const now = Date.now()
      const r = await tick(list, io, memory, now)
      status.lastTickAt = now
      status.log = [...r.log.map((l) => `${new Date(now).toLocaleTimeString('en-GB')} ${l}`), ...status.log].slice(0, 50)
      for (const l of r.log) orca.log(l)
      notify(r.notices)
      await persist()
    }).then(() => pushTerminals())

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
      const seen = await inspectOnEvent(list, ev, io, SETTLE_MS)
      const r = seen.hold ? { changed: false, notices: [] } : onAgentStatus(list, ev)
      notify([...seen.notices, ...r.notices])
      if (seen.changed || r.changed) await persist()
    })
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
    const r = await run(['terminal', 'switch', '--terminal', handle])
    if (!r.ok) orca.log(`terminal switch ${handle}: ${r.error}`)
    return { ok: r.ok }
  })

  orca.panels.handle('schedules.save', (draft: ScheduleDraft) =>
    serial(async () => {
      const e = words(lang).error
      const name = draft.name.trim()
      if (!name && !draft.once) throw invalid(e.name)
      if (!draft.terminal?.handle || !agentKind(draft.terminal.agent)) throw invalid(e.terminal)
      if (!draft.prompt.trim()) throw invalid(e.prompt)
      if (draft.once) {
        const s: Schedule = {
          ...blankSchedule(newId()),
          name: name || firstLine(draft.prompt),
          terminal: { ...blankTerminal(), ...draft.terminal },
          cron: '',
          prompt: draft.prompt,
          clearFirst: draft.clearFirst === true,
          once: true,
          pendingSince: Date.now()
        }
        list = pruneOnce([...list, s])
        await persist()
        void runTick()
        return s
      }
      const nextRunAt = nextAfter(draft.cron, Date.now())
      if (nextRunAt === null) throw invalid(e.never)
      const old = draft.id ? list.find((s) => s.id === draft.id) : undefined
      const id = old?.id ?? draft.id ?? newId()
      const s: Schedule = {
        ...(old ?? blankSchedule(id)),
        id,
        name,
        terminal: { ...blankTerminal(), ...draft.terminal },
        cron: draft.cron.trim(),
        prompt: draft.prompt,
        enabled: draft.enabled,
        clearFirst: draft.clearFirst === true
      }
      s.nextRunAt = s.enabled ? nextRunAt : null
      list = old ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]
      await persist()
      // A terminal opened since the last check would show as closed until the next one.
      void pushTerminals()
      return s
    })
  )

  orca.panels.handle('schedules.delete', ({ id }) =>
    serial(async () => {
      list = list.filter((s) => s.id !== id)
      await persist()
      return { ok: true as const }
    })
  )

  orca.panels.handle('schedules.restore', ({ schedule }) =>
    serial(async () => {
      const [s] = normalize([schedule])
      if (!s) throw invalid(words(lang).error.unknown)
      if (!list.some((x) => x.id === s.id)) {
        s.nextRunAt = s.enabled && !s.once ? nextAfter(s.cron, Date.now()) : null
        list = [...list, s]
        await persist()
        void pushTerminals()
      }
      return s
    })
  )

  orca.panels.handle('schedules.toggle', ({ id, enabled }) =>
    serial(async () => {
      const s = find(id)
      s.enabled = enabled
      s.nextRunAt = enabled ? nextAfter(s.cron, Date.now()) : null
      if (!enabled) {
        s.pendingSince = null
        s.waitNote = null
      }
      await persist()
      return s
    })
  )

  orca.panels.handle('schedules.runNow', async ({ id }) => {
    const s = await serial(async () => {
      const s = find(id)
      if (s.pendingSince === null) s.pendingSince = Date.now()
      await persist()
      return s
    })
    void runTick()
    return s
  })

  orca.panels.handle('runner.status', () => status)

  updateStatusBar()
  if (timer) clearInterval(timer)
  timer = setInterval(() => void runTick(), TICK_MS)
  void runTick()
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = undefined
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
