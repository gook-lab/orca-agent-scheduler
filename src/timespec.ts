// The edit form's "when" — which days, and set times or every N minutes in a range. Same rules as
// the OrcaCron app (Sources/SchedulerCore/TimeSpec.swift), so both read each other's cron.
//
// Set times join hours with commas (`0 9,18 * * *`); repeats use ranges and steps
// (`*/5 7 * * *; 0 8 * * *`). Reopening reads `*`, `/` or `-` in the minute or hour field as a repeat.
// Picked dates use the sixth (year) field and run only on those days (`0 9 20,25 11 * 2026`).
import { parseCron, type CronRule } from './cron'
import { type Lang, words } from './i18n'
import { pad2 } from './text'

/** A picked date, `YYYY-MM-DD`. */
export type DayDate = string

export type Days =
  | { kind: 'everyDay' }
  | { kind: 'weekdays' }
  /** Saturday and Sunday; holidays are not considered. */
  | { kind: 'weekends' }
  /** 0 = Sunday … 6 = Saturday. */
  | { kind: 'some'; set: number[] }
  | { kind: 'dates'; dates: DayDate[] }

export type Pattern = { kind: 'times'; list: number[] } | { kind: 'every'; n: number; from: number; to: number }

export type TimeSpec = { days: Days; pattern: Pattern }

export const maxTimes = 24
const dayMinutes = 24 * 60
export const lastMinute = dayMinutes - 1
export const maxEvery = 720
export const maxDates = 366

export const clock = (minute: number): string => `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`

export const dateKey = (y: number, m: number, d: number): DayDate => `${y}-${pad2(m)}-${pad2(d)}`
export const dateParts = (key: DayDate): [number, number, number] => key.split('-').map(Number) as [number, number, number]

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
}

/** All seven days → every day, Monday to Friday → weekdays, Saturday and Sunday → weekends. */
export function daysOf(set: Iterable<number>): Days {
  const s = [...new Set(set)].sort((a, b) => a - b)
  const key = s.join(',')
  if (key === '0,1,2,3,4,5,6') return { kind: 'everyDay' }
  if (key === '1,2,3,4,5') return { kind: 'weekdays' }
  if (key === '0,6') return { kind: 'weekends' }
  return { kind: 'some', set: s }
}

function dayField(days: Days): string | null {
  switch (days.kind) {
    case 'everyDay':
      return '*'
    case 'weekdays':
      return '1-5'
    case 'weekends':
      return '0,6'
    case 'some':
      return days.set.length === 0 ? null : [...days.set].sort((a, b) => a - b).join(',')
    case 'dates':
      return null
  }
}

const part = (r: CronRule, i: number): string => r.expression.split(' ')[i] ?? ''

/** Evenly spaced list → that step. */
function step(list: number[]): number | null {
  if (list.length < 2) return null
  const s = list[1] - list[0]
  return list.every((v, i) => i === 0 || v - list[i - 1] === s) ? s : null
}

/** Ascending list → a cron field: `*`, `a-b`, `*\/s`, `a-b/s` when evenly spaced, else a comma list. */
function compress(list: number[], max: number): string {
  const s = list.length > 1 ? step(list) : null
  if (s === null) return list.join(',')
  const a = list[0]
  const b = list[list.length - 1]
  if (s === 1) return a === 0 && b === max ? '*' : `${a}-${b}`
  if (b + s > max) return a === 0 ? `*/${s}` : `${a}-${max}/${s}`
  return `${a}-${b}/${s}`
}

/** "min hour" of each expression. */
function clockFields(p: Pattern): string[] | null {
  if (p.kind === 'times') {
    const ms = [...new Set(p.list)].filter((t) => t >= 0 && t < dayMinutes)
    if (ms.length === 0) return null
    const byMinute = new Map<number, number[]>()
    for (const t of ms) byMinute.set(t % 60, [...(byMinute.get(t % 60) ?? []), Math.floor(t / 60)])
    return [...byMinute.entries()]
      .map(([m, hours]) => ({ m, hours: hours.sort((a, b) => a - b) }))
      .sort((a, b) => a.hours[0] - b.hours[0] || a.m - b.m)
      .map(({ m, hours }) => `${m} ${hours.join(',')}`)
  }
  const { n, from, to } = p
  if (!(n >= 1 && n <= maxEvery) || from < 0 || from > to || to >= dayMinutes) return null
  const minutesByHour = new Map<number, number[]>()
  for (let t = from; t <= to; t += n) minutesByHour.set(Math.floor(t / 60), [...(minutesByHour.get(Math.floor(t / 60)) ?? []), t % 60])
  // Hours with the same minutes share one expression (every 5 min 07:00–08:00 → `*/5 7`, `0 8`).
  const hoursByMinutes = new Map<string, { ms: number[]; hours: number[] }>()
  for (const [h, ms] of minutesByHour) {
    const key = ms.join(',')
    const g = hoursByMinutes.get(key) ?? { ms, hours: [] }
    g.hours.push(h)
    hoursByMinutes.set(key, g)
  }
  return [...hoursByMinutes.values()]
    .map((g) => ({ ms: g.ms, hours: g.hours.sort((a, b) => a - b) }))
    .sort((a, b) => a.hours[0] - b.hours[0])
    .map((g) => `${compress(g.ms, 59)} ${compress(g.hours, 23)}`)
}

/** The cron to save. Null when days or times are empty, the interval is out of range, or the range runs backwards. */
export function cronOfSpec(spec: TimeSpec): string | null {
  const clocks = clockFields(spec.pattern)
  if (!clocks) return null
  if (spec.days.kind === 'dates') {
    // Days of the same year and month share one expression (`0 9 20,25 11 * 2026`).
    const byMonth = new Map<number, number[]>()
    for (const key of spec.days.dates) {
      const [y, m, d] = dateParts(key)
      byMonth.set(y * 100 + m, [...(byMonth.get(y * 100 + m) ?? []), d])
    }
    if (byMonth.size === 0) return null
    return [...byMonth.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([ym, ds]) => clocks.map((c) => `${c} ${[...new Set(ds)].sort((a, b) => a - b).join(',')} ${ym % 100} * ${Math.floor(ym / 100)}`))
      .join('; ')
  }
  const dow = dayField(spec.days)
  if (dow === null) return null
  return clocks.map((c) => `${c} * * ${dow}`).join('; ')
}

/** Picked dates and the times of day, when every date has the same times. */
function dateTimes(rules: CronRule[]): { dates: DayDate[]; times: Set<number> } | null {
  const byDate = new Map<DayDate, Set<number>>()
  for (const r of rules) {
    if (!r.years || r.weekdays.size !== 7 || r.years.size * r.months.size * r.days.size > maxDates * 4) return null
    const ts = r.hours.flatMap((h) => r.minutes.map((m) => h * 60 + m))
    for (const y of r.years)
      for (const mo of r.months)
        for (const d of r.days) {
          if (!validDate(y, mo, d)) continue
          const key = dateKey(y, mo, d)
          const set = byDate.get(key) ?? new Set<number>()
          for (const t of ts) set.add(t)
          byDate.set(key, set)
        }
  }
  const sets = [...byDate.values()]
  if (sets.length === 0 || sets.length > maxDates || sets[0].size === 0) return null
  const sig = (s: Set<number>): string => [...s].sort((a, b) => a - b).join(',')
  if (!sets.every((s) => sig(s) === sig(sets[0]))) return null
  return { dates: [...byDate.keys()].sort(), times: sets[0] }
}

/** The form's shape for a cron the form made; null opens it as "Cron". */
export function specOfCron(expression: string): TimeSpec | null {
  const rules = parseCron(expression)
  if (!rules) return null
  const stepped = rules.some((r) => /[*/-]/.test(`${part(r, 0)} ${part(r, 1)}`))
  let days: Days
  let set: Set<number>
  if (rules.every((r) => r.years !== null)) {
    const dt = dateTimes(rules)
    if (!dt) return null
    days = { kind: 'dates', dates: dt.dates }
    set = dt.times
  } else {
    const wd = [...rules[0].weekdays].sort((a, b) => a - b).join(',')
    set = new Set<number>()
    for (const r of rules) {
      const everyDate = r.years === null && r.days.size === 31 && r.months.size === 12
      if (!everyDate || [...r.weekdays].sort((a, b) => a - b).join(',') !== wd) return null
      for (const h of r.hours) for (const m of r.minutes) set.add(h * 60 + m)
    }
    days = daysOf(rules[0].weekdays)
  }
  const list = [...set].sort((a, b) => a - b)
  const s = step(list)
  if (stepped && list.length >= 3 && s !== null && s <= maxEvery) {
    // Running to the end of the day keeps the end at 23:59 so it reopens as "All day".
    const last = list[list.length - 1]
    return { days, pattern: { kind: 'every', n: s, from: list[0], to: last + s >= dayMinutes ? lastMinute : last } }
  }
  if (list.length > maxTimes) return null
  return { days, pattern: { kind: 'times', list } }
}

// Monday first, Sunday last.
const weekOrder = (d: number): number => (d + 6) % 7

function daysText(days: Days, lang: Lang): string {
  const w = words(lang)
  switch (days.kind) {
    case 'everyDay':
      return lang === 'ko' ? '매일' : 'Every day'
    case 'weekdays':
      return lang === 'ko' ? '평일' : 'Weekdays'
    case 'weekends':
      return lang === 'ko' ? '주말' : 'Weekends'
    case 'some': {
      const names = [...days.set].sort((a, b) => weekOrder(a) - weekOrder(b)).map((d) => w.weekdays[d])
      return lang === 'ko' ? `매주 ${names.join('·')}` : `Every ${names.join('·')}`
    }
    case 'dates': {
      const list = [...days.dates].sort().map((k) => {
        const [, m, d] = dateParts(k)
        return `${m}/${d}`
      })
      if (list.length <= 3) return list.join(', ')
      return lang === 'ko' ? `${list[0]} 등 ${list.length}일` : `${list[0]} +${list.length - 1} more`
    }
  }
}

function intervalText(n: number, lang: Lang): string {
  const h = Math.floor(n / 60)
  const m = n % 60
  if (lang === 'ko') return n < 60 ? `${n}분마다` : m === 0 ? `${h}시간마다` : `${h}시간 ${m}분마다`
  return n < 60 ? `every ${n} min` : m === 0 ? `every ${h} h` : `every ${h} h ${m} min`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function specSummary(spec: TimeSpec, lang: Lang): string {
  const days = daysText(spec.days, lang)
  const everyDay = spec.days.kind === 'everyDay'
  const p = spec.pattern
  if (p.kind === 'times') {
    const ts = [...new Set(p.list)].sort((a, b) => a - b)
    const sameMinute = new Set(ts.map((t) => t % 60)).size === 1
    if (sameMinute && ts.length >= 4) {
      const hours = ts.map((t) => pad2(Math.floor(t / 60))).join('·')
      return lang === 'ko' ? `${days} ${hours}시 ${pad2(ts[0] % 60)}분` : `${days} at :${pad2(ts[0] % 60)} past ${hours}`
    }
    return `${days} ${ts.map(clock).join(' · ')}`
  }
  const { n, from, to } = p
  const wholeDay = to + n >= dayMinutes
  if (n === 60 && from < 60 && wholeDay) {
    if (lang === 'ko') return `${everyDay ? '' : `${days} `}매시 ${pad2(from)}분`
    return `${everyDay ? 'Hourly' : `${days}, hourly`} at :${pad2(from)}`
  }
  const interval = intervalText(n, lang)
  if (from === 0 && wholeDay) {
    if (lang === 'ko') return everyDay ? interval : `${days} ${interval}`
    return everyDay ? capital(interval) : `${days}, ${interval}`
  }
  return lang === 'ko' ? `${days} ${clock(from)}~${clock(to)} ${interval}` : `${days} ${clock(from)}–${clock(to)}, ${interval}`
}

/** One readable line; a cron the form did not make shows as written. */
export function describe(expression: string, lang: Lang): string {
  const spec = specOfCron(expression)
  return spec ? specSummary(spec, lang) : expression
}

const halfDay = /a\.?m\.?|p\.?m\.?|오전|오후/gi

/** A typed time → minute of the day. Takes `9:30`, `09:30`, `930`, `0930`, `9`, `9시 30분`, `7.05`, and a
 *  12-hour time said with its half — `9:30 pm`, `9pm`, `오후 9시`. */
export function minuteFromText(text: string): number | null {
  const [said, ...more] = text.match(halfDay) ?? []
  if (more.length > 0) return null
  const half = said === undefined ? null : /^p|오후/i.test(said) ? 'pm' : 'am'
  let t = text.replace(halfDay, '').trim().replace(/분/g, '').replace(/시/g, ':').replace(/\./g, ':').replace(/\s/g, '')
  if (t.endsWith(':')) t = t.slice(0, -1)
  const parts = t.split(':')
  let h: number
  let m: number
  if (parts.length === 2) {
    if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) return null
    h = Number(parts[0])
    m = Number(parts[1])
  } else if (parts.length === 1 && /^\d+$/.test(t)) {
    if (t.length <= 2) {
      h = Number(t)
      m = 0
    } else if (t.length <= 4) {
      h = Number(t.slice(0, -2))
      m = Number(t.slice(-2))
    } else return null
  } else return null
  if (half) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (half === 'pm' ? 12 : 0)
  }
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/** The clock the times are read on — this computer's zone, as `Asia/Seoul, UTC+9`. */
export function zoneText(now: Date = new Date()): string {
  const offset = -now.getTimezoneOffset()
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  const utc = `UTC${offset < 0 ? '−' : '+'}${hours}${minutes ? `:${pad2(minutes)}` : ''}`
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone
  return name ? `${name}, ${utc}` : utc
}
