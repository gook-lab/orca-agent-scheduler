// `orca plugin test .` runs this with the same runtime and checks as Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import { blankSchedule, type Schedule } from './engine'
import type { ScheduleDraft, TerminalOption } from './protocol'
import { words } from './i18n'
import * as panel from './panel'

const open: TerminalOption[] = [
  { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'acme_notes', tabId: 't1', leafId: 'l1' },
  { handle: 'h2', title: 'Review', agent: 'codex', workspaceId: 'w2', workspace: 'toy', tabId: 't2', leafId: 'l2' }
]

type Calls = { saved: ScheduleDraft[]; focused: string[]; deleted: string[]; restored: Schedule[] }

type HostOpts = {
  terminals?: TerminalOption[]
  storage?: Record<string, unknown>
}

function host(calls: Partial<Calls> = {}, opts: HostOpts = {}) {
  const list = opts.terminals ?? open
  return mockHost({
    // Past the introduction unless a test says otherwise.
    storage: { onboarded: true, ...opts.storage } as never,
    requests: {
      'schedules.list': () => [],
      'terminals.list': () => list,
      'schedules.save': (d) => {
        calls.saved?.push(d as ScheduleDraft)
        return { ...blankSchedule('s1'), ...(d as object) } as never
      },
      'terminals.focus': (input) => {
        calls.focused?.push((input as { handle: string }).handle)
        return { ok: true }
      },
      'schedules.delete': (input) => {
        calls.deleted?.push((input as { id: string }).id)
        return { ok: true }
      },
      'schedules.restore': (input) => {
        calls.restored?.push((input as { schedule: Schedule }).schedule)
        return (input as { schedule: Schedule }).schedule as never
      }
    }
  })
}

async function fillBasics(view: Awaited<ReturnType<typeof mount>>) {
  await view.press({ type: 'IconButton', label: 'New schedule' })
  await view.type({ label: 'Name' }, 'Code review')
  await view.press({ type: 'ListItem', label: 'Review' })
  await view.type({ label: 'Prompt' }, 'Review open PRs')
}

/** A Callout or Collapsible by its title — titles are props, not query fields. */
const titled = (view: Awaited<ReturnType<typeof mount>>, type: string, title: string) =>
  view.findAll({ type }).find((e) => e.props.title === title) ?? null

const at = (h: number, m = 0, dayOffset = 0): number => {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

test('English by default — empty state, then a schedule on a picked terminal', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  assert.ok(view.find({ label: 'No schedules yet' }))
  await fillBasics(view)
  assert.deepEqual(
    view.findAll({ type: 'ListItem' }).map((e) => [e.label, e.props.description, e.props.icon]),
    [['Review', 'toy · Codex', 'terminal']],
    'picked from the list, then folded to one line'
  )
  await view.press({ type: 'Button', text: 'Change' })
  assert.deepEqual(
    view.findAll({ type: 'ListItem' }).map((e) => [e.label, e.props.current]),
    [
      ['Morning', false],
      ['Review', true]
    ],
    'Change opens the list with the picked one marked'
  )
  await view.press({ type: 'ListItem', label: 'Review' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1, 'picking folds it again')
  assert.equal(view.find({ type: 'Select', label: 'Terminal' }), null, 'no popup to spill past the panel')
  await view.type({ label: 'Time 1' }, '9:30', { replace: true })
  await view.press({ text: 'Add time' })
  await view.type({ label: 'Time 2' }, '1800', { replace: true })
  assert.ok(view.find({ text: 'Weekdays 09:30 · 18:00' }))
  await view.toggle({ label: 'Start a new conversation (send /clear first)' })
  await view.press({ text: 'Create schedule' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].cron, '30 9 * * 1-5; 0 18 * * 1-5')
  assert.deepEqual(saved[0].terminal, open[1])
  assert.equal(saved[0].clearFirst, true)
  assert.equal('id' in saved[0], false, 'a new schedule sends no id')
  assert.equal('once' in saved[0], false)
  assert.ok(view.find({ label: 'No schedules yet' }), 'back on the list')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('pick days — Monday first, toggled by pressing', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await fillBasics(view)
  await view.select({ label: 'Days' }, 'pick')
  for (const day of ['Tue', 'Thu', 'Fri']) await view.press({ type: 'Button', text: day })
  assert.ok(view.find({ text: 'Every Mon·Wed 09:00' }), 'weekdays carried over, then three turned off')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].cron, '0 9 * * 1,3')
  await view.unmount()
})

test('dates — press days on the calendar, across months', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await fillBasics(view)
  await view.select({ label: 'Days' }, 'dates')
  assert.ok(view.find({ text: /Pick at least one date/ }))
  assert.equal(view.find({ text: 'Create schedule' })?.props.disabled, true)
  await view.press({ type: 'Button', text: '›' })
  await view.press({ type: 'Button', text: '15' })
  await view.press({ type: 'Button', text: '20' })
  const t = new Date()
  const y = t.getMonth() === 11 ? t.getFullYear() + 1 : t.getFullYear()
  const m = ((t.getMonth() + 1) % 12) + 1
  assert.ok(view.find({ text: '2 dates picked' }))
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].cron, `0 9 15,20 ${m} * ${y}`)
  await view.unmount()
})

test('repeat — every N minutes all day or between two times', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await fillBasics(view)
  await view.select({ label: 'Time' }, 'every')
  await view.type({ label: 'Every (minutes)' }, '30', { replace: true })
  assert.ok(view.find({ text: 'Weekdays 09:00–18:00, every 30 min' }))
  await view.select({ label: 'Between' }, 'allDay')
  assert.ok(view.find({ text: 'Weekdays, every 30 min' }))
  await view.select({ label: 'Between' }, 'between')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].cron, '*/30 9-17 * * 1-5; 0 18 * * 1-5')
  await view.unmount()
})

test('a bad time or no terminal keeps Create disabled', async () => {
  const view = await mount(panel, { host: host() })
  await view.press({ type: 'IconButton', label: 'New schedule' })
  assert.equal(view.find({ text: 'Create schedule' })?.props.disabled, true, 'no terminal yet')
  await view.press({ type: 'ListItem', label: 'Morning' })
  await view.type({ label: 'Time 1' }, '25:00', { replace: true })
  assert.ok(view.find({ text: /Check the time fields/ }))
  assert.equal(view.find({ text: 'Create schedule' })?.props.disabled, true)
  await view.press({ type: 'IconButton', label: 'Close' })
  assert.ok(titled(view, 'Callout', 'Discard what you wrote?'), 'something was typed, so × asks')
  await view.press({ text: 'Discard' })
  assert.ok(view.find({ label: 'No schedules yet' }), 'then returns to the list')
  await view.unmount()
})

test("language — Orca's by default, or the one picked in Settings; stored for the worker", async () => {
  const ko = await mount(panel, { host: host(), locale: 'ko-KR' })
  assert.ok(ko.find({ label: '예약이 없습니다' }), 'Orca in Korean, so the panel too')
  assert.equal(ko.host.data().storage.lang, 'ko', 'stored for the worker')
  await ko.unmount()
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ label: 'No schedules yet' }))
  await view.press({ label: 'Settings' })
  const picker = view.find({ type: 'RadioGroup', label: 'Language' })
  assert.equal(picker?.props.value, 'auto')
  assert.equal((picker?.props.options as { label: string }[])[0].label, 'Same as Orca (English)')
  await view.select({ label: 'Language' }, 'ko')
  assert.equal(view.host.data().storage.lang, 'ko')
  assert.equal(view.host.data().storage.langPref, 'ko')
  await view.press({ type: 'IconButton', label: '닫기' })
  assert.ok(view.find({ label: '예약이 없습니다' }))
  await view.unmount()
  const again = await mount(panel, { host: host({}, { storage: { langPref: 'ko' } }) })
  assert.ok(again.find({ type: 'Tab', label: '터미널 2' }), 'the pick holds while Orca is in English')
  await again.press({ type: 'IconButton', label: '새 예약' })
  assert.ok(again.find({ text: '평일 09:00' }))
  await again.unmount()
})

test('counts on top — schedules, on, waiting, attention, runs today — and what runs next', async () => {
  const view = await mount(panel, { host: host() })
  const morning: Schedule = {
    ...blankSchedule('s1'),
    name: 'Morning report',
    terminal: { ...open[0] },
    nextRunAt: at(23, 59),
    history: [
      { at: Date.now() - 60_000, status: 'done' },
      { at: at(0, 0, -1), status: 'failed' }
    ]
  }
  const stuck: Schedule = {
    ...blankSchedule('s2'),
    name: 'Review',
    terminal: { ...open[1] },
    nextRunAt: at(9, 0, 1),
    pendingSince: Date.now() - 60_000,
    waitNote: { code: 'typing' }
  }
  const off: Schedule = { ...blankSchedule('s3'), name: 'Paused', terminal: { ...open[1] }, enabled: false }
  await view.post('schedules.changed', { schedules: [morning, stuck, off] })
  for (const text of ['3 schedules', '2 on', '1 waiting', '1 need attention', '1 run today']) assert.ok(view.find({ text }), text)
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Check').length, 1, 'orange only for the one counted')
  assert.ok(view.find({ text: 'Next today 23:59 · Morning report' }))
  await view.unmount()
})

test('Schedules has one block per terminal — closed ones keep theirs; Terminals lists every open one', async () => {
  const many = [...open, ...[3, 4, 5, 6].map((n) => ({ ...open[0], handle: `h${n}`, leafId: `l${n}`, title: `Spare ${n}` }))]
  const view = await mount(panel, { host: host({}, { terminals: many }) })
  const running: Schedule = {
    ...blankSchedule('s1'),
    name: 'Morning report',
    terminal: { ...open[0] },
    nextRunAt: Date.now() + 3600_000,
    pendingSince: Date.now(),
    waitNote: { code: 'moving' },
    lastStatus: 'done',
    history: [{ at: Date.now() - 86400_000, status: 'done', tookMs: 3 * 60_000 }]
  }
  const gone: Schedule = { ...blankSchedule('s2'), name: 'Old', terminal: { ...open[1], handle: 'h-gone', leafId: 'l-gone' }, prompt: 'x' }
  await view.post('schedules.changed', { schedules: [running, gone] })
  assert.ok(view.find({ text: 'Waiting to send · Screen changed in the last minute (working or typing)' }), 'an ordinary wait stays grey')
  assert.ok(view.find({ text: /This terminal is not open/ }))
  assert.equal(titled(view, 'Callout', 'Check'), null, 'nothing here needs a person yet — the count on top says 0 too')
  assert.ok(view.find({ text: 'Done' }))
  assert.ok(view.find({ text: /took 3 min/ }))
  assert.equal(view.find({ label: 'Codex — Show this terminal in Orca' })?.props.disabled, true, 'a closed terminal cannot be shown')
  assert.equal(view.find({ text: 'Spare 6' }), null, 'terminals without schedules are on the other tab')
  assert.ok(view.find({ type: 'Tab', label: 'Schedules 2' }))
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.equal(view.findAll({ type: 'Text', text: 'acme_notes' }).length, 5, 'h1 and the four spares')
  assert.equal(view.find({ label: 'Codex — Show this terminal in Orca' })?.props.disabled, false, 'h2 is open')
  assert.deepEqual(
    view.findAll({ type: 'Text', text: /^(✳|>_)$/ }).map((e) => e.text),
    ['✳', '>_', '✳', '✳', '✳', '✳'],
    "each terminal's agent mark"
  )
  assert.ok(view.find({ text: 'Spare 6' }))
  assert.equal(view.find({ label: 'Morning report' }), null, 'no schedules on this tab')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('search filters both tabs — by terminal, workspace, agent or schedule name', async () => {
  const view = await mount(panel, { host: host() })
  const named = (id: string, name: string, t: TerminalOption): Schedule => ({ ...blankSchedule(id), name, terminal: { ...t } })
  await view.post('schedules.changed', {
    schedules: [named('s1', 'Morning report', open[0]), named('s2', 'Release notes', open[0]), named('s3', 'PR review', open[1])]
  })
  await view.type({ label: 'Find' }, 'RELEASE')
  assert.ok(view.find({ label: 'Release notes' }))
  assert.equal(view.find({ label: 'Morning report' }), null, 'same terminal, name does not match')
  assert.equal(view.find({ label: 'PR review' }), null)
  await view.type({ label: 'Find' }, 'codex', { replace: true })
  assert.ok(view.find({ label: 'PR review' }), 'the agent matches, so its whole block stays')
  assert.equal(view.find({ label: 'Release notes' }), null)
  await view.type({ label: 'Find' }, 'nothing here', { replace: true })
  assert.ok(view.find({ label: 'Nothing matches “nothing here”' }))
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.ok(view.find({ label: 'Nothing matches “nothing here”' }), 'the same search on Terminals')
  await view.press({ text: 'Clear search' })
  assert.equal(view.find({ label: 'Find' })?.props.value, '', 'the way out is right there')
  assert.ok(view.find({ type: 'Text', text: 'acme_notes' }))
  await view.type({ label: 'Find' }, 'toy', { replace: true })
  assert.ok(view.find({ type: 'Text', text: 'toy' }))
  assert.equal(view.find({ type: 'Text', text: 'acme_notes' }), null)
  await view.unmount()
})

test('folding a block leaves a one-line summary', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] }, nextRunAt: at(9, 0, 1) }
  await view.post('schedules.changed', { schedules: [s] })
  assert.ok(view.find({ label: 'Morning report' }))
  await view.press({ label: 'Collapse' })
  assert.equal(view.find({ label: 'Morning report' }), null)
  assert.ok(view.find({ text: '1 schedule · next tomorrow 09:00' }))
  await view.press({ label: 'Expand' })
  assert.ok(view.find({ label: 'Morning report' }))
  await view.unmount()
})

test('↗ shows the terminal in Orca; pressing a block name only folds it', async () => {
  const focused: string[] = []
  const view = await mount(panel, { host: host({ focused }) })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ type: 'Button', text: 'acme_notes' })
  assert.equal(view.find({ label: 'Morning report' }), null, 'folded')
  await view.press({ type: 'Button', text: 'acme_notes' })
  assert.ok(view.find({ label: 'Morning report' }), 'open again')
  assert.deepEqual(focused, [], 'Orca was not moved')
  await view.select({ type: 'Tabs' }, 'terminals')
  await view.press({ label: 'Codex — Show this terminal in Orca' })
  await view.press({ label: 'Claude Code — Show this terminal in Orca' })
  assert.deepEqual(focused, ['h2', 'h1'])
  await view.unmount()
})

test('send once from a terminal line — no days or times, the name may stay empty', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await view.select({ type: 'Tabs' }, 'terminals')
  // The title row's, then one per terminal — the last is Review's.
  const sendButtons = view.findAll({ label: 'Send once' })
  assert.equal(sendButtons.length, 3)
  await view.press(sendButtons[2])
  assert.deepEqual(view.findAll({ type: 'ListItem' }).map((e) => e.label), ['Review'], 'the terminal it came from, on one line')
  assert.ok(view.find({ type: 'Button', text: 'Change' }))
  assert.equal(view.find({ label: 'Days' }), null)
  assert.equal(view.find({ text: 'Send' })?.props.disabled, true, 'no prompt yet')
  assert.ok(view.find({ text: 'Enter the prompt to send' }), 'and it says so')
  await view.type({ label: 'Prompt' }, 'Summarise the open PRs')
  await view.press({ text: 'Send' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].once, true)
  assert.equal(saved[0].name, '')
  assert.deepEqual(saved[0].terminal, open[1])
  await view.unmount()
})

test('sent records sit folded under their terminal', async () => {
  const view = await mount(panel, { host: host() })
  const done: Schedule = {
    ...blankSchedule('o1'),
    once: true,
    name: 'Summarise the open PRs',
    terminal: { ...open[0] },
    cron: '',
    lastStatus: 'done',
    history: [{ at: at(12, 3), status: 'done', tookMs: 60_000 }]
  }
  await view.post('schedules.changed', { schedules: [done] })
  assert.ok(titled(view, 'Collapsible', 'Sent 1 · last today 12:03'))
  assert.ok(view.find({ text: '0 schedules' }), 'one-off sends are not counted as schedules')
  await view.unmount()
})

test('the sent group counts sends still waiting apart from those sent', async () => {
  const view = await mount(panel, { host: host() })
  const one = (id: string, extra: Partial<Schedule>): Schedule => ({ ...blankSchedule(id), once: true, name: id, terminal: { ...open[0] }, cron: '', ...extra })
  const waiting = one('w1', { pendingSince: Date.now(), waitNote: { code: 'missing' } })
  const done = (id: string, m: number) => one(id, { lastStatus: 'done', history: [{ at: at(12, m), status: 'done' } as never] })
  const title = () => view.findAll({ type: 'Collapsible' }).map((e) => String(e.props.title))
  await view.post('schedules.changed', { schedules: [waiting] })
  assert.deepEqual(title(), ['Waiting to send 1'], 'nothing has gone out yet')
  await view.post('schedules.changed', { schedules: [waiting, done('d1', 3), done('d2', 1)] })
  assert.deepEqual(title(), ['Waiting to send 1 · Sent 2'])
  await view.post('schedules.changed', { schedules: [done('d1', 3), done('d2', 1)] })
  assert.deepEqual(title(), ['Sent 2 · last today 12:03'])
  await view.unmount()
})

test('duplicate opens a copy; delete offers Undo', async () => {
  const saved: ScheduleDraft[] = []
  const deleted: string[] = []
  const restored: Schedule[] = []
  const view = await mount(panel, { host: host({ saved, deleted, restored }) })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Release', terminal: { ...open[0] }, cron: '0 9 * * 1-5', prompt: 'Ship it' }
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ label: 'Duplicate' })
  assert.equal(view.find({ label: 'Name' })?.props.value, 'Release copy')
  await view.press({ text: 'Create schedule' })
  assert.equal('id' in saved[0], false, 'saved as a new schedule')
  assert.equal(saved[0].prompt, 'Ship it')
  await view.press({ label: 'Delete' })
  assert.deepEqual(deleted, ['s1'])
  await view.post('schedules.changed', { schedules: [] })
  assert.equal(view.find({ label: 'No schedules yet' }), null, 'the block stays while Undo is offered')
  assert.ok(view.find({ text: 'Deleted “Release”' }), 'Undo where the schedule was, under its terminal')
  assert.ok(view.find({ type: 'Button', text: 'acme_notes' }))
  await view.press({ text: 'Undo' })
  assert.equal(restored[0].id, 's1')
  assert.equal(view.find({ text: 'Deleted “Release”' }), null)
  await view.unmount()
})

test('the worker pushes the terminal list — a closed terminal turns its block grey', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  await view.post('schedules.changed', { schedules: [s] })
  const show = () => view.find({ label: 'Claude Code — Show this terminal in Orca' })?.props.disabled
  assert.equal(show(), false)
  await view.post('terminals.changed', { terminals: [open[1]] })
  assert.equal(show(), true)
  assert.ok(view.find({ text: /This terminal is not open/ }))
  await view.unmount()
})

test('editing a schedule on a closed terminal keeps that terminal first, marked not open', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const gone = { ...open[0], handle: 'h-gone', leafId: 'l-gone', title: 'Old docs' }
  const s: Schedule = { ...blankSchedule('s1'), name: 'Release', terminal: gone, prompt: 'Ship it' }
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ label: 'Edit' })
  const line = view.findAll({ type: 'ListItem' })
  assert.equal(line.length, 1, 'folded to the saved terminal')
  assert.equal(line[0].label, 'Old docs')
  assert.equal(line[0].disabled, true)
  assert.match(String(line[0].props.description), /not open/)
  await view.press({ type: 'Button', text: 'Change' })
  const first = view.findAll({ type: 'ListItem' })[0]
  assert.equal(first.label, 'Old docs', 'first in the list')
  assert.equal(first.props.current, true)
  assert.equal(first.disabled, true)
  await view.press({ text: 'Save' })
  assert.deepEqual(saved[0].terminal, gone, 'saving without picking keeps the old terminal')
  await view.unmount()
})

test('editing reopens the form as saved — dates on their month', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const t = new Date()
  const y = t.getMonth() === 11 ? t.getFullYear() + 1 : t.getFullYear()
  const m = ((t.getMonth() + 1) % 12) + 1
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const s: Schedule = { ...blankSchedule('s1'), name: 'Release', terminal: { ...open[0] }, cron: `0 9 20,25 ${m} * ${y}`, prompt: 'Ship it' }
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ label: 'Edit' })
  assert.equal(view.find({ label: 'Days' })?.props.value, 'dates')
  assert.ok(view.find({ text: `${months[m - 1]} ${y}` }))
  assert.ok(view.find({ text: '2 dates picked' }))
  await view.press({ text: 'Save' })
  assert.equal(saved[0].cron, `0 9 20,25 ${m} * ${y}`)
  assert.equal(saved[0].id, 's1')
  await view.unmount()
})

test('Create stays off and says why — the first missing field, in form order', async () => {
  const view = await mount(panel, { host: host() })
  await view.press({ type: 'IconButton', label: 'New schedule' })
  const off = () => view.find({ text: 'Create schedule' })?.props.disabled
  assert.ok(view.find({ text: 'Enter a name' }))
  assert.equal(off(), true)
  await view.type({ label: 'Name' }, 'Nightly')
  assert.ok(view.find({ text: /^Pick an agent terminal/ }))
  assert.equal(off(), true)
  await view.press({ type: 'ListItem', label: 'Review' })
  assert.ok(view.find({ text: 'Enter the prompt to send' }))
  assert.equal(off(), true)
  await view.type({ label: 'Prompt' }, 'Wrap up')
  assert.equal(view.find({ text: 'Enter the prompt to send' }), null)
  assert.equal(off(), false)
  await view.unmount()
})

test('after saving, the Schedules tab shows that terminal open — a search that would hide it is cleared', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  const other: Schedule = { ...blankSchedule('s2'), name: 'Other', terminal: { ...open[1] } }
  await view.post('schedules.changed', { schedules: [s, other] })
  await view.press(view.findAll({ label: 'Collapse' })[0])
  await view.select({ type: 'Tabs' }, 'terminals')
  await view.press(view.findAll({ label: 'New schedule for this terminal' })[0])
  await view.type({ label: 'Name' }, 'Nightly')
  await view.type({ label: 'Prompt' }, 'Wrap up')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].terminal.handle, 'h1')
  // findAll keeps the innermost matches, so the row's outer box is counted in the drawn tree.
  const tinted = JSON.stringify(view.tree()).split('"background":"success"').length - 1
  assert.equal(tinted, 1, 'the saved one is tinted for a moment')
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'schedules', 'not left on Terminals')
  assert.ok(view.find({ label: 'Morning report' }), 'its block is open again')
  await view.type({ label: 'Find' }, 'nothing like it')
  await fillBasics(view)
  await view.press({ text: 'Create schedule' })
  assert.equal(view.find({ label: 'Find' })?.props.value, '', 'the search hid it, so it is cleared')
  await view.type({ label: 'Find' }, 'toy')
  await fillBasics(view)
  await view.press({ text: 'Create schedule' })
  assert.equal(view.find({ label: 'Find' })?.props.value, 'toy', 'a search that still shows it stays')
  await view.unmount()
})

test('a one-off waiting its turn is grey; one stuck on a closed terminal is orange', async () => {
  const view = await mount(panel, { host: host() })
  const once = (id: string, t: TerminalOption, code: 'moving' | 'missing'): Schedule => ({
    ...blankSchedule(id),
    once: true,
    name: id,
    terminal: { ...t },
    cron: '',
    pendingSince: Date.now(),
    waitNote: { code }
  })
  await view.post('schedules.changed', { schedules: [once('o1', open[0], 'moving'), once('o2', { ...open[1], handle: 'h-gone', leafId: 'l-gone' }, 'missing')] })
  const moving = view.find({ text: 'Screen changed in the last minute (working or typing)' })
  assert.equal(moving?.props.tone, undefined)
  assert.equal(moving?.props.muted, true)
  assert.equal(view.find({ text: 'Terminal is not open — waiting for it' })?.props.tone, 'warning')
  assert.ok(view.find({ text: '1 need attention' }), 'the orange one is the one counted')
  await view.unmount()
})

test('send once — terminal, prompt, Send; the name waits under More options; no /clear', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await view.press({ type: 'IconButton', label: 'Send once' })
  assert.equal(view.find({ label: 'Name' }), null, 'not in the way')
  assert.ok(view.find({ label: 'Prompt' }))
  const more = titled(view, 'Collapsible', 'More options')
  assert.ok(more)
  assert.equal(more?.props.defaultOpen, false)
  await view.toggle(more!)
  assert.ok(view.find({ label: 'Name' }))
  assert.equal(view.find({ label: 'Start a new conversation (send /clear first)' }), null, 'it would erase the conversation it carries on')
  await view.press({ type: 'ListItem', label: 'Review' })
  await view.type({ label: 'Prompt' }, 'Summarise the open PRs')
  await view.press({ text: 'Send' })
  assert.equal(saved[0].once, true)
  assert.equal(saved[0].name, '')
  assert.equal(saved[0].clearFirst, false)
  await view.unmount()
})

test('leaving the form — at once when nothing changed; otherwise asks by the button pressed', async () => {
  const view = await mount(panel, { host: host() })
  await view.press({ type: 'IconButton', label: 'New schedule' })
  await view.press({ type: 'IconButton', label: 'Close' })
  assert.ok(view.find({ label: 'No schedules yet' }), 'nothing typed — no question')
  await view.press({ type: 'IconButton', label: 'New schedule' })
  await view.type({ label: 'Prompt' }, 'Long prompt being written')
  await view.press({ text: 'Cancel' })
  const asked = titled(view, 'Callout', 'Discard what you wrote?')
  assert.ok(asked)
  // A path is `#0/#n/…` — n is the row of the form, top to bottom.
  const row = (e: { path: string } | null) => Number(e?.path.split('/')[1]?.slice(1) ?? NaN)
  assert.ok(row(asked) > row(view.find({ text: 'Cancel' })), 'asked under Cancel, where the eye is')
  await view.press({ text: 'Keep editing' })
  assert.equal(view.find({ label: 'Prompt' })?.props.value, 'Long prompt being written', 'kept')
  await view.press({ type: 'IconButton', label: 'Close' })
  assert.equal(row(titled(view, 'Callout', 'Discard what you wrote?')), 1, 'asked right under ×')
  await view.press({ text: 'Discard' })
  assert.ok(view.find({ label: 'No schedules yet' }))
  await view.unmount()
})

test('a terminal with schedules shows how many on the Terminals tab, and goes to them', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ label: 'Collapse' })
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.equal(view.findAll({ type: 'Button', text: 'Schedules 1' }).length, 1, 'only on the terminal that has one')
  await view.press({ type: 'Button', text: 'Schedules 1' })
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'schedules')
  assert.ok(view.find({ label: 'Morning report' }), 'its block open')
  await view.unmount()
})

test('favorites go first on both tabs and are kept in storage', async () => {
  const view = await mount(panel, { host: host() })
  const s = (id: string, t: TerminalOption): Schedule => ({ ...blankSchedule(id), name: id, terminal: { ...t } })
  await view.post('schedules.changed', { schedules: [s('a', open[0]), s('b', open[1])] })
  const blocks = () => view.findAll({ label: /— Show this terminal in Orca$/ }).map((e) => e.label)
  assert.deepEqual(blocks(), ['Claude Code — Show this terminal in Orca', 'Codex — Show this terminal in Orca'])
  await view.press(view.findAll({ label: 'Add to favorites' })[1])
  assert.deepEqual(blocks(), ['Codex — Show this terminal in Orca', 'Claude Code — Show this terminal in Orca'], 'Review first')
  assert.deepEqual(view.host.data().storage.favorites, ['l2'], 'by pane id')
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.deepEqual(blocks(), ['Codex — Show this terminal in Orca', 'Claude Code — Show this terminal in Orca'])
  await view.unmount()
  const again = await mount(panel, { host: host({}, { storage: { favorites: ['l2'] } }) })
  await again.select({ type: 'Tabs' }, 'terminals')
  assert.equal(again.findAll({ label: 'Remove from favorites' }).length, 1, 'remembered')
  await again.press({ label: 'Remove from favorites' })
  assert.deepEqual(again.host.data().storage.favorites, [])
  await again.unmount()
})


test('first open — three pages of introduction, then the Terminals tab when nothing is scheduled', async () => {
  const view = await mount(panel, { host: host({}, { storage: { onboarded: undefined } }) })
  assert.ok(view.find({ label: 'Prompts on a schedule' }), 'page 1 in place of the list')
  assert.ok(view.find({ text: '1 / 3' }))
  const bar = () => view.find({ type: 'Progress' })?.props.value
  assert.equal(bar(), 33, 'a bar fills page by page')
  assert.equal(view.find({ type: 'Tabs' }), null, 'no list behind it')
  assert.equal(view.find({ text: 'Back' }), null, 'nothing before page 1')
  await view.press({ text: 'Next' })
  assert.ok(view.find({ label: 'Only when the terminal is free' }))
  assert.equal(bar(), 67)
  await view.press({ text: 'Back' })
  assert.ok(view.find({ label: 'Prompts on a schedule' }))
  await view.press({ text: 'Next' })
  await view.press({ text: 'Next' })
  assert.ok(view.find({ label: 'Start from a terminal' }))
  assert.equal(bar(), 100)
  assert.equal(view.find({ text: 'Skip' }), null, 'the last page only starts')
  await view.press({ text: 'Get started' })
  assert.equal(view.host.data().storage.onboarded, true, 'shown once')
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'terminals', 'where a schedule starts')
  await view.unmount()
  const again = await mount(panel, { host: host({}, { storage: { onboarded: true } }) })
  assert.equal(again.find({ label: 'Prompts on a schedule' }), null, 'not again')
  await again.unmount()
})

test('Skip ends the introduction at once; Settings opens it again, back to the same tab', async () => {
  const view = await mount(panel, { host: host({}, { storage: { onboarded: undefined } }) })
  await view.post('schedules.changed', { schedules: [{ ...blankSchedule('a'), name: 'Morning report', terminal: { ...open[0] } }] })
  await view.press({ text: 'Skip' })
  assert.equal(view.host.data().storage.onboarded, true)
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'schedules', 'something is scheduled — stay on it')
  await view.press({ label: 'Settings' })
  await view.press({ text: 'Show the introduction again' })
  assert.ok(view.find({ label: 'Prompts on a schedule' }))
  await view.press({ text: 'Skip' })
  assert.ok(view.find({ label: 'Morning report' }), 'back to the list, not Settings')
  await view.unmount()
})

test('the empty list is one line and a button; how sending works opens under the list', async () => {
  const view = await mount(panel, { host: host() })
  const empty = view.find({ label: 'No schedules yet' })
  assert.equal(empty?.props.description, 'Press + on a terminal in the Terminals tab to start.')
  const rule = /^Checks every 30 seconds/
  assert.equal(view.find({ text: rule }), null, 'the rule is not spelled out up front')
  await view.press({ text: 'How sending works' })
  assert.ok(titled(view, 'Callout', 'How sending works'))
  assert.ok(view.find({ text: rule }))
  await view.press({ text: 'Show the introduction again' })
  assert.ok(view.find({ label: 'Prompts on a schedule' }))
  await view.press({ text: 'Skip' })
  assert.ok(view.find({ label: 'No schedules yet' }), 'opened again, it returns to where it was')
  await view.press({ type: 'Button', text: 'How sending works' })
  assert.equal(titled(view, 'Callout', 'How sending works'), null, 'pressed again, it closes')
  await view.press({ text: 'Open Terminals' })
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'terminals')
  await view.unmount()
})

test('time left — seconds under an hour, minutes under a day, in both languages', () => {
  const en = words('en').ui.until
  const ko = words('ko').ui.until
  assert.deepEqual([en(500), en(728_000), en(3_725_000), en(90_000_000)], ['now', 'in 12m 08s', 'in 1h 02m', 'in 1d 1h'])
  assert.deepEqual([ko(500), ko(728_000), ko(3_725_000), ko(90_000_000)], ['곧', '12분 08초 뒤', '1시간 02분 뒤', '1일 1시간 뒤'])
})

test('the next run counts down every second while the panel is in view, and rests while hidden', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('a'), name: 'Morning report', terminal: { ...open[0] }, enabled: true, nextRunAt: Date.now() + 728_500 }
  await view.post('schedules.changed', { schedules: [s] })
  const left = () => view.find({ text: /^in 12m \d\ds$/ })?.text ?? null
  const first = left()
  assert.ok(first, 'beside what runs next')
  await new Promise((r) => setTimeout(r, 1600))
  await view.settled()
  assert.notEqual(left(), first, 'a second later it moved')
  await view.setVisible(false)
  const hidden = left()
  await new Promise((r) => setTimeout(r, 1600))
  await view.settled()
  assert.equal(left(), hidden, 'not redrawn while nobody sees it')
  await view.unmount()
})

test('a run being sent spins; before the first answer both tabs show a placeholder', async () => {
  const view = await mount(panel, { host: host() })
  await view.post('schedules.changed', { schedules: [{ ...blankSchedule('a'), name: 'Morning report', terminal: { ...open[0] }, sentAt: Date.now() }] })
  assert.ok(view.find({ type: 'Spinner', label: 'Running · sent' }))
  assert.equal(view.find({ type: 'Skeleton' }), null, 'answered, so no placeholder')
  await view.unmount()
  // The component alone, before setup has asked the worker anything.
  const early = await mount(panel.default!, { host: host() })
  assert.ok(early.find({ type: 'Skeleton', label: 'Reading the list' }), 'not "No schedules yet" yet')
  const tabs = () => early.findAll({ type: 'Tab' }).map((e) => e.props.label)
  assert.deepEqual(tabs(), ['Schedules', 'Terminals'], 'no 0 while reading — it would read as none')
  assert.equal(early.find({ label: 'No schedules yet' }), null)
  await early.select({ type: 'Tabs' }, 'terminals')
  assert.ok(early.find({ type: 'Text', text: 'acme_notes' }), 'entering Terminals reads the list itself')
  assert.deepEqual(tabs(), ['Schedules', `Terminals ${open.length}`], 'the number comes with the answer')
  await early.unmount()
})

test('a new send opens its terminal’s sent group, which stays open when it ends; folded by hand it holds until the next', async () => {
  const view = await mount(panel, { host: host() })
  const ended = (id: string, name: string, ago: number): Schedule => ({
    ...blankSchedule(id),
    once: true,
    name,
    terminal: { ...open[0] },
    lastStatus: 'done',
    history: [{ at: Date.now() - ago, status: 'done' } as never]
  })
  await view.post('schedules.changed', { schedules: [ended('o1', 'old one', 60_000)] })
  assert.equal(view.find({ text: 'old one' }), null, 'nothing going on — folded')
  const fresh: Schedule = { ...blankSchedule('o2'), once: true, name: 'new one', terminal: { ...open[0] }, pendingSince: Date.now() }
  await view.post('schedules.changed', { schedules: [ended('o1', 'old one', 60_000), fresh] })
  assert.ok(view.find({ text: 'new one' }), 'the send just made is in sight')
  await view.post('schedules.changed', { schedules: [ended('o1', 'old one', 60_000), { ...fresh, pendingSince: null, lastStatus: 'done', history: [{ at: Date.now(), status: 'done' } as never] }] })
  assert.ok(view.find({ text: 'new one' }), 'it ended — still open to read the result')
  await view.toggle(view.findAll({ type: 'Collapsible' }).find((e) => String(e.props.title).startsWith('Sent 2'))!)
  assert.equal(view.find({ text: 'new one' }), null)
  await view.post('schedules.changed', { schedules: [ended('o1', 'old one', 60_000), { ...fresh, pendingSince: null, lastStatus: 'done', history: [{ at: Date.now(), status: 'done' } as never] }] })
  assert.equal(view.find({ text: 'new one' }), null, 'folded by hand, it stays folded')
  await view.unmount()
})

test('no agent terminal — the Terminals tab and the form say how to get one, with a reload', async () => {
  let none = true
  const view = await mount(panel, {
    host: mockHost({
      storage: { onboarded: true } as never,
      requests: { 'schedules.list': () => [], 'terminals.list': () => (none ? [] : open) }
    })
  })
  await view.select({ type: 'Tabs' }, 'terminals')
  const empty = view.find({ label: 'No agent terminals are open in Orca' })
  assert.equal(empty?.props.description, 'Run claude, codex or gemini in an Orca terminal and it shows up here.')
  none = false // claude started in a terminal meanwhile
  await view.press({ type: 'Button', text: 'Reload terminals' })
  assert.ok(view.find({ label: 'Claude Code — Show this terminal in Orca' }), 'the one just started shows up')
  none = true // the form reads the list again — empty this time
  await view.press({ type: 'IconButton', label: 'New schedule' })
  assert.ok(view.find({ label: 'No agent terminals are open in Orca' }), 'the picker says the same')
  await view.unmount()
})

test('entering the Terminals tab reads the list afresh; the Schedules tab does not', async () => {
  let reads = 0
  const view = await mount(panel, {
    host: mockHost({
      storage: { onboarded: true } as never,
      requests: { 'schedules.list': () => [], 'terminals.list': () => (reads++, open) }
    })
  })
  assert.equal(reads, 1, 'once on open')
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.equal(reads, 2)
  await view.select({ type: 'Tabs' }, 'schedules')
  assert.equal(reads, 2, 'nothing to read there')
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.equal(reads, 3)
  await view.unmount()
})

test('Settings and the form open under a line; Claude Code is not a star in the picker', async () => {
  const view = await mount(panel, { host: host() })
  assert.equal(view.find({ type: 'Separator' }), null, 'the list has the tabs under its title')
  await view.press({ type: 'IconButton', label: 'New schedule' })
  assert.ok(view.find({ type: 'Separator' }))
  const rootGap = () => (view.tree() as { props?: { gap?: string } } | null)?.props?.gap
  assert.equal(rootGap(), 'md', 'sections apart, as in Settings')
  // Days and time are fields of their own — each is a row of the form, so the same space lies between them.
  const rowOf = (e: { path: string } | null) => e?.path.split('/')[1]
  const days = rowOf(view.find({ type: 'Select', label: 'Days' }))
  const time = rowOf(view.find({ text: 'Weekdays 09:00' }))
  assert.ok(days && time, 'both are drawn')
  assert.notEqual(days, time)
  assert.deepEqual(
    view.findAll({ type: 'ListItem' }).map((e) => [e.label, e.props.icon]),
    [
      ['Morning', 'bot'],
      ['Review', 'terminal']
    ],
    'the ☆ beside a terminal means favorite'
  )
  await view.press({ type: 'IconButton', label: 'Close' })
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ type: 'Separator' }))
  assert.equal(rootGap(), 'md')
  await view.unmount()
})
