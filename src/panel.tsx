// Schedules panel — laid out like Orca's own sidebars: a title with icon buttons, tabs, a search box,
// then the list. Schedules shows what runs next, counts and one block per agent terminal; Terminals
// lists every open agent terminal. ↗ on a terminal's line brings Orca to it. The form (new · edit ·
// send once) and Settings replace the list while open.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  env,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  plugin,
  RadioGroup,
  read,
  Row,
  Separator,
  Select,
  set,
  Progress,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  Toolbar,
  update,
  type IconName,
  type PanelContext
} from 'orca'
import { type Draft, dayModes, draftOf, cronOfDraft, emptyDraft, weekdaysOf } from './draft'
import { filterGroup, type Group, groupsOf, holds, keyOf, matches, terminalTexts } from './groups'
import { needsAttention, type PrecheckOutcome, precheckOutcome, type RunRecord, sameTerminal, type Schedule, type TerminalRef } from './engine'
import { type Lang, langNames, langOfLocale, type NoteCode, noteText, recordText, statusText, whenText, words } from './i18n'
import { unbound } from './inbox'
import { type ImportList, type InboxStatus, LANG_KEY, type TerminalOption } from './protocol'
import { type AgentKind, agentKind, agentName } from './screen'
import { dateKey, dateParts, describe, maxTimes, minuteFromText, zoneText } from './timespec'
import { messageOf, drawnLength, linkParts, soft } from './text'
import { fillPrompt, flatten, usedVars } from './vars'

/** The worker's schedules — asked once, then pushed on every change. */
const schedules = atom<Schedule[]>([])
/** The worker answered once; until then the list shows a placeholder, not "No schedules yet". */
const schedulesLoaded = atom(false)
/** The clock for "in 12m" on a card, moved every second while the panel is in view, so the minute turns on time. */
const now = atom(Date.now())
/** Agent terminals open in Orca; null until the first answer. Pushed by the worker when it changes. */
const terminals = atom<TerminalOption[] | null>(null)
type LangPref = 'auto' | Lang
/** Orca's language unless one is picked in Settings. */
const langPref = atom<LangPref>('langPref', 'auto', { persist: 'storage' })
/** The language in use, stored for the worker (it cannot read Orca's language) so notifications match. */
const lang = atom<Lang>(LANG_KEY, 'en', { persist: 'storage' })
const langFor = (pref: LangPref): Lang => (pref === 'auto' ? langOfLocale(env.locale) : pref)
/** Terminal blocks folded shut, by pane id. */
const collapsed = atom<string[]>([])
/** The schedule just deleted, while Undo is offered. */
const undone = atom<Schedule | null>(null)
type View = 'schedules' | 'terminals'
const tab = atom<View>('schedules')
/** The search box — filters both tabs. */
const query = atom('')
const settingsOpen = atom(false)
/** What the menubar app OrcaCron has to bring over — read each time Settings opens; null until it answers. */
const importList = atom<ImportList | null>(null)
const importing = atom(false)
/** How many schedules the last import added; null before one. */
const importAdded = atom<number | null>(null)
const importError = atom<string | null>(null)
/** The inbox folder and the files it could not use — read each time Settings opens; null until it answers. */
const inboxStatus = atom<InboxStatus | null>(null)
/** The terminal list is being read — the reload button turns into a spinner. */
const refreshing = atom(false)
/** False once the worker says it found no Orca CLI — then no terminal can be listed, whatever is open. */
const cliFound = atom(true)
/** The schedule just saved, marked for a moment so the eye finds it. */
const justSaved = atom<string | null>(null)
const SAVED_MS = 4000
/** The introduction was finished or skipped; until then it opens in place of the list. Set once, never
 *  toggled — a persisted atom flipped back and forth by presses misbehaved. */
const onboarded = atom('onboarded', false, { persist: 'storage' })
/** The introduction's page, when opened again from Settings. */
const introStep = atom<number | null>(null)
/** The schedule asked to be deleted, until that is confirmed or cancelled — one at a time. */
const confirmDelete = atom<string | null>(null)
/** The cards opened to their rule, prompt, actions and history. */
const openCards = atom<string[]>([])
/** What each version changed — the releases of the public repository, newest first. */
const RELEASE_NOTES = 'https://github.com/gook-lab/orca-agent-scheduler/releases'

/** The plugin's name — the same in every language. */
const TITLE = 'Agent Scheduler'
const UNDO_MS = 8000

const draft = atom<Draft>(emptyDraft())
const formOpen = atom(false)
/** The form's terminal list is open — it starts folded to one line when the form came with a terminal. */
const pickerOpen = atom(false)
/** The draft as the form opened, to tell whether leaving would throw something away. */
const openedDraft = atom('')
/** Back or Cancel pressed with changes — where to ask: by Back at the top or by Cancel at the bottom. */
const confirmLeave = atom<'top' | 'bottom' | null>(null)
const formError = atom<string | null>(null)
const saving = atom(false)
/** The form's Try it now — for the command it ran, so an edit to the command hides an answer about the old one. */
type Tried = { command: string } & ({ running: true } | { running: false; outcome: PrecheckOutcome; folder: string; output: string } | { running: false; error: string })
const tried = atom<Tried | null>(null)

const thisMonth = (): { y: number; m: number } => {
  const t = new Date()
  return { y: t.getFullYear(), m: t.getMonth() + 1 }
}
/** The month the date calendar shows. */
const month = atom(thisMonth())

/** The Terminals tab, read afresh — the worker's push can be up to a check (30 s) behind, so a terminal
 *  just started shows at once. What is there stays in sight meanwhile; the reload button spins. */
async function refreshTerminals(): Promise<void> {
  set(refreshing, true)
  try {
    set(terminals, await plugin.request('terminals.list'))
  } catch {
    set(terminals, [])
  } finally {
    set(refreshing, false)
  }
}

async function loadImport(): Promise<void> {
  set(importList, await plugin.request('orcacron.list').catch(() => null))
}

function openSettings(): void {
  set(importAdded, null)
  set(importError, null)
  set(settingsOpen, true)
  void loadImport()
  void plugin
    .request('inbox.status')
    .then((s) => set(inboxStatus, s))
    .catch(() => set(inboxStatus, null))
}

async function runImport(ids: string[]): Promise<void> {
  set(importing, true)
  set(importAdded, null)
  set(importError, null)
  try {
    const r = await plugin.request('orcacron.import', { ids })
    set(importAdded, r.added)
    await loadImport()
  } catch (error) {
    set(importError, messageOf(error))
  } finally {
    set(importing, false)
  }
}

function showTerminals(): void {
  set(tab, 'terminals')
  void refreshTerminals()
}

/** The reload button, or a spinner while the list is being read. */
function ReloadButton() {
  const u = words(read(lang)).ui
  return read(refreshing) ? (
    <Box width={24} align="center" shrink={false}>
      <Spinner label={u.refreshTerminals} labelHidden />
    </Box>
  ) : (
    <IconButton icon="refresh" size="sm" variant="ghost" label={u.refreshTerminals} onPress={() => void refreshTerminals()} />
  )
}

/** No agent terminal to pick — the Terminals tab and the form's picker say the same: how to get one,
 *  and a reload for once it is running. */
function NoAgentTerminals() {
  const u = words(read(lang)).ui
  // Without the CLI the list is empty whatever is running — "run claude" would send people in circles.
  if (!read(cliFound)) return <EmptyState icon="warning" title={u.noCli} description={u.noCliHint} />
  return (
    <EmptyState icon="terminal" title={u.noTerminals} description={u.noTerminalsHint}>
      <Row>
        {read(refreshing) ? (
          <Spinner label={u.loading} />
        ) : (
          <Button size="sm" variant="outline" icon="refresh" onPress={() => void refreshTerminals()}>
            {u.refreshTerminals}
          </Button>
        )}
      </Row>
    </EmptyState>
  )
}

function openForm(d: Draft): void {
  set(draft, d)
  const first = d.dates[0]
  if (first) {
    const [y, m] = dateParts(first)
    set(month, { y, m })
  } else set(month, thisMonth())
  set(formError, null)
  set(tried, null)
  set(pickerOpen, !d.handle)
  set(openedDraft, JSON.stringify(d))
  set(confirmLeave, null)
  // The form covers the list — a delete question left under it would be waiting when the list is back.
  set(confirmDelete, null)
  set(formOpen, true)
  void refreshTerminals()
}

const openNew = (handle = ''): void => openForm({ ...emptyDraft(), handle })
// A one-off usually carries on a conversation the person is in — it asks for a result only when told to.
const openSend = (handle = ''): void => openForm({ ...emptyDraft(), once: true, report: false, handle })

function closeForm(): void {
  set(draft, emptyDraft())
  set(formError, null)
  set(tried, null)
  set(confirmLeave, null)
  set(formOpen, false)
}

/** The workspace of the terminal the form has picked — open now, or the saved one while it is closed. */
function draftWorkspace(d: Draft): string | null {
  const open = (read(terminals) ?? []).find((t) => t.handle === d.handle)
  if (open) return open.workspaceId
  const old = read(schedules).find((s) => s.id === d.id)
  return old && old.terminal.handle === d.handle ? old.terminal.workspaceId : null
}

/** Run the precheck now, as a check would, and say what it would do to the run. Nothing is sent. */
async function tryPrecheck(): Promise<void> {
  const d = read(draft)
  const command = d.precheck.trim()
  const workspaceId = draftWorkspace(d)
  if (!command || workspaceId === null) return
  set(tried, { command, running: true })
  let next: Tried
  try {
    const { result, folder } = await plugin.request('precheck.try', { command, workspaceId })
    next = { command, running: false, outcome: precheckOutcome(result), folder, output: 'error' in result ? '' : result.output }
  } catch (error) {
    next = { command, running: false, error: messageOf(error) }
  }
  // The form was closed, or the command changed, while it ran — the answer is about something else now.
  if (read(formOpen) && read(tried)?.command === command) set(tried, next)
}

/** Back and Cancel — leave at once when nothing changed, otherwise ask next to the button pressed. */
function leaveForm(where: 'top' | 'bottom'): void {
  if (JSON.stringify(read(draft)) === read(openedDraft)) closeForm()
  else set(confirmLeave, where)
}

export function setup(ctx: PanelContext): () => void {
  set(lang, langFor(read(langPref)))
  ctx.subscriptions.push(
    plugin.on('schedules.changed', (p) => {
      set(schedules, p.schedules)
      set(schedulesLoaded, true)
      // A schedule that left the list takes its question with it — restored later, it is not asked about again.
      if (!p.schedules.some((s) => s.id === read(confirmDelete))) set(confirmDelete, null)
    })
  )
  ctx.subscriptions.push(plugin.on('terminals.changed', (p) => set(terminals, p.terminals)))
  // Wakes the worker and gets the current list.
  void plugin
    .request('schedules.list')
    .then((list) => set(schedules, list))
    .catch(() => undefined)
    .finally(() => set(schedulesLoaded, true))
  void refreshTerminals()
  void plugin
    .request('runner.status')
    .then((s) => set(cliFound, s.cli))
    .catch(() => undefined)
  const tick = setInterval(() => {
    if (read(ctx.visible)) set(now, Date.now())
  }, 1000)
  // Node (`orca plugin test`) would otherwise wait for the timer before exiting.
  ;(tick as { unref?: () => void }).unref?.()
  return () => clearInterval(tick)
}

const edit = (s: Schedule): void => openForm(draftOf(s))

/** A copy to save as a new schedule. */
function duplicate(s: Schedule): void {
  const { id: _id, ...rest } = draftOf(s)
  openForm({ ...rest, name: words(read(lang)).ui.copyOf(s.name) })
}

function remove(s: Schedule): void {
  set(confirmDelete, null)
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
    const saved = await plugin.request('schedules.save', {
      ...(d.id ? { id: d.id } : {}),
      ...(d.once ? { once: true } : {}),
      name: d.name,
      terminal,
      cron: c.cron,
      prompt: d.prompt,
      enabled: old?.enabled ?? true,
      clearFirst: d.clearFirst,
      report: d.report,
      ...(d.once ? {} : { precheck: d.precheck })
    })
    closeForm()
    showSaved(saved)
  } catch (error) {
    set(formError, messageOf(error))
  } finally {
    set(saving, false)
  }
}

/** The Schedules tab with that terminal's block open, and a search that would hide it cleared. */
function reveal(t: TerminalRef, names: string[] = []): void {
  set(tab, 'schedules')
  update(collapsed, (keys) => keys.filter((k) => k !== t.leafId && k !== t.handle))
  const q = read(query).trim().toLowerCase()
  if (!matches(q, [...names, ...terminalTexts(t)])) set(query, '')
}

/** After saving, show where it went — saved from the Terminals tab, it was otherwise out of sight — and
 *  mark it for a moment. */
function showSaved(s: Schedule): void {
  reveal(s.terminal, [s.name])
  set(justSaved, s.id)
  const timer = setTimeout(() => {
    if (read(justSaved) === s.id) set(justSaved, null)
  }, SAVED_MS)
  // Node (`orca plugin test`) would otherwise wait for the timer before exiting.
  ;(timer as { unref?: () => void }).unref?.()
}

const statusTone = (status: Schedule['lastStatus']): 'success' | 'danger' | 'warning' | 'neutral' | 'accent' =>
  status === 'success' || status === 'done'
    ? 'success'
    : status === 'failed' || status === 'noResult'
      ? 'danger'
      : status === 'aborted' || status === 'doneWaiting'
        ? 'warning'
        : status === 'sent'
          ? 'accent'
          : 'neutral'

/** A run that never went out: its terminal was not free for an hour and the plugin gave it up. `Skipped`
 *  in an agent's result line is the agent's answer — there was nothing to do — and an ordinary result. */
const missed = (r: Pick<RunRecord, 'status' | 'note'>): boolean => r.status === 'skipped' && r.note?.code === 'waitedOut'

/** A run its precheck command held back — grey like an agent's skip, but a folded card says what the command said. */
const heldBack = (r: Pick<RunRecord, 'status' | 'note'>): boolean => r.status === 'skipped' && r.note?.code === 'precheckNo'

/** A record's colour. Orange is for a run a person may want to look at — of the skipped ones, the missed
 *  run only: two of four cards stood orange after an ordinary morning (2026-11-18). */
const recordTone = (r: Pick<RunRecord, 'status' | 'note'>): ReturnType<typeof statusTone> => (missed(r) ? 'warning' : statusTone(r.status))

/** The round mark at a card's left — what a glance takes in first. What is going on now comes before how
 *  the last run went, and a schedule that is off says only that: an empty circle. */
const markOf = (
  s: Schedule,
  now: { urgent: boolean; queued: boolean; gone: boolean }
): { tone: ReturnType<typeof statusTone>; glyph: string } => {
  if (s.sentAt !== null) return { tone: 'accent', glyph: '▸' }
  if (now.urgent || (now.gone && s.enabled)) return { tone: 'warning', glyph: '!' }
  if (now.queued) return { tone: 'neutral', glyph: '…' }
  if (!s.enabled) return { tone: 'neutral', glyph: '' }
  const last = s.history[0]
  if (!last) return { tone: 'neutral', glyph: '•' }
  const tone = recordTone(last)
  const glyph =
    tone === 'success'
      ? '✓'
      : tone === 'danger'
        ? '✕'
        : last.status === 'doneWaiting'
          ? '?'
          : tone === 'warning' || last.status === 'skipped'
            ? '–'
            : tone === 'accent'
              ? '▸'
              : '•'
  return { tone, glyph }
}

/** What a person can do about a note from the card: pick another terminal, or go to this one and answer it. */
const fixOf: Partial<Record<NoteCode, 'pick' | 'show'>> = {
  missing: 'pick',
  noAgent: 'show',
  typing: 'show',
  dialog: 'show',
  noPrompt: 'show',
  person: 'show',
  stuckTyping: 'show',
  stuckNoPrompt: 'show'
}

/** Edit, opened at the terminal picker. */
function pickTerminal(s: Schedule): void {
  edit(s)
  set(pickerOpen, true)
}

// ───────────────────────── Top — title and actions, tabs, search ─────────────────────────

/** Title on the left, icon buttons on the right — the title row of Orca's own sidebars. */
function Header() {
  const u = words(read(lang)).ui
  return (
    <Box direction="row" align="center" gap="xs">
      <Box grow shrink minWidth={0}>
        <Text size="sm" weight="semibold" truncate>
          {TITLE}
        </Text>
      </Box>
      {/* The title gives way, not the buttons: squeezed, the row of four broke in two. */}
      <Box shrink={false}>
        <Toolbar label={u.actions} gap="none">
          <IconButton icon="add" size="sm" variant="ghost" label={u.newSchedule} onPress={() => openNew()} />
          <IconButton icon="next" size="sm" variant="ghost" label={u.sendOnce} onPress={() => openSend()} />
          <ReloadButton />
          <IconButton icon="settings" size="sm" variant="ghost" label={u.settings} onPress={openSettings} />
        </Toolbar>
      </Box>
    </Box>
  )
}

/** A screen over the list — Settings, the form: its title where Agent Scheduler sits and × where the
 *  icons sit, so the title row stays put when the screen changes. Orca has no back-arrow icon. */
function SubHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const u = words(read(lang)).ui
  return (
    <Stack gap="xs">
      <Box direction="row" align="center" gap="xs">
        <Box grow shrink minWidth={0}>
          <Text size="sm" weight="semibold" truncate>
            {title}
          </Text>
        </Box>
        <Toolbar label={title} gap="none">
          <IconButton icon="close" size="sm" variant="ghost" label={u.close} onPress={onClose} />
        </Toolbar>
      </Box>
      {/* The line under it says this is a screen of its own, over the list. */}
      <Separator />
    </Stack>
  )
}

/** Tabs with their counts, the search box under them. */
function Nav() {
  const u = words(read(lang)).ui
  return (
    <Stack gap="xs">
      <Tabs label={u.view} value={read(tab)} onChange={(v) => (v === 'terminals' ? showTerminals() : set(tab, 'schedules'))}>
        <Tab value="schedules" label={u.tabSchedules(read(schedulesLoaded) ? read(schedules).filter((s) => !s.once).length : null)} />
        <Tab value="terminals" label={u.tabTerminals(read(terminals)?.length ?? null)} />
      </Tabs>
      <Input type="search" label={u.find} labelHidden value={read(query)} placeholder={u.findPlaceholder} onChange={(v) => set(query, v)} />
    </Stack>
  )
}

/** How many are on and how many runs went out today, in words — drawn as pills all the time, the counts
 *  read as filters and did nothing when pressed. Badges are for what is out of the ordinary: waiting,
 *  running, need attention. */
/** What is out of the ordinary, counted above the list — nothing while every schedule is at rest. The
 *  rest is said where it belongs: the next run on each card and in Orca's status bar, on and off by the
 *  switches. */
function Stats() {
  const u = words(read(lang)).ui
  const list = read(schedules)
  const waiting = list.filter((s) => s.pendingSince !== null).length
  const running = list.filter((s) => s.sentAt !== null).length
  const attention = list.filter(needsAttention).length
  if (waiting + running + attention === 0) return null
  return (
    <Row gap="xs" wrap>
      {waiting > 0 ? <Badge>{u.stats.waiting(waiting)}</Badge> : null}
      {running > 0 ? <Badge tone="accent">{u.stats.running(running)}</Badge> : null}
      {attention > 0 ? <Badge tone="warning">{u.stats.attention(attention)}</Badge> : null}
    </Row>
  )
}

// ───────────────────────── Terminal line — agent, live dot, name ─────────────────────────

/** Picker icons, one per agent. */
const agentIcon: Record<AgentKind, IconName> = { claude: 'bot', codex: 'terminal', gemini: 'zap' }
/** Each agent's own mark as text — Claude Code puts ✳ in its terminal titles. */
const agentGlyph: Record<AgentKind, string> = { claude: '✳', codex: '>_', gemini: '✦' }

/** One terminal: agent mark, a green dot while it is open, its title, then its workspace, muted — the
 *  order of the picker. A block is one terminal, and with the workspace first it read as a project whose
 *  buttons act on every terminal in it. In a block the chevron folds it; ↗ brings Orca to the terminal.
 *  On the Terminals tab a terminal with schedules shows how many, and pressing that goes to them. Then
 *  send once and new schedule. A closed terminal stays, faded, with its last known agent. */
function TerminalLine({
  term: t,
  live,
  fold,
  count
}: {
  term: TerminalRef
  live: TerminalOption | null
  fold?: { open: boolean; toggle: () => void }
  count?: number
}) {
  const u = words(read(lang)).ui
  const kind = agentKind(live?.agent ?? t.agent)
  const name = t.title || t.workspace
  const where = t.title ? t.workspace : ''
  // Marks, dot and buttons keep their width. Of the room left for words the shorter of the two keeps its
  // width — the workspace up to a third of the room, the title up to two thirds — and the other takes
  // what is left and ends in …. With one fixed share for the title, a long title beside a four-letter
  // workspace was cut while a quarter of the line stood empty. The title is text, not a button: a Button
  // does not shorten its text, and a long title ran over the marks and the buttons on both sides.
  const titleLong = drawnLength(name) > 2 * drawnLength(where)
  return (
    <Box direction="row" align="center" gap="xs">
      {fold ? (
        <IconButton icon={fold.open ? 'collapse' : 'expand'} size="xs" variant="ghost" label={fold.open ? u.collapse : u.expand} onPress={fold.toggle} />
      ) : null}
      <Box shrink={false}>
        <Text size="xs" weight="semibold" tone={live ? 'accent' : 'neutral'} muted={!live}>
          {kind ? agentGlyph[kind] : '•'}
        </Text>
      </Box>
      {/* A Box background is only a tint — a glyph gives a solid dot. */}
      <Box shrink={false}>
        <Text size="xs" tone={live ? 'success' : 'neutral'} muted={!live}>
          ●
        </Text>
      </Box>
      <Box direction="row" align="center" gap="xs" grow shrink minWidth={0}>
        <Box shrink={titleLong} minWidth={0} {...(titleLong ? {} : { maxWidth: '66%' as const })}>
          <Text size="xs" weight="medium" truncate>
            {name}
          </Text>
        </Box>
        <Box grow={!titleLong} shrink={!titleLong} minWidth={0} {...(titleLong ? { maxWidth: '34%' as const } : {})}>
          <Text size="xs" muted truncate>
            {where}
          </Text>
        </Box>
      </Box>
      {count ? (
        <Box shrink={false}>
          <Button size="xs" variant="ghost" onPress={() => reveal(live ?? t)}>
            {u.tabSchedules(count)}
          </Button>
        </Box>
      ) : null}
      <IconButton
        icon="open-external"
        size="xs"
        variant="ghost"
        label={`${kind ? agentName[kind] : t.agent} — ${u.showInOrca}`}
        tooltip={u.showInOrca}
        disabled={!live}
        onPress={() => (live ? void focusTerminal(live.handle) : undefined)}
      />
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

/** A record beside its badge. What the agent wrote comes first — it is what the run was for — then when,
 *  how long and the link, in one line that wraps. `glance` is the folded card's reading. */
function RecordDetail({ r, glance }: { r: RunRecord; glance?: boolean }) {
  const l = read(lang)
  // A folded card says when the last run was and how long it took. What the agent wrote, its link and
  // how the end was seen are a click away, with the rest of the card — RecordLine adds one line of
  // what the agent wrote when the run did not go well.
  if (glance)
    return (
      <Text muted size="xs">
        {[whenText(l, r.at), recordText(l, { tookMs: r.tookMs })].filter(Boolean).join(' · ')}
      </Text>
    )
  const meta = [whenText(l, r.at), recordText(l, r)].filter(Boolean).join(' · ')
  const link = r.link ? linkParts(r.link) : null
  return (
    <Stack gap="none">
      {r.summary ? <Text size="xs">{soft(r.summary)}</Text> : null}
      <Text muted size="xs">
        {soft(meta)}
        {link ? ' · ' : null}
        {link ? <Link href={r.link}>{link.site}</Link> : null}
        {link ? link.path : null}
      </Text>
    </Stack>
  )
}

/** The results a person has to do something about: a folded card says why, in what the agent wrote. */
const wentWrong = (status: RunRecord['status']): boolean =>
  status === 'failed' || status === 'noResult' || status === 'aborted' || status === 'doneWaiting'

/** What the plugin itself knows of a run that did not go well: it never went out, or its end was not seen. */
const reasonCodes: readonly NoteCode[] = ['waitedOut', 'sendFailed', 'clearFailed', 'closed', 'timeout', 'precheckNo', 'precheckFailed']

function RecordLine({ r, glance }: { r: RunRecord; glance?: boolean }) {
  const l = read(lang)
  const status = statusText(l, r.status)
  // What the agent wrote; when it wrote nothing, what the plugin knows — a run that waited an hour and
  // was given up read, folded, like one an agent skipped.
  const why =
    glance && (wentWrong(r.status) || missed(r) || heldBack(r)) ? (r.summary ?? (r.note && reasonCodes.includes(r.note.code) ? noteText(l, r.note) : null)) : null
  const tone = recordTone(r)
  const row = (
    <Box direction="row" align="start" gap="xs">
      {glance ? (
        // A word, not a badge: the mark at the card's left already has the colour.
        <Box shrink={false}>
          <Text size="xs" weight="medium" tone={tone}>
            {status}
          </Text>
        </Box>
      ) : tone === 'neutral' ? (
        // A grey badge has the card's own colour in a dark theme: only its padding showed, a word set a
        // little to the right. The line makes it a pill like the coloured ones — as for the round mark.
        <Box shrink={false} border radius="full">
          <Badge tone={tone}>{status}</Badge>
        </Box>
      ) : (
        <Badge tone={tone}>{status}</Badge>
      )}
      <Box grow shrink minWidth={0}>
        <RecordDetail r={r} glance={glance} />
      </Box>
    </Box>
  )
  if (!why) return row
  return (
    <Box>
      {row}
      {/* One line, cut where it runs out, so a card's height does not follow what an agent wrote; it
          starts at the name's edge and the whole of it opens with the card. */}
      <Text size="xs" truncate>
        {why}
      </Text>
    </Box>
  )
}

/** The start of a prompt, on one line — enough to tell which schedule this is. */
const promptPreview = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function toggleCard(id: string): void {
  const open = read(openCards)
  if (!open.includes(id)) return set(openCards, [...open, id])
  set(openCards, open.filter((x) => x !== id))
  // The question about deleting sits in the part that folds away.
  if (read(confirmDelete) === id) set(confirmDelete, null)
}

function ScheduleRow({ s, live }: { s: Schedule; live: TerminalOption | null }) {
  const l = read(lang)
  const u = words(l).ui
  const last = s.history[0]
  const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null)
  // The list of terminals is read and this one is not in it.
  const gone = live === null && read(terminals) !== null
  // The callout is only for what the count on top and the status bar call "need attention"; a run that
  // is just waiting its turn says so in a line of the card's column.
  const urgent = needsAttention(s)
  const queued = s.pendingSince !== null
  // One run at a time: a second press while one waits or runs would send the prompt again.
  // From the inbox, and no terminal matched its workspace and agent yet — not a terminal that closed.
  const kindAsked = agentKind(s.terminal.agent)
  const goneText = unbound(s.terminal) ? u.inbox.noTerminal(kindAsked ? agentName[kindAsked] : s.terminal.agent, s.terminal.workspace) : u.terminalGone
  const sendBlock = s.sentAt !== null ? u.sendNowRunning : queued ? u.sendNowQueued : gone ? goneText : null
  const fix = note ? fixOf[note.code] : undefined
  const fixButton =
    fix === 'pick' || (!note && gone) ? (
      <Button size="xs" variant="outline" onPress={() => pickTerminal(s)}>
        {u.pickTerminal}
      </Button>
    ) : fix === 'show' && live ? (
      <Button size="xs" variant="outline" icon="open-external" onPress={() => void focusTerminal(live.handle)}>
        {u.showInOrca}
      </Button>
    ) : null
  const nextText = s.enabled
    ? s.nextRunAt !== null
      ? `${u.next} ${whenText(l, s.nextRunAt)} · ${u.inAbout(s.nextRunAt - read(now))}`
      : u.never
    : u.off
  const saved = read(justSaved) === s.id
  const open = read(openCards).includes(s.id)
  const mark = markOf(s, { urgent, queued, gone })
  return (
    // Folded, a card says what a glance is for: which schedule, when it runs next, how the last run
    // went — and why, in one line, when it did not go well — or, in that run's place, that one is
    // going or waits to be sent. The whole of what the agent wrote, the
    // rule, the prompt, the history and what is done now and then — edit, duplicate, delete — open
    // in place: Orca's panel kit has no menu that pops up.
    // A filled surface, like a list of cards rather than a form. The border stays: a light theme
    // gives the card surface the panel's own colour, and only the line then shows where a card ends.
    // Just saved: tinted for a moment — no badge row, so nothing below moves when it goes.
    <Box border={saved ? 'success' : true} background={saved ? 'success' : 'card'} radius="lg" padding="md" gap="xs">
      <Box direction="row" align="start" gap="md">
        <Box
          shrink={false}
          radius="full"
          // A neutral fill is the card's own colour: without the line the circle is not there.
          border={mark.tone === 'neutral'}
          background={mark.tone}
          width={28}
          height={28}
          align="center"
          justify="center"
        >
          {mark.glyph ? (
            <Text size="sm" weight="semibold" tone={mark.tone}>
              {mark.glyph}
            </Text>
          ) : null}
        </Box>
        {/* One column beside the mark, so every line of text starts at the same edge: the name with its
            switch, the next run with the two buttons, then the last run — a schedule that has not run
            yet ends after two lines instead of keeping an empty one for the buttons. */}
        <Box grow shrink minWidth={0}>
          <Switch label={soft(s.name)} checked={s.enabled} onChange={(enabled) => void plugin.request('schedules.toggle', { id: s.id, enabled })} />
          <Box direction="row" align="center" gap="xs">
            <Box grow shrink minWidth={0}>
              <Text size="xs" muted>
                {nextText}
              </Text>
            </Box>
            <Box shrink={false}>
              <Toolbar label={s.name} gap="none">
                <IconButton
                  icon="play"
                  size="xs"
                  variant="ghost"
                  label={u.sendNow}
                  tooltip={sendBlock ?? u.sendNowTip}
                  disabled={sendBlock !== null}
                  onPress={() => void plugin.request('schedules.runNow', { id: s.id })}
                />
                <IconButton icon={open ? 'collapse' : 'expand'} size="xs" variant="ghost" label={open ? u.less : u.more} onPress={() => toggleCard(s.id)} />
              </Toolbar>
            </Box>
          </Box>
          {/* What is going on now takes the last run's place on a folded card — the spinner while a run
              is going, the waiting line below while one waits: the result it is about to replace opens
              with the card. */}
          {s.sentAt !== null ? (
            <Row gap="xs">
              <Spinner label={u.running} labelHidden />
              <Text size="xs" tone="accent">{`${u.running} ${whenText(l, s.sentAt)}`}</Text>
            </Row>
          ) : last && (open || !queued) ? (
            <RecordLine r={last} glance={!open} />
          ) : null}
          {/* Why a run waits, or that its terminal is closed: a line of the same column. The warning
              below is a block of its own, like the opened part, and keeps the card's whole width. */}
          {note && urgent ? null : queued ? (
            // Shown from the press on — the reason arrives with the first check, a moment later.
            // A word, like the last result above it: a grey badge has the card's own colour in a dark
            // theme, so only its padding showed — as text that began a little to the right of the name.
            <Box direction="row" align="start" gap="xs">
              <Box shrink={false}>
                <Text size="xs" weight="medium">
                  {u.waitingToSend}
                </Text>
              </Box>
              {note ? (
                <Box grow shrink minWidth={0}>
                  <Text size="xs" muted>
                    {soft(noteText(l, note))}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ) : gone ? (
            // A schedule that is on will find no terminal at its next time; one that is off only says so.
            <Box gap="xs">
              <Text size="xs" tone={s.enabled ? 'warning' : undefined} muted={!s.enabled}>
                {soft(goneText)}
              </Text>
              <Row>{fixButton}</Row>
            </Box>
          ) : null}
          {/* Who put it here, when it was not made in this panel — on the folded card too, so a schedule
              a bot added is told from one's own at a glance. */}
          {s.source ? (
            <Text size="xs" muted>
              {soft(u.inbox.from(s.source.by))}
            </Text>
          ) : null}
        </Box>
      </Box>
      {note && urgent ? (
        <Callout tone="warning" icon="warning" title={u.attention}>
          <Stack gap="xs">
            <Text size="xs">{soft(noteText(l, note))}</Text>
            {fixButton ? <Row>{fixButton}</Row> : null}
          </Stack>
        </Callout>
      ) : null}
      {open ? (
        <Stack gap="xs">
          <Separator />
          <Text size="xs" muted>
            {[describe(s.cron, l), s.clearFirst ? '/clear' : '', s.precheck ? `${u.precheck}: ${s.precheck}` : ''].filter(Boolean).join(' · ')}
          </Text>
          <Text size="xs">{soft(promptPreview(s.prompt))}</Text>
          {read(confirmDelete) === s.id ? (
            // The question takes the buttons' place — two "Delete"s at once would be one too many.
            <Callout tone="danger" icon="warning" title={soft(u.deleteAsk(s.name))}>
              <Stack gap="xs">
                {s.history.length > 0 ? <Text size="xs">{u.deleteLoses(s.history.length)}</Text> : null}
                <Row gap="xs">
                  <Button size="xs" variant="outline" tone="danger" onPress={() => remove(s)}>
                    {u.remove}
                  </Button>
                  <Button size="xs" variant="ghost" onPress={() => set(confirmDelete, null)}>
                    {u.cancel}
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : (
            <Row gap="xs" wrap>
              <Button size="xs" variant="outline" icon="edit" onPress={() => edit(s)}>
                {u.edit}
              </Button>
              <Button size="xs" variant="outline" icon="copy" onPress={() => duplicate(s)}>
                {u.duplicate}
              </Button>
              <Button size="xs" variant="ghost" icon="delete" onPress={() => set(confirmDelete, s.id)}>
                {u.remove}
              </Button>
            </Row>
          )}
          {/* One run is the line above; History is for the ones before it. */}
          {s.history.length > 1 ? (
            <Collapsible title={u.history(s.history.length)}>
              <Stack gap="xs">
                {s.history.map((r) => (
                  <RecordLine key={r.at} r={r} />
                ))}
              </Stack>
            </Collapsible>
          ) : null}
        </Stack>
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
  const waiting = sorted.filter((s) => s.pendingSince !== null).length
  const busy = waiting > 0 || sorted.some((s) => s.sentAt !== null)
  // A search draws it open, like its block — what was found is in here.
  const searching = read(query).trim() !== ''
  // Open is read only when drawn first, so a new send keyed by the newest record draws it afresh — open
  // while it waits or runs. It stays as it is when that send ends; a fold by hand holds until the next one.
  return (
    <Collapsible
      key={`sent-${sorted[0]?.id ?? ''}-${searching}`}
      title={u.sentGroup(sorted.length - waiting, waiting, sorted[0] ? whenText(l, at(sorted[0])) : null)}
      defaultOpen={busy || searching}
    >
      <Stack gap="xs">
        {sorted.map((s) => {
          const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null)
          const status = s.pendingSince !== null ? null : s.sentAt !== null ? 'sent' : s.lastStatus
          const ended = s.pendingSince === null && s.sentAt === null ? s.history[0] : undefined
          return (
            <Stack key={s.id} gap="none">
              <Box direction="row" align="center" gap="xs">
                <Badge tone={ended ? recordTone(ended) : statusTone(status)}>{status ? statusText(l, status) : u.waitingToSend}</Badge>
                <Box grow shrink minWidth={0}>
                  <Text size="xs" truncate>
                    {s.name}
                  </Text>
                </Box>
                <IconButton icon="delete" size="xs" variant="ghost" label={u.remove} onPress={() => remove(s)} />
              </Box>
              {/* Its own line — beside the name it was squeezed into a column and broke mid-time. */}
              {ended ? (
                <RecordDetail r={ended} />
              ) : (
                <Text size="xs" muted>
                  {whenText(l, at(s))}
                </Text>
              )}
              {note && needsAttention(s) ? (
                <Text size="xs" tone="warning">
                  {soft(noteText(l, note))}
                </Text>
              ) : note ? (
                <Text size="xs" muted>
                  {soft(noteText(l, note))}
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

function TerminalBlock({ g }: { g: Group }) {
  const l = read(lang)
  const u = words(l).ui
  const folded = read(collapsed).includes(g.key)
  // While searching, a folded block shows what was found in it; the fold comes back with the search cleared.
  const open = !folded || read(query).trim() !== ''
  const toggle = () => update(collapsed, (keys) => (folded ? keys.filter((k) => k !== g.key) : [...keys, g.key]))
  const next = g.recurring.filter((s) => s.enabled && s.nextRunAt !== null).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  const gone = read(undone)
  return (
    <Stack gap="xs">
      <Box background="muted" radius="md" paddingX="xs">
        <TerminalLine term={g.ref} live={g.live} fold={{ open, toggle }} />
      </Box>
      {gone && holds(g, gone) ? (
        <Box direction="row" align="center" gap="xs" border radius="md" paddingX="sm" paddingY="xs">
          <Box grow shrink minWidth={0}>
            <Text size="xs" muted truncate>
              {soft(u.deleted(gone.name))}
            </Text>
          </Box>
          <Button size="xs" variant="outline" onPress={restore}>
            {u.undo}
          </Button>
        </Box>
      ) : null}
      {open ? (
        // Cards stand a little apart from each other, and closer to the terminal line they belong to.
        <Stack gap="sm">
          {g.recurring.map((s) => (
            <ScheduleRow key={s.id} s={s} live={g.live} />
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

/** The counts of what is out of the ordinary, then one block per terminal. */
function SchedulesView() {
  const u = words(read(lang)).ui
  const list = read(schedules)
  const gone = read(undone)
  if (!read(schedulesLoaded)) return <Skeleton shape="text" lines={3} label={u.loading} />
  if (list.length === 0 && !gone)
    return (
      <EmptyState icon="calendar" title={u.emptyTitle} description={u.emptyDescription}>
        <Row>
          <Button size="sm" variant="outline" icon="terminal" onPress={showTerminals}>
            {u.openTerminals}
          </Button>
        </Row>
      </EmptyState>
    )
  const q = read(query).trim().toLowerCase()
  // Undo shows where the schedule was, so its block stays while Undo is offered — even if it is now empty.
  const all = groupsOf(list, read(terminals))
  if (gone && !all.some((g) => holds(g, gone))) {
    const live = read(terminals)?.find((t) => sameTerminal(t, gone.terminal)) ?? null
    all.push({ key: keyOf(gone.terminal), ref: live ?? gone.terminal, live, recurring: [], once: [] })
  }
  const groups = all.flatMap((g) => filterGroup(g, q) ?? (gone && holds(g, gone) ? [{ ...g, recurring: [], once: [] }] : []))
  return (
    <Stack gap="md">
      <Stats />
      {groups.length === 0 ? <NoMatch /> : null}
      {groups.map((g) => (
        <TerminalBlock key={g.key} g={g} />
      ))}
    </Stack>
  )
}

/** A search that hides everything — both tabs say so the same way, with the way out. */
function NoMatch() {
  const u = words(read(lang)).ui
  return (
    <EmptyState icon="search" title={u.noMatch(read(query).trim())}>
      <Row>
        <Button size="sm" variant="outline" onPress={() => set(query, '')}>
          {u.clearSearch}
        </Button>
      </Row>
    </EmptyState>
  )
}

/** Every open agent terminal — press one to bring Orca to it, send to it once or schedule on it. */
function TerminalsView() {
  const u = words(read(lang)).ui
  const open = read(terminals)
  if (open === null) return <Skeleton shape="text" lines={3} label={u.loading} />
  if (open.length === 0) return <NoAgentTerminals />
  const q = read(query).trim().toLowerCase()
  const shown = open.filter((t) => matches(q, terminalTexts(t)))
  if (shown.length === 0) return <NoMatch />
  const list = read(schedules)
  const countOf = (t: TerminalOption) => list.filter((s) => !s.once && sameTerminal(t, s.terminal)).length
  return (
    <Stack gap="xs">
      {shown.map((t) => (
        <TerminalLine key={t.handle} term={t} live={t} count={countOf(t)} />
      ))}
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
            key={day}
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
          <Box key={name} width="14%" align="center">
            <Text muted size="xs">
              {name}
            </Text>
          </Box>
        ))}
      </Box>
      {weeks.map((week) => (
        <Box key={week.join(',')} direction="row">
          {week.map((day, i) => {
            if (day === null) return <Box key={`blank-${i}`} width="14%" />
            const key = dateKey(y, m, day)
            const on = d.dates.includes(key)
            return (
              <Box key={day} width="14%" align="stretch" padding="none">
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

/** The terminal: one line with Change when the form came with one, or a list inside the panel to pick
 *  from (a Select's popup grows to its longest label and spills past the panel). The list scrolls after a
 *  few rows and folds again once a terminal is picked. */
function TerminalPicker({ selected, missing, onPick }: { selected: string; missing: TerminalRef | null; onPick: (handle: string) => void }) {
  const u = words(read(lang)).ui
  const open = read(terminals)
  const chosen = missing ?? (open ?? []).find((t) => t.handle === selected) ?? null
  const expanded = read(pickerOpen) || !chosen
  const item = (t: TerminalRef, live: boolean, pick: boolean) => {
    const kind = agentKind(t.agent)
    return (
      <ListItem
        key={`terminal-${t.handle}`}
        icon={kind ? agentIcon[kind] : 'agent'}
        title={t.title || t.workspace}
        description={[t.workspace, kind ? agentName[kind] : t.agent, live ? '' : u.notOpen].filter(Boolean).join(' · ')}
        current={pick && t.handle === selected}
        disabled={!live}
        onPress={pick ? () => onPick(t.handle) : undefined}
      />
    )
  }
  return (
    <Stack gap="xs">
      <Box direction="row" align="center" gap="xs">
        <Box grow>
          <Text size="sm" weight="medium">
            {u.terminal}
          </Text>
        </Box>
        {expanded ? (
          <ReloadButton />
        ) : (
          <Button size="xs" variant="ghost" onPress={() => set(pickerOpen, true)}>
            {u.change}
          </Button>
        )}
        {expanded && chosen ? <IconButton icon="collapse" size="xs" variant="ghost" label={u.collapse} onPress={() => set(pickerOpen, false)} /> : null}
      </Box>
      {!expanded && chosen ? (
        <Box border radius="md">
          <List label={u.terminal}>{item(chosen, !missing, false)}</List>
        </Box>
      ) : open !== null && open.length === 0 && !missing ? (
        <NoAgentTerminals />
      ) : (
        <Box border radius="md" maxHeight={240} scroll="y">
          <List label={u.terminal}>
            {missing ? item(missing, false, true) : null}
            {(open ?? []).map((t) => item(t, true, true))}
          </List>
        </Box>
      )}
    </Stack>
  )
}

/** What Try it now found: what the run would do, why, and what the command printed. */
function TriedLine({ t }: { t: Exclude<Tried, { running: true }> }) {
  const l = read(lang)
  const u = words(l).ui
  if ('error' in t) {
    return (
      <Text size="xs" tone="danger">
        {soft(t.error)}
      </Text>
    )
  }
  const o = t.outcome
  const printed = flatten(t.output)
  return (
    <Stack gap="none">
      <Text size="xs" weight="medium" tone={o.go ? 'success' : o.status === 'failed' ? 'danger' : 'neutral'}>
        {soft(o.go ? u.tryGo(t.folder) : o.status === 'failed' ? u.tryFail(t.folder) : u.tryNo(t.folder))}
      </Text>
      {o.go ? null : <Text size="xs">{soft(noteText(l, o.note))}</Text>}
      <Text size="xs" muted>
        {soft(printed ? u.tryPrinted(printed) : u.tryPrintedNothing)}
      </Text>
    </Stack>
  )
}

function Form() {
  const l = read(lang)
  const u = words(l).ui
  const d = read(draft)
  const open = read(terminals)
  const old = read(schedules).find((s) => s.id === d.id)
  // The saved terminal stays first while it is closed, so editing does not silently move the schedule.
  const missing = old && d.handle && !(open ?? []).some((t) => t.handle === d.handle) ? old.terminal : null
  const c = d.once ? null : cronOfDraft(d, l)
  const patch = (p: Partial<Draft>) => update(draft, (x) => ({ ...x, ...p }))
  const changeDay = (v: string) => {
    const day = dayModes.find((m) => m === v)
    if (!day) return
    const p: Partial<Draft> = { day }
    // From every day · weekdays · weekends into "Pick days", start with those days on.
    if (day === 'pick' && (d.day === 'everyDay' || d.day === 'weekdays' || d.day === 'weekends')) p.picked = weekdaysOf[d.day]
    // Into "Cron", start from what the form had.
    if (day === 'cron' && c && 'cron' in c) p.cron = c.cron
    patch(p)
  }
  // The first thing still missing, in the order of the fields; Create stays off and says why.
  const e = words(l).error
  const reason =
    !d.once && !d.name.trim()
      ? e.name
      : !d.handle
        ? e.terminal
        : c !== null && 'error' in c
          ? c.error
          : !d.prompt.trim()
            ? e.prompt
            : null
  const blocked = read(saving) || reason !== null
  const workspace = d.handle ? draftWorkspace(d) : null
  // Try it now's answer, while it is about the command in the field.
  const t = ((x) => (x && x.command === d.precheck.trim() ? x : null))(read(tried))
  const nameField = (
    <Input label={u.name} value={d.name} placeholder={d.once ? u.namePlaceholderOnce : u.namePlaceholder} onChange={(name) => patch({ name })} />
  )
  const clearField = (
    <Checkbox label={u.clearFirst} description={u.clearFirstHint} checked={d.clearFirst} onChange={(clearFirst) => patch({ clearFirst })} />
  )
  const reportField = (
    <Checkbox label={u.report} description={d.prompt.trimStart().startsWith('/') ? u.reportNotOnCommand : u.reportHint} checked={d.report} onChange={(report) => patch({ report })} />
  )
  const confirm = (
    <Callout tone="warning" title={u.discardTitle}>
      <Row gap="xs">
        <Button size="xs" variant="outline" tone="danger" onPress={closeForm}>
          {u.discard}
        </Button>
        <Button size="xs" variant="ghost" onPress={() => set(confirmLeave, null)}>
          {u.keepEditing}
        </Button>
      </Row>
    </Callout>
  )
  // Send once is about the prompt: terminal, prompt, Send; the name (first line if empty) waits under
  // More options. It has no /clear — a one-off usually carries on the conversation in that terminal.
  // A schedule keeps name, terminal, /clear, then when.
  // Every labelled field apart, each one's parts close: name; terminal and /clear; days and their picker;
  // time and what it comes to; prompt; then the buttons with the reason they are off. The space under the
  // title line matches Settings.
  return (
    <Stack gap="md">
      <SubHeader title={d.once ? u.sendOnce : d.id ? u.editSchedule : u.newSchedule} onClose={() => leaveForm('top')} />
      {read(confirmLeave) === 'top' ? confirm : null}
      {old?.source ? (
        <Text size="xs" muted>
          {soft(u.inbox.editHint(old.source.by))}
        </Text>
      ) : null}
      {d.once ? null : nameField}
      <Stack gap="xs">
        <TerminalPicker
          selected={d.handle}
          missing={missing}
          onPick={(handle) => {
            patch({ handle })
            set(pickerOpen, false)
          }}
        />
        {d.once ? null : clearField}
      </Stack>
      {c === null ? null : (
        <Stack gap="xs">
          <Select label={u.days} value={d.day} options={dayModes.map((m) => ({ value: m, label: u.dayChoice[m] }))} onChange={changeDay} />
          {d.day === 'pick' ? <DayPicker /> : null}
          {d.day === 'dates' ? <DateCalendar /> : null}
        </Stack>
      )}
      {c === null ? null : (
        <Stack gap="xs">
          {d.day === 'cron' ? (
            <Input label={u.cron} value={d.cron} placeholder={u.cronPlaceholder} onChange={(cron) => patch({ cron })} invalid={'error' in c} />
          ) : (
            <TimeFields />
          )}
          <Text muted size="xs">
            {'error' in c ? c.error : describe(c.cron, l)}
          </Text>
          <Text muted size="xs">
            {u.clock(zoneText())}
          </Text>
        </Stack>
      )}
      <Stack gap="xs">
        <Textarea label={u.prompt} rows={4} value={d.prompt} placeholder={u.promptPlaceholder} onChange={(prompt) => patch({ prompt })} />
        <Text muted size="xs">
          {soft(u.varsHint)}
        </Text>
        {usedVars(d.prompt).length > 0 ? (
          <Text size="xs">
            {soft(
              u.preview(
                fillPrompt(d.prompt, {
                  now: read(now),
                  history: old?.history ?? [],
                  precheck: (t && !t.running && 'outcome' in t && t.outcome.go ? t.outcome.output : '') || u.previewPrecheck
                })
              )
            )}
          </Text>
        ) : null}
        {!d.once && !d.precheck.trim() && usedVars(d.prompt).includes('precheck') ? (
          <Text size="xs" tone="warning">
            {soft(u.precheckVarUnset)}
          </Text>
        ) : null}
        {d.once ? (
          <Text muted size="xs">
            {u.sendHint}
          </Text>
        ) : (
          reportField
        )}
      </Stack>
      {d.once ? null : (
        <Collapsible title={u.precheck} defaultOpen={!!d.precheck.trim()}>
          <Stack gap="xs">
            <Input label={u.precheckLabel} value={d.precheck} placeholder={u.precheckPlaceholder} onChange={(precheck) => patch({ precheck })} />
            <Text muted size="xs">
              {soft(u.precheckHint)}
            </Text>
            <Row gap="xs">
              <Button size="xs" variant="outline" disabled={!d.precheck.trim() || workspace === null || t?.running === true} onPress={() => void tryPrecheck()}>
                {t?.running ? u.tryRunning : u.tryPrecheck}
              </Button>
            </Row>
            <Text muted size="xs">
              {workspace === null ? u.tryPrecheckNoTerminal : u.tryPrecheckHint}
            </Text>
            {t && !t.running ? <TriedLine t={t} /> : null}
          </Stack>
        </Collapsible>
      )}
      {d.once ? (
        <Collapsible title={u.moreOptions} defaultOpen={!!d.name.trim() || d.report}>
          <Stack gap="sm">
            {nameField}
            {reportField}
          </Stack>
        </Collapsible>
      ) : null}
      <Stack gap="xs">
        {reason ? (
          <Text size="xs" muted>
            {reason}
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
          <Button variant="ghost" onPress={() => leaveForm('bottom')}>
            {u.cancel}
          </Button>
        </Row>
      </Stack>
      {read(confirmLeave) === 'bottom' ? confirm : null}
    </Stack>
  )
}

// ───────────────────────── Settings ─────────────────────────

/** Schedules of the menubar app OrcaCron, to copy over. Nothing shows on a computer without the app's data. */
function Importer() {
  const l = read(lang)
  const u = words(l).ui
  const w = u.importer
  const data = read(importList)
  if (!data?.found || data.items.length === 0) return null
  const ready = data.items.filter((i) => !i.imported && !i.badCron)
  const added = read(importAdded)
  return (
    <Stack gap="sm">
      <Separator />
      <Stack gap="xs">
        <Text size="sm" weight="medium">
          {w.title}
        </Text>
        <Text size="xs" muted>
          {w.hint(data.dir)}
        </Text>
      </Stack>
      <Stack gap="xs">
        {data.items.map((i) => (
          <Box key={i.id} direction="row" align="start" gap="xs">
            <Box grow shrink minWidth={0}>
              <Text size="xs" weight="medium">
                {soft(i.name)}
              </Text>
              <Text size="xs" muted>
                {soft([i.badCron ? i.cron : describe(i.cron, l), i.terminal.title, i.open ? '' : u.notOpen].filter(Boolean).join(' · '))}
              </Text>
            </Box>
            {i.imported ? <Badge tone="success">{w.imported}</Badge> : i.badCron ? <Badge tone="warning">{w.badCron}</Badge> : null}
          </Box>
        ))}
      </Stack>
      {added !== null ? (
        <Callout tone="success" icon="check" title={w.done(added)}>
          {w.doneHint}
        </Callout>
      ) : null}
      {read(importError) ? (
        <Callout tone="danger" title={w.failed}>
          {read(importError)}
        </Callout>
      ) : null}
      {ready.length > 0 ? (
        <Row>
          <Button size="sm" variant="outline" icon="download" disabled={read(importing)} onPress={() => void runImport(ready.map((i) => i.id))}>
            {w.button(ready.length)}
          </Button>
        </Row>
      ) : added === null && data.items.every((i) => i.imported) ? (
        <Text size="xs" muted>
          {w.nothing}
        </Text>
      ) : null}
    </Stack>
  )
}

/** The inbox folder: where a bot or an agent writes a schedule, how many came from it, and the files of
 *  the last check that could not be used — the writer has no other place to learn why nothing showed up. */
function Inbox() {
  const w = words(read(lang)).ui.inbox
  const data = read(inboxStatus)
  if (!data) return null
  const count = read(schedules).filter((s) => s.source).length
  return (
    <Stack gap="xs">
      <Separator />
      <Text size="sm" weight="medium">
        {w.title}
      </Text>
      <Text size="xs" muted>
        {soft(w.hint(data.dir))}
      </Text>
      {count > 0 || data.found ? <Text size="xs">{w.count(count)}</Text> : <Text size="xs" muted>{w.empty}</Text>}
      {data.problems.length > 0 ? (
        <Callout tone="warning" icon="warning" title={w.problems}>
          <Stack gap="xs">
            {data.problems.map((p) => (
              <Text key={p.file} size="xs">
                {soft(`${p.file} — ${w.problem[p.code]}`)}
              </Text>
            ))}
          </Stack>
        </Callout>
      ) : null}
    </Stack>
  )
}

function Settings() {
  const u = words(read(lang)).ui
  const pick = (v: string) => {
    const pref: LangPref = v === 'en' || v === 'ko' ? v : 'auto'
    set(langPref, pref)
    set(lang, langFor(pref))
  }
  return (
    <Stack gap="md">
      <SubHeader title={u.settings} onClose={() => set(settingsOpen, false)} />
      <RadioGroup
        label={u.language}
        value={read(langPref)}
        options={[
          { value: 'auto', label: u.langAuto(langNames[langOfLocale(env.locale)]) },
          { value: 'en', label: langNames.en },
          { value: 'ko', label: langNames.ko }
        ]}
        onChange={pick}
      />
      {/* The rule for sending is read once or twice — here, not under a list that is looked at all day. */}
      <Callout tone="neutral" icon="info" title={u.help}>
        <Text size="xs">{u.footer}</Text>
      </Callout>
      <Box direction="row" align="center" gap="sm" wrap>
        <Button
          size="sm"
          variant="outline"
          icon="info"
          onPress={() => {
            set(settingsOpen, false)
            set(introStep, 0)
          }}
        >
          {u.showIntro}
        </Button>
        <Link href={RELEASE_NOTES}>{u.whatsNew}</Link>
      </Box>
      <Inbox />
      <Importer />
    </Stack>
  )
}

// ───────────────────────── Introduction ─────────────────────────

const introIcons: IconName[] = ['calendar', 'gauge', 'terminal']

/** Three pages on the first open (and from Settings): what it does, when it sends, where to start. */
function Intro() {
  const u = words(read(lang)).ui
  const steps = u.intro.steps
  const i = Math.min(read(introStep) ?? 0, steps.length - 1)
  const last = i === steps.length - 1
  const finish = () => {
    // First time and nothing scheduled — the place to start is a terminal. Opened again, it returns
    // to where it was.
    if (!read(onboarded) && read(schedules).length === 0) showTerminals()
    set(onboarded, true)
    set(introStep, null)
  }
  return (
    <Stack gap="md">
      <Box direction="row" align="center" gap="xs">
        <Box grow shrink minWidth={0}>
          <Text size="sm" weight="semibold" truncate>
            {TITLE}
          </Text>
        </Box>
        <Text size="xs" muted>
          {u.intro.step(i + 1, steps.length)}
        </Text>
      </Box>
      <Progress label={u.intro.step(i + 1, steps.length)} labelHidden value={Math.round(((i + 1) / steps.length) * 100)} />
      <EmptyState icon={introIcons[i]} title={steps[i].title} description={steps[i].body} />
      <Box direction="row" align="center" gap="xs">
        {i > 0 ? (
          <Button size="sm" variant="ghost" onPress={() => set(introStep, i - 1)}>
            {u.intro.prev}
          </Button>
        ) : null}
        <Box grow />
        {last ? null : (
          <Button size="sm" variant="ghost" onPress={finish}>
            {u.intro.skip}
          </Button>
        )}
        <Button size="sm" variant="solid" tone="accent" onPress={last ? finish : () => set(introStep, i + 1)}>
          {last ? u.intro.start : u.intro.next}
        </Button>
      </Box>
    </Stack>
  )
}

// ───────────────────────── Panel ─────────────────────────

export default function Panel() {
  if (!read(onboarded) || read(introStep) !== null) return <Intro />
  if (read(formOpen)) return <Form />
  if (read(settingsOpen)) return <Settings />
  return (
    <Stack gap="sm">
      <Header />
      <Nav />
      {read(tab) === 'terminals' ? <TerminalsView /> : <SchedulesView />}
    </Stack>
  )
}
