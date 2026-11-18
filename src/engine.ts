// Schedule runner — at the set time, waits until the chosen agent terminal is idle, sends the
// prompt into it, and watches until the agent stops. Sending goes through the Orca CLI because the
// plugin API's terminal.sendText only reaches the worktree open on screen (Orca 1.4.255:
// "terminal is outside the active worktree"). Screen reads, sends and the live terminal list come
// in through Io so tests can swap them.
import { nextRun, parseCron } from './cron'
import { type Lang, type Note, type NoteCode, type Status, words } from './i18n'
import { readReport, type Report, reportToken } from './report'
import { agentKind, permissionPrompt, promptState } from './screen'

export type RunRecord = {
  at: number
  status: Status
  tookMs?: number
  note?: Note
  /** Sent this long after it fell due. Set only past limits.maxWaitMs — a waiting run is skipped by then, so
   *  only checks that did not run (the computer asleep, Orca closed) get a run here. */
  lateMs?: number
  /** What the agent wrote in its result line (Schedule.report). */
  summary?: string
  link?: string
}

/** The terminal a schedule sends to. Handles change when Orca restarts; the pane (leaf) id does not. */
export type TerminalRef = {
  handle: string
  title: string
  /** claude · codex · gemini, as Orca last reported it. */
  agent: string
  workspaceId: string
  workspace: string
  tabId: string
  leafId: string
}

/** A terminal Orca has open now (`orca terminal list`). */
export type LiveTerminal = {
  handle: string
  title: string
  /** Orca's agentIdentity; null when no agent runs in it. */
  agent: string | null
  workspaceId: string
  tabId: string
  leafId: string
  /** Last time the terminal printed anything (ms). */
  lastOutputAt: number | null
}

export type Schedule = {
  id: string
  name: string
  terminal: TerminalRef
  cron: string
  prompt: string
  enabled: boolean
  /** Send /clear before the prompt so every run starts a new conversation. */
  clearFirst: boolean
  /** Ask the agent to end with a result line, and keep its summary and link with the run (src/report.ts). */
  report: boolean
  /** Send once — no times; due when saved, then kept as a record of what was sent. */
  once: boolean
  nextRunAt: number | null
  /** Due and waiting for the terminal to be idle (the time it fell due). */
  pendingSince: number | null
  waitNote: Note | null
  /** The pendingSince this run already sent /clear for. */
  clearedFor: number | null
  /** Sent and waiting for the agent to stop (when it was sent). */
  sentAt: number | null
  /** How late the run now in flight went out (RunRecord.lateMs); null when on time. */
  lateMs: number | null
  sawWorking: boolean
  blocked: Note | null
  lastStatus: Status | null
  history: RunRecord[]
}

export type AgentStatus = 'working' | 'blocked' | 'waiting' | 'done'

export type SendResult = { started: boolean } | { error: string }

export type Io = {
  /** The tail of the screen. Null when the terminal is gone; throws when it cannot read right now. */
  read(handle: string): Promise<string[] | null>
  /** Types the text and presses Enter. `started` = the agent was seen starting a turn. */
  send(handle: string, text: string): Promise<SendResult>
  /** Terminals open now. Null when unknown. */
  terminals(): Promise<LiveTerminal[] | null>
}

export type Memory = {
  screens: Map<string, { hash: string; changedAt: number }>
  /** The latest agent.status.changed state per terminal. */
  agents: Map<string, AgentStatus>
  /** Ids of schedules whose waiting run a person asked for just now (Send now, Send once) — it goes out
   *  after limits.askedQuietMs, not the full minute. Forgotten once the run goes out or is given up. */
  asked: Set<string>
}

export const newMemory = (): Memory => ({ screens: new Map(), agents: new Map(), asked: new Set() })

export const limits = {
  /** A due run that cannot go out for this long is skipped. */
  maxWaitMs: 60 * 60_000,
  /** A sent run that does not end within this is "no result". */
  resultTimeoutMs: 6 * 3600_000,
  /** Send only after the terminal has printed nothing for this long. */
  quietMs: 60_000,
  /** The same for a run a person asked for just now: they are looking at the terminal, and behind a full
   *  minute a press reads as nothing happening (a resting agent that had just printed — 92 and 151 s,
   *  2026-11-18). The other checks stay: a working agent, text in the input box, a dialog. */
  askedQuietMs: 5_000,
  /** While only a moving screen holds such a run it is looked at again this soon, not at the next check. */
  askedCheckMs: 3_000,
  /** Quiet this long after sending — an empty input box means done, anything else means stuck. */
  finishedQuietMs: 3 * 60_000,
  /** A run that ended without its result line is still looked at for this long: an agent that ended its
   *  turn to wait on its own background work writes the line when that work is done. */
  lateReportMs: 60 * 60_000,
  historyMax: 30
}

export const blankTerminal = (): TerminalRef => ({ handle: '', title: '', agent: 'claude', workspaceId: '', workspace: '', tabId: '', leafId: '' })

export function blankSchedule(id: string): Schedule {
  return {
    id,
    name: '',
    terminal: blankTerminal(),
    cron: '0 9 * * 1-5',
    prompt: '',
    enabled: true,
    clearFirst: false,
    report: false,
    once: false,
    nextRunAt: null,
    pendingSince: null,
    waitNote: null,
    clearedFor: null,
    sentAt: null,
    lateMs: null,
    sawWorking: false,
    blocked: null,
    lastStatus: null,
    history: []
  }
}

export function nextAfter(cron: string, now: number): number | null {
  const rules = parseCron(cron)
  return rules ? (nextRun(rules, new Date(now))?.getTime() ?? null) : null
}

type Pane = Pick<TerminalRef, 'handle' | 'leafId'>

/** The open terminal a reference points at — by handle, or by pane after Orca restarted. */
export function locate<T extends Pane>(ref: Pane, live: T[]): T | null {
  return (
    (ref.handle ? live.find((t) => t.handle === ref.handle) : undefined) ?? (ref.leafId ? live.find((t) => t.leafId === ref.leafId) : undefined) ?? null
  )
}

/** Follow the terminal to its current handle, title and agent. */
function adopt(s: Schedule, t: LiveTerminal): void {
  s.terminal.handle = t.handle
  if (t.title) s.terminal.title = t.title
  if (agentKind(t.agent)) s.terminal.agent = t.agent as string
  s.terminal.tabId = t.tabId
  s.terminal.leafId = t.leafId
}

function record(s: Schedule, r: RunRecord): void {
  s.history = [r, ...s.history].slice(0, limits.historyMax)
  s.lastStatus = r.status
}

/** A prompt that starts with `/` is a command of the agent — text after it would be read as its arguments. */
export const asksReport = (s: Pick<Schedule, 'report' | 'prompt'>): boolean => s.report && !s.prompt.trimStart().startsWith('/')

/** The result line of the run now in flight, if the screen shows one. */
function reportOn(s: Schedule, lines: string[]): Report | null {
  return s.sentAt !== null && asksReport(s) ? readReport(lines, reportToken(s.sentAt)) : null
}

/** The last record, when its run was asked for a result line, ended without one, and may still get it. */
function awaitingLine(s: Schedule, now: number): RunRecord | null {
  const r = s.history[0]
  if (!r || s.sentAt !== null || r.tookMs === undefined || now - r.at >= limits.lateReportMs) return null
  return r.note?.code === 'noLine' || r.note?.reason === 'noLine' ? r : null
}

/** The result line of a run already recorded as ended without one: the record takes its status, summary
 *  and link, and stops saying the line is missing. */
async function lateReport(
  s: Schedule,
  live: LiveTerminal[] | null,
  screen: (handle: string) => Promise<string[] | null | undefined>,
  now: number,
  log: string[],
  notices: Notice[]
): Promise<void> {
  const r = awaitingLine(s, now)
  const t = r && live ? locate(s.terminal, live) : null
  if (!r || !t) return
  const lines = await screen(t.handle)
  const report = lines ? readReport(lines, reportToken(r.at - (r.tookMs ?? 0))) : null
  if (!report) return
  const { note, summary: _summary, link: _link, ...rest } = r
  s.history[0] = {
    ...rest,
    status: report.status,
    // How the end was seen stays; only the missing line goes.
    ...(note && note.code !== 'noLine' ? { note: { code: note.code } } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
    ...(report.link ? { link: report.link } : {})
  }
  s.lastStatus = report.status
  if (report.status === 'failed') notices.push({ name: s.name, status: 'failed', summary: report.summary })
  log.push(`${s.name}: result line came after the end`)
}

/** Ends the run in flight and records it; returns the status recorded. `ended` is how the turn ended. */
function finish(s: Schedule, now: number, ended: Status, endNote?: Note, report?: Report | null): Status {
  // The result line decides the status only of a run that ended normally — one that failed or was stopped stays so.
  const status = report && (ended === 'done' || ended === 'success' || ended === 'doneWaiting') ? report.status : ended
  // The line was asked for and the run ended as usual, yet no line was on screen — say so, or the record
  // reads the same as one that was never asked. A run that stopped at a question has not got to it.
  const noLine = !report && asksReport(s) && (status === 'done' || status === 'success')
  const note: Note | undefined = noLine ? (endNote ? { ...endNote, reason: 'noLine' } : { code: 'noLine' }) : endNote
  record(s, {
    at: now,
    status,
    ...(s.sentAt !== null ? { tookMs: now - s.sentAt } : {}),
    ...(note ? { note } : {}),
    ...(s.lateMs !== null ? { lateMs: s.lateMs } : {}),
    ...(report?.summary ? { summary: report.summary } : {}),
    ...(report?.link ? { link: report.link } : {})
  })
  s.sentAt = null
  s.lateMs = null
  s.sawWorking = false
  s.blocked = null
  return status
}

/** Something a person should hear about; the worker words it in the chosen language. */
export type Notice = { name: string; status?: Status; note?: Note; lateMs?: number; summary?: string }

export type TickResult = { log: string[]; notices: Notice[] }

/** Once every 30 seconds. Updates the schedules and returns what to log and announce. `lang` words the
 *  result ask added to a prompt. */
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function tick(list: Schedule[], io: Io, memory: Memory, now: number, lang: Lang = 'en'): Promise<TickResult> {
  const log: string[] = []
  const notices: Notice[] = []

  // 1. Due schedules start waiting to go out.
  for (const s of list) {
    if (!s.enabled) {
      s.nextRunAt = null
      continue
    }
    if (s.nextRunAt === null) s.nextRunAt = nextAfter(s.cron, now)
    if (s.nextRunAt !== null && s.nextRunAt <= now) {
      if (s.pendingSince === null) s.pendingSince = s.nextRunAt
      s.nextRunAt = nextAfter(s.cron, now)
    }
  }

  let live: LiveTerminal[] | null = null
  if (list.some((s) => s.sentAt !== null || s.pendingSince !== null || awaitingLine(s, now))) {
    try {
      live = await io.terminals()
    } catch (error) {
      // As when the list could not be read: runs wait, and give up after the usual time.
      log.push(`terminal list failed — ${errorText(error)}`)
    }
  }
  // undefined = could not read this time (try again next check).
  const screens = new Map<string, string[] | null | undefined>()
  const screen = async (handle: string): Promise<string[] | null | undefined> => {
    if (!screens.has(handle)) {
      let lines: string[] | null | undefined
      try {
        lines = await io.read(handle)
      } catch {
        lines = undefined
      }
      screens.set(handle, lines)
      if (lines) {
        const hash = lines.slice(-40).join('\n')
        const seen = memory.screens.get(handle)
        if (!seen || seen.hash !== hash) memory.screens.set(handle, { hash, changedAt: now })
      }
    }
    return screens.get(handle)
  }
  // How long the terminal has shown nothing new. An idle agent keeps repainting its status line: the
  // last-output time moves while the text stays (an idle Claude Code, 2026-11-17 — every 7 to 171 s),
  // so text seen unchanged since an earlier check is quiet as well — whichever says longer.
  const quietFor = (handle: string, t: LiveTerminal | null): number => {
    const printed = t?.lastOutputAt
    const changed = memory.screens.get(handle)?.changedAt
    return Math.max(printed == null ? 0 : now - printed, changed === undefined ? 0 : now - changed)
  }

  // A send that throws has an outcome nobody saw — the text may be in the terminal. It counts as failed
  // and is not sent again: left waiting, the next check would type the prompt a second time.
  const send = async (handle: string, text: string): Promise<SendResult> => {
    try {
      return await io.send(handle, text)
    } catch (error) {
      return { error: errorText(error) }
    }
  }

  const used = new Set<string>()
  const step = async (s: Schedule): Promise<void> => {
    // 2. Sent runs — wait for the end. It usually comes as an agent status event (onAgentStatus).
    if (s.sentAt !== null) await watch(s, live, screen, quietFor, memory, now, log, notices)
    else await lateReport(s, live, screen, now, log, notices)

    // 3. Due runs — send once the terminal is idle.
    if (s.pendingSince === null) return
    const waitOrGiveUp = (why: NoteCode): void => {
      if (now - (s.pendingSince ?? now) < limits.maxWaitMs) {
        s.waitNote = { code: why }
        return
      }
      const note: Note = { code: 'waitedOut', reason: why }
      record(s, { at: now, status: 'skipped', note })
      s.pendingSince = null
      s.waitNote = null
      notices.push({ name: s.name, status: 'skipped', note })
      log.push(`${s.name}: skipped — ${why}`)
    }
    if (s.sentAt !== null) {
      waitOrGiveUp('previous')
      return
    }
    if (!live) {
      waitOrGiveUp('cli')
      return
    }
    const t = locate(s.terminal, live)
    if (!t) {
      waitOrGiveUp('missing')
      return
    }
    adopt(s, t)
    const kind = agentKind(t.agent)
    if (!kind) {
      // Only a shell is left — the prompt would run as a shell command.
      waitOrGiveUp('noAgent')
      return
    }
    if (used.has(t.handle)) {
      s.waitNote = { code: 'sameTerminal' }
      return
    }
    // Another schedule's run is still going here. Its end would be read off this run's reply, and this
    // run's off its — so wait; a run that went silent is closed by `watch` within finishedQuietMs.
    if (list.some((o) => o !== s && o.sentAt !== null && locate(o.terminal, live) === t)) {
      waitOrGiveUp('otherRun')
      return
    }
    const lines = await screen(t.handle)
    if (lines === undefined) {
      waitOrGiveUp('unreadable')
      return
    }
    if (lines === null) {
      waitOrGiveUp('missing')
      return
    }
    const quiet = quietFor(t.handle, t)
    // A stale "working" (a missed done event) stops counting once the screen has been still for a while.
    if (memory.agents.get(t.handle) === 'working' && quiet < limits.finishedQuietMs) {
      waitOrGiveUp('busy')
      return
    }
    if (quiet < (memory.asked.has(s.id) ? limits.askedQuietMs : limits.quietMs)) {
      waitOrGiveUp('moving')
      return
    }
    const prompt = promptState(lines, kind)
    if (prompt === 'typing') {
      waitOrGiveUp('typing')
      return
    }
    if (prompt === 'unknown') {
      waitOrGiveUp(permissionPrompt(lines) ? 'dialog' : 'noPrompt')
      return
    }

    used.add(t.handle)
    if (s.clearFirst && s.clearedFor !== s.pendingSince) {
      // New conversation — /clear first, the prompt on a later check once the screen settles again.
      const r = await send(t.handle, '/clear')
      if ('error' in r) {
        const note: Note = { code: 'clearFailed', detail: r.error }
        record(s, { at: now, status: 'failed', note })
        s.pendingSince = null
        s.waitNote = null
        notices.push({ name: s.name, status: 'failed', note })
        log.push(`${s.name}: /clear failed — ${r.error}`)
      } else {
        s.clearedFor = s.pendingSince
        s.waitNote = { code: 'cleared' }
        memory.screens.set(t.handle, { hash: '', changedAt: now })
        log.push(`${s.name}: sent /clear → ${s.terminal.title}`)
      }
      return
    }

    const late = now - s.pendingSince
    const r = await send(t.handle, asksReport(s) ? `${s.prompt.trimEnd()} ${words(lang).reportAsk(reportToken(now))}` : s.prompt)
    s.pendingSince = null
    s.waitNote = null
    if ('error' in r) {
      const note: Note = { code: 'sendFailed', detail: r.error }
      record(s, { at: now, status: 'failed', note })
      notices.push({ name: s.name, status: 'failed', note })
      log.push(`${s.name}: send failed — ${r.error}`)
      return
    }
    s.sentAt = now
    // Catching up on a run whose time passed unchecked — it still goes out once, and says so.
    s.lateMs = late >= limits.maxWaitMs ? late : null
    if (s.lateMs !== null) notices.push({ name: s.name, lateMs: s.lateMs })
    // Seeing the turn start is as good as a "working" event — that event may land while the send waits.
    s.sawWorking = r.started
    s.blocked = null
    s.lastStatus = 'sent'
    memory.screens.set(t.handle, { hash: '', changedAt: now })
    log.push(`${s.name}: sent → ${s.terminal.title}${r.started ? '' : ' (turn start not seen)'}`)
  }
  // One schedule that throws must not take the others' turn with it — it is logged and tried again.
  for (const s of list) {
    try {
      await step(s)
    } catch (error) {
      log.push(`${s.name}: check failed — ${errorText(error)}`)
    }
  }
  // Asked for by hand only until it goes out or is given up — the schedule's next run waits the minute.
  for (const id of memory.asked) if (!list.some((s) => s.id === id && s.pendingSince !== null)) memory.asked.delete(id)
  return { log, notices }
}

/** A run asked for by hand that only a moving screen holds — worth another look within seconds. */
export const askedSoon = (list: Schedule[], memory: Memory): boolean =>
  list.some((s) => memory.asked.has(s.id) && s.pendingSince !== null && s.sentAt === null && (s.waitNote?.code === 'moving' || s.waitNote?.code === 'cleared'))

async function watch(
  s: Schedule,
  live: LiveTerminal[] | null,
  screen: (handle: string) => Promise<string[] | null | undefined>,
  quietFor: (handle: string, t: LiveTerminal | null) => number,
  memory: Memory,
  now: number,
  log: string[],
  notices: Notice[]
): Promise<void> {
  if (s.sentAt === null) return
  if (now - s.sentAt >= limits.resultTimeoutMs) {
    finish(s, now, 'noResult', { code: 'timeout' })
    notices.push({ name: s.name, status: 'noResult' })
    return
  }
  let t: LiveTerminal | null = null
  if (live) {
    t = locate(s.terminal, live)
    if (!t) {
      finish(s, now, 'aborted', { code: 'closed' })
      log.push(`${s.name}: the terminal closed`)
      return
    }
    adopt(s, t)
  }
  const before = memory.screens.get(s.terminal.handle)?.hash
  const lines = await screen(s.terminal.handle)
  if (lines === undefined) return // try again next check
  if (lines === null) {
    finish(s, now, 'aborted', { code: 'closed' })
    log.push(`${s.name}: the terminal closed`)
    return
  }
  // The screen changed since the last check — whatever stopped it (a dialog) was answered.
  if (before && before !== memory.screens.get(s.terminal.handle)?.hash) s.blocked = null
  // The run's result line is the agent's last word on it. Taken when first seen: the end event may
  // never come, and on a small pane later output pushes the line off the screen.
  const told = reportOn(s, lines)
  if (told) {
    const status = finish(s, now, 'done', undefined, told)
    if (status === 'failed') notices.push({ name: s.name, status, summary: told.summary })
    log.push(`${s.name}: ${status} (result line)`)
    return
  }
  const quiet = quietFor(s.terminal.handle, t)
  if (now - s.sentAt < limits.finishedQuietMs || quiet < limits.finishedQuietMs) return
  const prompt = promptState(lines, agentKind(t?.agent ?? s.terminal.agent) ?? 'claude')
  if (prompt === 'empty') {
    // The end event was missed — a quiet screen with an empty input box after sending means done.
    finish(s, now, 'done', { code: 'byScreen' })
    log.push(`${s.name}: done (by screen)`)
  } else if (!s.blocked) {
    s.blocked = { code: prompt === 'typing' ? 'stuckTyping' : permissionPrompt(lines) ? 'person' : 'stuckNoPrompt' }
    notices.push({ name: s.name, note: s.blocked })
  }
}

const outcomeStatus: Record<string, Status> = {
  success: 'success',
  failure: 'failed',
  cancellation: 'aborted',
  interruption: 'aborted',
  superseded: 'aborted'
}

export type StatusEvent = {
  terminalId?: string
  state: AgentStatus
  receivedAt: number
  mainAgent?: { state: AgentStatus; outcome?: string; stateStartedAt: number }
}

/** On a stop event (done · waiting), read that terminal's screen before ending the run. A permission
 *  or question dialog on screen means the agent waits for a person, not that it finished. Claude
 *  Code's question dialog comes as waiting or done, and the first event arrives slightly before the
 *  dialog is drawn (Orca 1.4.255: 0.16 s) — so wait settleMs first. `hold` = do not end on this event. */
export async function inspectOnEvent(
  list: Schedule[],
  e: StatusEvent,
  io: Io,
  settleMs = 0
): Promise<{ changed: boolean; notices: Notice[]; hold: boolean; reports: Map<string, Report> }> {
  const out = { changed: false, notices: [] as Notice[], hold: false, reports: new Map<string, Report>() }
  if (e.state !== 'done' && e.state !== 'waiting') return out
  const mine = list.filter((s) => e.terminalId && s.terminal.handle === e.terminalId && s.sentAt !== null)
  if (mine.length === 0) return out
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
  for (const s of mine) {
    let lines: string[] | null
    try {
      lines = await io.read(s.terminal.handle)
    } catch {
      continue // read it on the next check
    }
    if (!lines) continue
    const report = reportOn(s, lines)
    if (report) out.reports.set(s.id, report)
    if (!permissionPrompt(lines)) continue
    out.hold = true
    if (!s.blocked) {
      s.blocked = { code: 'person' }
      out.notices.push({ name: s.name, note: s.blocked })
      out.changed = true
    }
  }
  return out
}

/** Agent status events — a sent run that started working and then stopped is recorded as ended.
 *  `reports` = the result lines inspectOnEvent found on those runs' screens, by schedule id. */
export function onAgentStatus(
  list: Schedule[],
  e: StatusEvent,
  reports: ReadonlyMap<string, Report> = new Map()
): { changed: boolean; notices: Notice[] } {
  const notices: Notice[] = []
  if (!e.terminalId) return { changed: false, notices }
  let changed = false
  for (const s of list) {
    if (s.terminal.handle !== e.terminalId || s.sentAt === null) continue
    if (e.state === 'working') {
      if (!s.sawWorking || s.blocked) changed = true
      s.sawWorking = true
      s.blocked = null
    } else if (e.state === 'blocked') {
      if (!s.blocked) {
        s.blocked = { code: 'person' }
        notices.push({ name: s.name, note: s.blocked })
        changed = true
      }
    } else if (s.sawWorking) {
      const outcome = e.mainAgent?.outcome
      const report = reports.get(s.id)
      const status = finish(s, e.receivedAt, (outcome && outcomeStatus[outcome]) || (e.state === 'waiting' ? 'doneWaiting' : 'done'), undefined, report)
      // Waiting for input — it stopped at a question, not because the work is finished.
      if (status === 'doneWaiting' || status === 'failed' || status === 'aborted') {
        notices.push({ name: s.name, status, ...(report?.summary ? { summary: report.summary } : {}) })
      }
      changed = true
    }
  }
  return { changed, notices }
}
