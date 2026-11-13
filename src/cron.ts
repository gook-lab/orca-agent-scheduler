// cron 식 — OrcaCron 앱(Sources/SchedulerCore/Cron.swift)과 같은 규칙.
// 5칸(분 시 일 월 요일), 여섯째 칸이 있으면 연도(2000~2099). 식 여러 개를 `;` 로 이으면 가장 먼저 오는 시각에 돈다.
// 일·요일 칸이 둘 다 `*` 로 시작하지 않으면 둘 중 하나만 맞아도 된다(Vixie cron). 요일 7 은 일요일(0).

export type CronRule = {
  expression: string
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** null = 모든 해 */
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
      // 전체 범위
    } else if (range.includes('-')) {
      const [x, y] = range.split('-').map(int)
      if (x === null || y === null || x === undefined || y === undefined) return null
      a = x
      b = y
    } else {
      const x = int(range)
      if (x === null) return null
      a = x
      b = step > 1 ? hi : x // "5/15" = 5 부터 15 씩
    }
    if (a < lo || b > hi || a > b) return null
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out.size === 0 ? null : out
}

/** `after` 보다 뒤(같은 분 제외)의 첫 실행 시각. 이 기계의 현지 시각 기준. */
export function nextRun(rules: CronRule[], after: Date): Date | null {
  let best: Date | null = null
  for (const rule of rules) {
    const t = nextOf(rule, after)
    if (t && (!best || t < best)) best = t
  }
  return best
}

function nextOf(rule: CronRule, after: Date): Date | null {
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), after.getMinutes() + 1)
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  if (rule.years && first.getFullYear() > Math.max(...rule.years)) return null
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset)
    if (!rule.months.has(day.getMonth() + 1)) continue
    if (rule.years && !rule.years.has(day.getFullYear())) continue
    const dom = rule.days.has(day.getDate())
    const dow = rule.weekdays.has(day.getDay())
    const ok = rule.dayRestricted && rule.weekdayRestricted ? dom || dow : dom && dow
    if (!ok) continue
    for (const h of rule.hours) {
      for (const m of rule.minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
        if (t >= start) return t
      }
    }
  }
  return null
}
