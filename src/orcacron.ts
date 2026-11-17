// Copies schedules out of the menubar app OrcaCron (https://github.com/gook-lab/orca-cron), which this
// plugin grew out of. Only what a person set comes over — name, times, terminal, what to send. Run state
// and history stay in the app, and nothing in its folder is changed. The folder is ~/.orca-cron, or
// ORCA_CRON_HOME (the app's Store.swift).
import { parseCron } from './cron'
import { blankSchedule, blankTerminal, type Schedule, type TerminalRef } from './engine'

export type ImportItem = {
  /** The schedule's id in OrcaCron. */
  id: string
  name: string
  cron: string
  terminal: TerminalRef
  prompt: string
  clearFirst: boolean
  report: boolean
  /** Its times cannot be read here — it does not come over. */
  badCron: boolean
}

/** The id an imported schedule gets here — importing twice finds the first copy instead of adding another. */
export const importedId = (id: string): string => `orcacron-${id}`

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Orca's pane and tab ids are UUIDs. The app's older records hold `pty:1`-style ids that were seen to
 *  name a different terminal later (2026-11-17), so those are not kept for finding the terminal again. */
const paneId = (v: unknown): string => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text(v)) ? text(v) : '')

function terminalFrom(v: unknown): TerminalRef {
  const t = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return { ...blankTerminal(), handle: text(t.handle), title: text(t.label), agent: text(t.agent) || 'claude', tabId: paneId(t.tabId), leafId: paneId(t.leafId) }
}

/**
 * The app's schedules as this plugin would send them. What goes out is the app's own message
 * (Engine.swift `message`) without its closing "run the finish command" — the result ask of this plugin
 * (Schedule.report) takes that place. One-off sends are left behind.
 */
export function itemsFrom(file: unknown, tasksDir: string): ImportItem[] {
  const list = (file as { schedules?: unknown } | null)?.schedules
  if (!Array.isArray(list)) return []
  const out: ImportItem[] = []
  // An id listed twice would come over as two schedules with one id here — the first one counts.
  const seen = new Set<string>()
  for (const v of list) {
    if (typeof v !== 'object' || v === null) continue
    const s = v as Record<string, unknown>
    const id = text(s.id)
    const name = text(s.name).trim()
    if (!id || !name || s.oneShot === true || seen.has(id)) continue
    seen.add(id)
    const task = text(s.task)
    const typed = text(s.prompt).trim()
    const body = task ? `작업 파일 ${tasksDir}/${task}.md 을 읽고 그 절차대로 실행한다(파일의 「실행기 finish」 줄은 요약 문구 형식 안내로만 쓴다).` : typed
    if (!body) continue
    // The app's rule: a typed `/command` goes out as it is, and gets no result.
    const report = !(task === '' && typed.startsWith('/')) && s.track !== false
    const cron = text(s.cron).trim()
    out.push({
      id,
      name,
      cron,
      terminal: terminalFrom(s.terminal),
      prompt: report ? `[예약 실행 · ${name}] ${body}` : body,
      clearFirst: s.clearFirst === true,
      report,
      badCron: parseCron(cron) === null
    })
  }
  return out
}

/** Imported schedules start switched off: while the app still runs its own copy, an enabled one would send twice. */
export function scheduleFrom(item: ImportItem, terminal: TerminalRef): Schedule {
  return {
    ...blankSchedule(importedId(item.id)),
    name: item.name,
    terminal,
    cron: item.cron,
    prompt: item.prompt,
    enabled: false,
    clearFirst: item.clearFirst,
    report: item.report
  }
}
