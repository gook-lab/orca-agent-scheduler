// Cron expressions — the same rules as the OrcaCron app (Sources/SchedulerCore/Cron.swift).
// Five fields (minute hour day month weekday); a sixth, when there, is the year (2000–2099). Several
// expressions joined by `;` run at whichever time comes first. When neither the day nor the weekday
// field starts with `*`, matching either one is enough (Vixie cron). Weekday 7 is Sunday (0).

export type CronRule = {
  expression: string
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** null = every year */
  years: Set<number> | null
  dayRestricted: boolean
  weekdayRestricted: boolean
}

export function parseCron(expression: string): CronRule[] | null {
  const pieces = expression
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (pieces.length === 0) return null
  const rules: CronRule[] = []
  for (const piece of pieces) {
    const rule = parseRule(piece)
    if (!rule) return null
    rules.push(rule)
  }
  return rules
}

function parseRule(text: string): CronRule | null {
  const parts = text.split(/\s+/).filter((p) => p.length > 0)
  if (parts.length !== 5 && parts.length !== 6) return null
  const minutes = field(parts[0], 0, 59)
  const hours = field(parts[1], 0, 23)
  const days = field(parts[2], 1, 31)
  const months = field(parts[3], 1, 12)
  const weekdays = field(parts[4], 0, 7)
  if (!minutes || !hours || !days || !months || !weekdays) return null
  if (weekdays.has(7)) {
    weekdays.delete(7)
    weekdays.add(0)
  }
  let years: Set<number> | null = null
  if (parts.length === 6) {
    years = field(parts[5], 2000, 2099)
    if (!years) return null
  }
  return {
    expression: parts.join(' '),
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    days,
    months,
    weekdays,
    years,
    dayRestricted: !parts[2].startsWith('*'),
    weekdayRestricted: !parts[4].startsWith('*')
  }
}

function int(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null
}

function field(text: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>()
  for (const item of text.split(',')) {
    let range = item
    let step = 1
    const slash = item.indexOf('/')
    if (slash >= 0) {
      const s = int(item.slice(slash + 1))
      if (s === null || s <= 0) return null
      step = s
      range = item.slice(0, slash)
    }
    let a = lo
    let b = hi
    if (range === '*') {
      // the whole range
    } else if (range.includes('-')) {
      const [x, y] = range.split('-').map(int)
      if (x === null || y === null || x === undefined || y === undefined) return null
      a = x
      b = y
    } else {
      const x = int(range)
      if (x === null) return null
      a = x
      b = step > 1 ? hi : x // "5/15" = from 5, every 15
    }
    if (a < lo || b > hi || a > b) return null
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out.size === 0 ? null : out
}

/** The first run after `after` (not within the same minute), in this computer's local time. */
export function nextRun(rules: CronRule[], after: Date): Date | null {
  let best: Date | null = null
  for (const rule of rules) {
    const t = nextOf(rule, after)
    if (t && (!best || t < best)) best = t
  }
  return best
}

/** How far ahead a rule without years is searched — the gap between two leap days around 2100. A rule
 *  with years is searched to its last one. Months that cannot match are stepped over whole. */
const SEARCH_YEARS = 8

function nextOf(rule: CronRule, after: Date): Date | null {
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), after.getMinutes() + 1)
  const lastYear = rule.years ? Math.max(...rule.years) : start.getFullYear() + SEARCH_YEARS
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  while (day.getFullYear() <= lastYear) {
    if (!rule.months.has(day.getMonth() + 1) || (rule.years && !rule.years.has(day.getFullYear()))) {
      day = new Date(day.getFullYear(), day.getMonth() + 1, 1)
      continue
    }
    const dom = rule.days.has(day.getDate())
    const dow = rule.weekdays.has(day.getDay())
    if (rule.dayRestricted && rule.weekdayRestricted ? dom || dow : dom && dow) {
      for (const h of rule.hours) {
        for (const m of rule.minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
          if (t >= start) return t
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return null
}
