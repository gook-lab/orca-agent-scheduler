import { words, type Lang } from './i18n'
import { nextRun, parseCron } from './cron'
import type { Schedule } from './engine'
import { clock, cronOfSpec, daysOf, type Days, lastMinute, maxEvery, maxTimes, minuteFromText, type Pattern, specOfCron } from './timespec'

export type DayMode = 'everyDay' | 'weekdays' | 'weekends' | 'pick' | 'dates' | 'cron'
export const dayModes: DayMode[] = ['everyDay', 'weekdays', 'weekends', 'pick', 'dates', 'cron']

export type Draft = {
  id?: string
  /** Send once now — no days or times. */
  once: boolean
  name: string
  handle: string
  clearFirst: boolean
  /** Ask the agent to end with a result line. */
  report: boolean
  day: DayMode
  /** Pick days: 0 = Sunday … 6 = Saturday. */
  picked: number[]
  /** Dates: `YYYY-MM-DD`. */
  dates: string[]
  /** false = at set times, true = every N minutes. */
  repeat: boolean
  times: string[]
  every: string
  allDay: boolean
  from: string
  to: string
  cron: string
  prompt: string
}

export const emptyDraft = (): Draft => ({
  once: false,
  name: '',
  handle: '',
  clearFirst: false,
  report: true,
  day: 'weekdays',
  picked: [1, 2, 3, 4, 5],
  dates: [],
  repeat: false,
  times: ['09:00'],
  every: '30',
  allDay: false,
  from: '09:00',
  to: '18:00',
  cron: '0 9 * * 1-5',
  prompt: ''
})

export const weekdaysOf: Record<'everyDay' | 'weekdays' | 'weekends', number[]> = {
  everyDay: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6]
}

/** The draft's days and times as cron, or why not. */
export function cronOfDraft(d: Draft, l: Lang): { cron: string } | { error: string } {
  const e = words(l).error
  const runs = (cron: string): boolean => {
    const rules = parseCron(cron)
    return !!rules && nextRun(rules, new Date()) !== null
  }
  if (d.day === 'cron') {
    if (!parseCron(d.cron)) return { error: e.cron }
    return runs(d.cron) ? { cron: d.cron.trim() } : { error: e.never }
  }
  let days: Days
  if (d.day === 'pick') {
    if (d.picked.length === 0) return { error: e.noDays }
    days = daysOf(d.picked)
  } else if (d.day === 'dates') {
    if (d.dates.length === 0) return { error: e.noDates }
    days = { kind: 'dates', dates: d.dates }
  } else {
    days = { kind: d.day }
  }
  let pattern: Pattern
  if (!d.repeat) {
    const list = d.times.map(minuteFromText)
    if (list.length === 0 || list.some((m) => m === null)) return { error: e.times }
    if (list.length > maxTimes) return { error: e.tooManyTimes }
    pattern = { kind: 'times', list: list as number[] }
  } else {
    const n = Number(d.every)
    if (!Number.isInteger(n) || n < 1 || n > maxEvery) return { error: e.every }
    const from = d.allDay ? 0 : minuteFromText(d.from)
    const to = d.allDay ? lastMinute : minuteFromText(d.to)
    if (from === null || to === null) return { error: e.times }
    if (from > to) return { error: e.range }
    pattern = { kind: 'every', n, from, to }
  }
  const cron = cronOfSpec({ days, pattern })
  if (!cron) return { error: e.times }
  return runs(cron) ? { cron } : { error: e.never }
}

/** A saved cron back into the form; a cron the form did not make opens as "Cron". */
export function draftOfCron(cron: string): Partial<Draft> {
  const spec = specOfCron(cron)
  if (!spec) return { day: 'cron', cron }
  const out: Partial<Draft> = { cron }
  const days = spec.days
  if (days.kind === 'some') Object.assign(out, { day: 'pick', picked: days.set })
  else if (days.kind === 'dates') Object.assign(out, { day: 'dates', dates: days.dates })
  else Object.assign(out, { day: days.kind, picked: weekdaysOf[days.kind] })
  const p = spec.pattern
  if (p.kind === 'times') Object.assign(out, { repeat: false, times: p.list.map(clock) })
  else Object.assign(out, { repeat: true, every: String(p.n), allDay: p.from === 0 && p.to === lastMinute, from: clock(p.from), to: clock(p.to) })
  return out
}

export const draftOf = (s: Schedule): Draft => ({
  ...emptyDraft(),
  ...draftOfCron(s.cron),
  id: s.id,
  name: s.name,
  handle: s.terminal.handle,
  clearFirst: s.clearFirst,
  report: s.report,
  prompt: s.prompt
})
