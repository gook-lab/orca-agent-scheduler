// Schedules panel — laid out like the OrcaCron menubar app: what runs next and counts on top, then one
// block per agent terminal with its schedules, then the terminals without schedules. Pressing a
// terminal's name brings Orca to it. The form (new · edit · send once) replaces the list while open.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  IconButton,
  Input,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Stack,
  Switch,
  Text,
  Textarea,
  update,
  type IconName,
  type PanelContext
} from 'orca'
import { nextRun, parseCron } from './cron'
import type { Schedule, TerminalRef } from './engine'
import { attentionCodes, type Lang, langOptions, noteText, recordText, statusText, whenText, words } from './i18n'
import { LANG_KEY, type TerminalOption } from './protocol'
import { type AgentKind, agentKind, agentName } from './screen'
import {
  clock,
  cronOfSpec,
  dateKey,
  dateParts,
  type Days,
  daysOf,
  describe,
  maxTimes,
  minuteFromText,
  type Pattern,
  specOfCron
} from './timespec'

/** The worker's schedules — asked once, then pushed on every change. */
const schedules = atom<Schedule[]>([])
/** Agent terminals open in Orca; null until the first answer. Pushed by the worker when it changes. */
const terminals = atom<TerminalOption[] | null>(null)
/** English by default; stored in plugin storage so the worker words notifications the same way. */
const lang = atom<Lang>(LANG_KEY, 'en', { persist: 'storage' })
/** Terminal blocks folded shut, by pane id. */
const collapsed = atom<string[]>([])
/** Terminals without schedules beyond the first IDLE_PREVIEW are shown. */
const showAllIdle = atom(false)
/** The schedule just deleted, while Undo is offered. */
const undone = atom<Schedule | null>(null)

const IDLE_PREVIEW = 4
const UNDO_MS = 8000

type DayMode = 'everyDay' | 'weekdays' | 'weekends' | 'pick' | 'dates' | 'cron'
const dayModes: DayMode[] = ['everyDay', 'weekdays', 'weekends', 'pick', 'dates', 'cron']

type Draft = {
  id?: string
  /** Send once now — no days or times. */
  once: boolean
  name: string
  handle: string
  clearFirst: boolean
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

const emptyDraft = (): Draft => ({
  once: false,
  name: '',
  handle: '',
  clearFirst: false,
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
const draft = atom<Draft>(emptyDraft())
const formOpen = atom(false)
const formError = atom<string | null>(null)
const saving = atom(false)

const thisMonth = (): { y: number; m: number } => {
  const t = new Date()
  return { y: t.getFullYear(), m: t.getMonth() + 1 }
}
/** The month the date calendar shows. */
const month = atom(thisMonth())

async function refreshTerminals(): Promise<void> {
  try {
    set(terminals, await plugin.request('terminals.list'))
  } catch {
    set(terminals, [])
  }
}

function openForm(d: Draft): void {
  set(draft, d)
  const first = d.dates[0]
  if (first) {
    const [y, m] = dateParts(first)
    set(month, { y, m })
  } else set(month, thisMonth())
  set(formError, null)
  set(formOpen, true)
  void refreshTerminals()
}

const openNew = (handle = ''): void => openForm({ ...emptyDraft(), handle })
const openSend = (handle = ''): void => openForm({ ...emptyDraft(), once: true, handle })

function closeForm(): void {
  set(draft, emptyDraft())
  set(formError, null)
  set(formOpen, false)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('schedules.changed', (p) => set(schedules, p.schedules)))
  ctx.subscriptions.push(plugin.on('terminals.changed', (p) => set(terminals, p.terminals)))
  // Wakes the worker and gets the current list.
  void plugin.request('schedules.list').then((list) => set(schedules, list)).catch(() => undefined)
  void refreshTerminals()
}

const weekdaysOf: Record<'everyDay' | 'weekdays' | 'weekends', number[]> = {
  everyDay: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6]
}

/** The draft's days and times as cron, or why not. */
function cronOfDraft(d: Draft, l: Lang): { cron: string } | { error: string } {
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
    if (!Number.isInteger(n) || n < 1 || n > 720) return { error: e.every }
    const from = d.allDay ? 0 : minuteFromText(d.from)
    const to = d.allDay ? 1439 : minuteFromText(d.to)
    if (from === null || to === null) return { error: e.times }
    if (from > to) return { error: e.range }
    pattern = { kind: 'every', n, from, to }
  }
  const cron = cronOfSpec({ days, pattern })
  if (!cron) return { error: e.times }
  return runs(cron) ? { cron } : { error: e.never }
}

/** A saved cron back into the form; a cron the form did not make opens as "Cron". */
function draftOfCron(cron: string): Partial<Draft> {
  const spec = specOfCron(cron)
  if (!spec) return { day: 'cron', cron }
  const out: Partial<Draft> = { cron }
  const days = spec.days
  if (days.kind === 'some') Object.assign(out, { day: 'pick', picked: days.set })
  else if (days.kind === 'dates') Object.assign(out, { day: 'dates', dates: days.dates })
  else Object.assign(out, { day: days.kind, picked: weekdaysOf[days.kind] })
  const p = spec.pattern
  if (p.kind === 'times') Object.assign(out, { repeat: false, times: p.list.map(clock) })
  else Object.assign(out, { repeat: true, every: String(p.n), allDay: p.from === 0 && p.to === 1439, from: clock(p.from), to: clock(p.to) })
  return out
}

const draftOf = (s: Schedule): Draft => ({
  ...emptyDraft(),
  ...draftOfCron(s.cron),
  id: s.id,
  name: s.name,
  handle: s.terminal.handle,
  clearFirst: s.clearFirst,
  prompt: s.prompt
})

const edit = (s: Schedule): void => openForm(draftOf(s))

/** A copy to save as a new schedule. */
function duplicate(s: Schedule): void {
  const { id: _id, ...rest } = draftOf(s)
  openForm({ ...rest, name: words(read(lang)).ui.copyOf(s.name) })
}

function remove(s: Schedule): void {
  set(undone, s)
  void plugin.request('schedules.delete', { id: s.id })
  const timer = setTimeout(() => {
    if (read(undone)?.id === s.id) set(undone, null)
  }, UNDO_MS)
  // Node (`orca plugin test`) would otherwise wait for the timer before exiting.
  ;(timer as { unref?: () => void }).unref?.()
}

function restore(): void {
  const s = read(undone)
  if (!s) return
  set(undone, null)
  void plugin.request('schedules.restore', { schedule: s })
}

async function focusTerminal(handle: string): Promise<void> {
  const r = await plugin.request('terminals.focus', { handle }).catch(() => ({ ok: false }))
  // The handle may have changed (Orca restarted) — read the list again.
  if (!r.ok) await refreshTerminals()
}

const sameTerminal = (a: Pick<TerminalRef, 'handle' | 'leafId'>, b: Pick<TerminalRef, 'handle' | 'leafId'>): boolean =>
  a.handle === b.handle || (!!a.leafId && a.leafId === b.leafId)

const terminalLabel = (t: TerminalRef): string => {
  const k = agentKind(t.agent)
  return [k ? agentName[k] : t.agent, t.title, t.workspace].filter(Boolean).join(' · ')
}

async function save(): Promise<void> {
  const l = read(lang)
  const d = read(draft)
  const c = d.once ? { cron: '' } : cronOfDraft(d, l)
  if ('error' in c) return set(formError, c.error)
  const old = read(schedules).find((s) => s.id === d.id)
  const terminal = (read(terminals) ?? []).find((t) => t.handle === d.handle) ?? (old && old.terminal.handle === d.handle ? old.terminal : null)
  if (!terminal) return set(formError, words(l).error.terminal)
  set(saving, true)
  try {
    await plugin.request('schedules.save', {
      ...(d.id ? { id: d.id } : {}),
      ...(d.once ? { once: true } : {}),
      name: d.name,
      terminal,
      cron: c.cron,
      prompt: d.prompt,
      enabled: old?.enabled ?? true,
      clearFirst: d.clearFirst
    })
    closeForm()
  } catch (error) {
    set(formError, (error as Error).message)
  } finally {
    set(saving, false)
  }
}

const statusTone = (status: Schedule['lastStatus']): 'success' | 'danger' | 'warning' | 'neutral' | 'accent' =>
  status === 'success' || status === 'done' || status === 'doneWaiting'
    ? 'success'
    : status === 'failed' || status === 'noResult'
      ? 'danger'
      : status === 'skipped' || status === 'aborted'
        ? 'warning'
        : status === 'sent'
          ? 'accent'
          : 'neutral'

/** Waiting on something a person must fix — the worker turns the status bar orange for the same. */
const needsAttention = (s: Schedule): boolean =>
  s.blocked !== null || (s.pendingSince !== null && s.waitNote !== null && attentionCodes.includes(s.waitNote.code))

// ───────────────────────── Top — next run and counts ─────────────────────────

function Summary() {
  const l = read(lang)
  const u = words(l).ui
  const list = read(schedules)
  const recurring = list.filter((s) => !s.once)
  const next = recurring
    .filter((s) => s.enabled && s.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const today = list.reduce((n, s) => n + s.history.filter((r) => r.at >= midnight.getTime()).length, 0)
  const waiting = list.filter((s) => s.pendingSince !== null).length
  const running = list.filter((s) => s.sentAt !== null).length
  const attention = list.filter(needsAttention).length
  return (
    <Stack gap="xs">
      <Box direction="row" justify="between" align="center" gap="sm">
        <Box grow shrink minWidth={0}>
          <Text size="sm" weight="semibold" truncate>
            {next?.nextRunAt ? u.nextUp(whenText(l, next.nextRunAt), next.name) : u.noneUp}
          </Text>
        </Box>
        <Box width={110} shrink={false}>
          <Select label={u.language} labelHidden value={l} options={langOptions} onChange={(v) => set(lang, v === 'ko' ? 'ko' : 'en')} />
        </Box>
      </Box>
      <Row gap="xs" wrap>
        <Badge>{u.stats.schedules(recurring.length)}</Badge>
        <Badge tone="success">{u.stats.on(recurring.filter((s) => s.enabled).length)}</Badge>
        {waiting > 0 ? <Badge>{u.stats.waiting(waiting)}</Badge> : null}
        {running > 0 ? <Badge tone="accent">{u.stats.running(running)}</Badge> : null}
        {attention > 0 ? <Badge tone="warning">{u.stats.attention(attention)}</Badge> : null}
        <Badge>{u.stats.today(today)}</Badge>
      </Row>
    </Stack>
  )
}

// ───────────────────────── Terminal line — agent, live dot, name ─────────────────────────

const agentIcon: Record<AgentKind, IconName> = { claude: 'star', codex: 'terminal', gemini: 'zap' }

/** One terminal: agent icon, a green dot while it is open, workspace and title (press to show it in
 *  Orca), then send once and new schedule. A closed terminal stays, faded, with its last known agent. */
function TerminalLine({ term: t, live, fold }: { term: TerminalRef; live: TerminalOption | null; fold?: { open: boolean; toggle: () => void } }) {
  const u = words(read(lang)).ui
  const kind = agentKind(live?.agent ?? t.agent)
  const focus = () => (live ? void focusTerminal(live.handle) : undefined)
  return (
    <Box direction="row" align="center" gap="xs">
      {fold ? (
        <IconButton icon={fold.open ? 'collapse' : 'expand'} size="xs" variant="ghost" label={fold.open ? u.collapse : u.expand} onPress={fold.toggle} />
      ) : null}
      <IconButton
        icon={kind ? agentIcon[kind] : 'agent'}
        size="xs"
        variant="ghost"
        tone={live ? 'accent' : 'neutral'}
        label={`${kind ? agentName[kind] : t.agent} — ${u.showInOrca}`}
        disabled={!live}
        onPress={focus}
      />
      {/* A Box background is only a tint — a glyph gives a solid dot. */}
      <Text size="xs" tone={live ? 'success' : 'neutral'} muted={!live}>
        ●
      </Text>
      <Box direction="row" align="center" gap="xs" grow shrink minWidth={0}>
        <Button size="xs" variant="ghost" tooltip={u.showInOrca} disabled={!live} onPress={focus}>
          {t.workspace || t.title}
        </Button>
        <Text size="xs" muted truncate>
          {t.workspace ? t.title : ''}
        </Text>
      </Box>
      <IconButton
        icon="next"
        size="xs"
        variant="ghost"
        label={u.sendOnce}
        tooltip={u.sendOnceTip}
        disabled={!live}
        onPress={() => (live ? openSend(live.handle) : undefined)}
      />
      <IconButton icon="add" size="xs" variant="ghost" label={u.newHere} disabled={!live} onPress={() => (live ? openNew(live.handle) : undefined)} />
    </Box>
  )
}

// ───────────────────────── Schedule — switch, actions, next run, last result ─────────────────────────

function ScheduleRow({ s, live }: { s: Schedule; live: boolean }) {
  const l = read(lang)
  const u = words(l).ui
  const last = s.history[0]
  const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null)
  const noteLine = note ? noteText(l, note) : !live && read(terminals) !== null ? u.terminalGone : null
  const nextText = s.enabled ? (s.nextRunAt !== null ? `${u.next} ${whenText(l, s.nextRunAt)}` : u.never) : u.off
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Box direction="row" align="center" gap="xs">
        <Box grow shrink minWidth={0}>
          <Switch label={s.name} checked={s.enabled} onChange={(enabled) => void plugin.request('schedules.toggle', { id: s.id, enabled })} />
        </Box>
        <IconButton icon="play" size="sm" variant="ghost" label={u.sendNow} tooltip={u.sendNowTip} onPress={() => void plugin.request('schedules.runNow', { id: s.id })} />
        <IconButton icon="edit" size="sm" variant="ghost" label={u.edit} onPress={() => edit(s)} />
        <IconButton icon="copy" size="sm" variant="ghost" label={u.duplicate} onPress={() => duplicate(s)} />
        <IconButton icon="delete" size="sm" variant="ghost" label={u.remove} onPress={() => remove(s)} />
      </Box>
      <Text size="xs" muted>
        {[nextText, describe(s.cron, l), s.clearFirst ? '/clear' : ''].filter(Boolean).join(' · ')}
      </Text>
      {s.sentAt !== null ? (
        <Text size="xs" tone="accent">{`${u.running} ${whenText(l, s.sentAt)}`}</Text>
      ) : last ? (
        <Row gap="xs">
          <Badge tone={statusTone(last.status)}>{statusText(l, last.status)}</Badge>
          <Text muted size="xs" truncate>
            {[whenText(l, last.at), recordText(l, last)].filter(Boolean).join(' · ')}
          </Text>
        </Row>
      ) : null}
      {noteLine ? (
        <Callout tone="warning" icon="warning" title={u.attention}>
          {noteLine}
        </Callout>
      ) : null}
      {s.history.length > 1 ? (
        <Collapsible title={u.history(s.history.length)}>
          <Stack gap="xs">
            {s.history.slice(0, 10).map((r) => (
              <Row gap="xs">
                <Badge tone={statusTone(r.status)}>{statusText(l, r.status)}</Badge>
                <Text muted size="xs" truncate>
                  {[whenText(l, r.at), recordText(l, r)].filter(Boolean).join(' · ')}
                </Text>
              </Row>
            ))}
          </Stack>
        </Collapsible>
      ) : null}
    </Box>
  )
}

/** Send-once records under a terminal, newest first; folded unless one is still on its way. */
function SentList({ list }: { list: Schedule[] }) {
  const l = read(lang)
  const u = words(l).ui
  const at = (s: Schedule) => s.sentAt ?? s.pendingSince ?? s.history[0]?.at ?? 0
  const sorted = [...list].sort((a, b) => at(b) - at(a))
  const busy = sorted.some((s) => s.pendingSince !== null || s.sentAt !== null)
  return (
    <Collapsible title={u.sentGroup(sorted.length, sorted[0] ? whenText(l, at(sorted[0])) : null)} defaultOpen={busy}>
      <Stack gap="xs">
        {sorted.map((s) => {
          const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null)
          const status = s.pendingSince !== null ? null : s.sentAt !== null ? 'sent' : s.lastStatus
          return (
            <Stack gap="none">
              <Box direction="row" align="center" gap="xs">
                <Badge tone={statusTone(status)}>{status ? statusText(l, status) : u.waitingToSend}</Badge>
                <Box grow shrink minWidth={0}>
                  <Text size="xs" truncate>
                    {s.name}
                  </Text>
                </Box>
                <Text size="xs" muted>
                  {whenText(l, at(s))}
                </Text>
                <IconButton icon="delete" size="xs" variant="ghost" label={u.remove} onPress={() => remove(s)} />
              </Box>
              {note ? (
                <Text size="xs" tone="warning">
                  {noteText(l, note)}
                </Text>
              ) : null}
            </Stack>
          )
        })}
      </Stack>
    </Collapsible>
  )
}

// ───────────────────────── Blocks — one per terminal ─────────────────────────

type Group = { key: string; ref: TerminalRef; live: TerminalOption | null; recurring: Schedule[]; once: Schedule[] }

/** Schedules by terminal (a closed one keeps its block), and the open terminals with none. */
function groupsOf(list: Schedule[], open: TerminalOption[] | null): { groups: Group[]; idle: TerminalOption[] } {
  const groups = new Map<string, Group>()
  for (const s of list) {
    const live = open?.find((t) => sameTerminal(t, s.terminal)) ?? null
    const key = live?.leafId || s.terminal.leafId || live?.handle || s.terminal.handle || s.id
    const g = groups.get(key) ?? { key, ref: live ?? s.terminal, live, recurring: [], once: [] }
    ;(s.once ? g.once : g.recurring).push(s)
    groups.set(key, g)
  }
  const used = [...groups.values()].map((g) => g.live?.handle)
  const idle = (open ?? []).filter((t) => !used.includes(t.handle))
  const sorted = [...groups.values()].sort((a, b) => a.ref.workspace.localeCompare(b.ref.workspace) || a.ref.title.localeCompare(b.ref.title))
  return { groups: sorted, idle }
}

function TerminalBlock({ g }: { g: Group }) {
  const l = read(lang)
  const u = words(l).ui
  const open = !read(collapsed).includes(g.key)
  const toggle = () => update(collapsed, (keys) => (open ? [...keys, g.key] : keys.filter((k) => k !== g.key)))
  const next = g.recurring.filter((s) => s.enabled && s.nextRunAt !== null).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  return (
    <Stack gap="xs">
      <TerminalLine term={g.ref} live={g.live} fold={{ open, toggle }} />
      {open ? (
        <Stack gap="xs">
          {g.recurring.map((s) => (
            <ScheduleRow s={s} live={g.live !== null} />
          ))}
          {g.once.length > 0 ? <SentList list={g.once} /> : null}
        </Stack>
      ) : (
        <Text size="xs" muted>
          {u.groupSummary(g.recurring.length, next?.nextRunAt ? whenText(l, next.nextRunAt) : null)}
        </Text>
      )}
    </Stack>
  )
}

function IdleTerminals({ idle }: { idle: TerminalOption[] }) {
  const u = words(read(lang)).ui
  const all = read(showAllIdle)
  const shown = all ? idle : idle.slice(0, IDLE_PREVIEW)
  return (
    <Stack gap="xs">
      <Text size="xs" muted weight="semibold">
        {u.idleTerminals(idle.length)}
      </Text>
      {shown.map((t) => (
        <TerminalLine term={t} live={t} />
      ))}
      {idle.length > IDLE_PREVIEW ? (
        <Row>
          <Button size="xs" variant="ghost" icon={all ? 'collapse' : 'expand'} onPress={() => set(showAllIdle, !all)}>
            {all ? u.less : u.more(idle.length - IDLE_PREVIEW)}
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

/** Pick days — Monday first. */
function DayPicker() {
  const d = read(draft)
  const names = words(read(lang)).weekdays
  return (
    <Row gap="xs" wrap>
      {[1, 2, 3, 4, 5, 6, 0].map((day) => {
        const on = d.picked.includes(day)
        return (
          <Button
            size="sm"
            variant={on ? 'solid' : 'outline'}
            tone={on ? 'accent' : 'neutral'}
            onPress={() => update(draft, (x) => ({ ...x, picked: on ? x.picked.filter((p) => p !== day) : [...x.picked, day].sort() }))}
          >
            {names[day]}
          </Button>
        )
      })}
    </Row>
  )
}

/** Date calendar — press a day to pick or unpick it, across months; past days cannot be picked (up to 12 months ahead). */
function DateCalendar() {
  const l = read(lang)
  const w = words(l)
  const d = read(draft)
  const { y, m } = read(month)
  const now = thisMonth()
  const offset = (y - now.y) * 12 + (m - now.m)
  const today = new Date()
  const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate())
  const firstDow = new Date(y, m - 1, 1).getDay()
  const length = new Date(y, m, 0).getDate()
  const cells: (number | null)[] = [...Array<null>(firstDow).fill(null), ...Array.from({ length }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
  const go = (n: number) => update(month, ({ y, m }) => ({ y: y + Math.floor((m - 1 + n) / 12), m: ((((m - 1 + n) % 12) + 12) % 12) + 1 }))
  const toggle = (key: string) =>
    update(draft, (x) => ({ ...x, dates: x.dates.includes(key) ? x.dates.filter((k) => k !== key) : [...x.dates, key].sort() }))
  return (
    <Box gap="xs" border radius="md" padding="sm">
      <Box direction="row" justify="between" align="center">
        <Button size="sm" variant="ghost" tooltip={w.ui.prevMonth} disabled={offset <= 0} onPress={() => go(-1)}>
          ‹
        </Button>
        <Text size="sm" weight="semibold">
          {w.monthTitle(y, m)}
        </Text>
        <Button size="sm" variant="ghost" tooltip={w.ui.nextMonth} disabled={offset >= 12} onPress={() => go(1)}>
          ›
        </Button>
      </Box>
      <Box direction="row">
        {w.weekdays.map((name) => (
          <Box width="14%" align="center">
            <Text muted size="xs">
              {name}
            </Text>
          </Box>
        ))}
      </Box>
      {weeks.map((week) => (
        <Box direction="row">
          {week.map((day) => {
            if (day === null) return <Box width="14%" />
            const key = dateKey(y, m, day)
            const on = d.dates.includes(key)
            return (
              <Box width="14%" align="stretch" padding="none">
                <Button size="xs" variant={on ? 'solid' : 'ghost'} tone={on ? 'accent' : 'neutral'} disabled={key < todayKey} onPress={() => toggle(key)}>
                  {String(day)}
                </Button>
              </Box>
            )
          })}
        </Box>
      ))}
      <Text muted size="xs">
        {w.ui.picked(d.dates.length)}
      </Text>
    </Box>
  )
}

function TimeFields() {
  const u = words(read(lang)).ui
  const d = read(draft)
  const patch = (p: Partial<Draft>) => update(draft, (x) => ({ ...x, ...p }))
  return (
    <Stack gap="xs">
      <RadioGroup
        label={u.time}
        orientation="horizontal"
        value={d.repeat ? 'every' : 'times'}
        options={[
          { value: 'times', label: u.pattern.times },
          { value: 'every', label: u.pattern.every }
        ]}
        onChange={(v) => patch({ repeat: v === 'every' })}
      />
      {d.repeat ? (
        <Stack gap="xs">
          <Input label={u.everyMinutes} value={d.every} invalid={!/^\d+$/.test(d.every)} onChange={(every) => patch({ every })} />
          <RadioGroup
            label={u.range.between}
            labelHidden
            orientation="horizontal"
            value={d.allDay ? 'allDay' : 'between'}
            options={[
              { value: 'allDay', label: u.range.allDay },
              { value: 'between', label: u.range.between }
            ]}
            onChange={(v) => patch({ allDay: v === 'allDay' })}
          />
          {d.allDay ? null : (
            <Box direction="row" gap="xs">
              <Box grow>
                <Input label={u.from} value={d.from} invalid={minuteFromText(d.from) === null} onChange={(from) => patch({ from })} />
              </Box>
              <Box grow>
                <Input label={u.to} value={d.to} invalid={minuteFromText(d.to) === null} onChange={(to) => patch({ to })} />
              </Box>
            </Box>
          )}
        </Stack>
      ) : (
        <Stack gap="xs">
          {d.times.map((t, i) => (
            <Box direction="row" gap="xs" align="end">
              <Box grow>
                <Input
                  label={u.timeN(i + 1)}
                  labelHidden
                  value={t}
                  placeholder="09:00"
                  invalid={minuteFromText(t) === null}
                  onChange={(v) => update(draft, (x) => ({ ...x, times: x.times.map((old, j) => (j === i ? v : old)) }))}
                />
              </Box>
              {d.times.length > 1 ? (
                <IconButton
                  icon="remove"
                  label={u.removeTime(i + 1)}
                  onPress={() => update(draft, (x) => ({ ...x, times: x.times.filter((_, j) => j !== i) }))}
                />
              ) : null}
            </Box>
          ))}
          <Row>
            <Button
              size="sm"
              variant="ghost"
              icon="add"
              disabled={d.times.length >= maxTimes}
              onPress={() => update(draft, (x) => ({ ...x, times: [...x.times, ''] }))}
            >
              {u.addTime}
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  )
}

// ───────────────────────── Form — new · edit · send once ─────────────────────────

function Form() {
  const l = read(lang)
  const u = words(l).ui
  const d = read(draft)
  const open = read(terminals)
  const old = read(schedules).find((s) => s.id === d.id)
  const options = (open ?? []).map((t) => ({ value: t.handle, label: terminalLabel(t) }))
  if (old && d.handle && !options.some((o) => o.value === d.handle)) {
    options.unshift({ value: d.handle, label: `${terminalLabel(old.terminal)} (${u.notOpen})` })
  }
  const c = d.once ? null : cronOfDraft(d, l)
  const patch = (p: Partial<Draft>) => update(draft, (x) => ({ ...x, ...p }))
  const changeDay = (v: string) => {
    const day = v as DayMode
    const p: Partial<Draft> = { day }
    // From every day · weekdays · weekends into "Pick days", start with those days on.
    if (day === 'pick' && (d.day === 'everyDay' || d.day === 'weekdays' || d.day === 'weekends')) p.picked = weekdaysOf[d.day]
    // Into "Cron", start from what the form had.
    if (day === 'cron' && c && 'cron' in c) p.cron = c.cron
    patch(p)
  }
  const blocked = read(saving) || !d.handle || (c !== null && 'error' in c) || (d.once && !d.prompt.trim())
  return (
    <Stack gap="sm">
      <Box direction="row" align="center" gap="xs">
        <Button size="sm" variant="ghost" onPress={closeForm}>
          {`‹ ${u.back}`}
        </Button>
        <Text weight="semibold">{d.once ? u.sendOnce : d.id ? u.editSchedule : u.newSchedule}</Text>
      </Box>
      <Input
        label={u.name}
        value={d.name}
        placeholder={d.once ? u.namePlaceholderOnce : u.namePlaceholder}
        onChange={(name) => patch({ name })}
      />
      <Box direction="row" gap="xs" align="end">
        <Box grow>
          <Select
            label={u.terminal}
            value={d.handle}
            placeholder={open !== null && open.length === 0 ? u.noTerminals : u.terminalPlaceholder}
            options={options}
            onChange={(handle) => patch({ handle })}
          />
        </Box>
        <IconButton icon="refresh" label={u.refreshTerminals} onPress={() => void refreshTerminals()} />
      </Box>
      <Checkbox label={u.clearFirst} description={u.clearFirstHint} checked={d.clearFirst} onChange={(clearFirst) => patch({ clearFirst })} />
      {c === null ? null : (
        <Stack gap="sm">
          <Select label={u.days} value={d.day} options={dayModes.map((m) => ({ value: m, label: u.dayChoice[m] }))} onChange={changeDay} />
          {d.day === 'pick' ? <DayPicker /> : null}
          {d.day === 'dates' ? <DateCalendar /> : null}
          {d.day === 'cron' ? (
            <Input label={u.cron} value={d.cron} placeholder={u.cronPlaceholder} onChange={(cron) => patch({ cron })} invalid={'error' in c} />
          ) : (
            <TimeFields />
          )}
          <Text muted size="xs">
            {'error' in c ? c.error : describe(c.cron, l)}
          </Text>
        </Stack>
      )}
      <Textarea label={u.prompt} rows={4} value={d.prompt} placeholder={u.promptPlaceholder} onChange={(prompt) => patch({ prompt })} />
      {d.once ? (
        <Text muted size="xs">
          {u.sendHint}
        </Text>
      ) : null}
      {read(formError) ? (
        <Callout tone="danger" title={u.problem}>
          {read(formError)}
        </Callout>
      ) : null}
      <Row gap="xs">
        <Button tone="accent" variant="solid" icon={d.once ? 'next' : undefined} disabled={blocked} onPress={() => void save()}>
          {d.once ? u.send : d.id ? u.save : u.create}
        </Button>
        <Button variant="ghost" onPress={closeForm}>
          {u.cancel}
        </Button>
      </Row>
    </Stack>
  )
}

// ───────────────────────── Panel ─────────────────────────

export default function Panel() {
  const l = read(lang)
  const u = words(l).ui
  if (read(formOpen)) return <Form />
  const { groups, idle } = groupsOf(read(schedules), read(terminals))
  const gone = read(undone)
  return (
    <Stack gap="md">
      <Summary />
      {gone ? (
        <Callout tone="neutral" icon="info" title={u.deleted(gone.name)}>
          <Row>
            <Button size="xs" variant="outline" onPress={restore}>
              {u.undo}
            </Button>
          </Row>
        </Callout>
      ) : null}
      {groups.length === 0 ? <EmptyState icon="calendar" title={u.emptyTitle} description={u.emptyDescription} /> : null}
      {groups.map((g) => (
        <TerminalBlock g={g} />
      ))}
      {idle.length > 0 ? <IdleTerminals idle={idle} /> : null}
      <Box direction="row" align="center" justify="between">
        <Row gap="xs">
          <Button size="sm" variant="ghost" icon="add" onPress={() => openNew()}>
            {u.newSchedule}
          </Button>
          <Button size="sm" variant="ghost" icon="next" onPress={() => openSend()}>
            {u.send}
          </Button>
        </Row>
        <IconButton icon="refresh" variant="ghost" label={u.refreshTerminals} onPress={() => void refreshTerminals()} />
      </Box>
      <Text muted size="xs">
        {u.footer}
      </Text>
    </Stack>
  )
}
