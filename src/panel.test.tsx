// `orca plugin test .` runs this with the same runtime and checks as Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import { blankSchedule, type Schedule } from './engine'
import type { ScheduleDraft, TerminalOption } from './protocol'
import * as panel from './panel'

const open: TerminalOption[] = [
  { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'sonix_docs', tabId: 't1', leafId: 'l1' },
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
    storage: (opts.storage ?? {}) as never,
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
  await view.press({ text: '‹ Back' })
  assert.ok(titled(view, 'Callout', 'Discard what you wrote?'), 'something was typed, so Back asks')
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
  await view.press({ text: '‹ 뒤로' })
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
  assert.equal(view.findAll({ type: 'Text', text: 'sonix_docs' }).length, 5, 'h1 and the four spares')
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
  assert.ok(view.find({ text: 'Nothing matches “nothing here”' }))
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.ok(view.find({ text: 'Nothing matches “nothing here”' }), 'the same search on Terminals')
  await view.type({ label: 'Find' }, 'toy', { replace: true })
  assert.ok(view.find({ type: 'Text', text: 'toy' }))
  assert.equal(view.find({ type: 'Text', text: 'sonix_docs' }), null)
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
  await view.press({ type: 'Button', text: 'sonix_docs' })
  assert.equal(view.find({ label: 'Morning report' }), null, 'folded')
  await view.press({ type: 'Button', text: 'sonix_docs' })
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
  assert.ok(view.find({ type: 'Button', text: 'sonix_docs' }))
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
  await view.post('schedules.changed', { schedules: [s] })
  await view.press({ label: 'Collapse' })
  await view.select({ type: 'Tabs' }, 'terminals')
  await view.press(view.findAll({ label: 'New schedule for this terminal' })[0])
  await view.type({ label: 'Name' }, 'Nightly')
  await view.type({ label: 'Prompt' }, 'Wrap up')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].terminal.handle, 'h1')
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

test('send once — terminal, prompt, Send; the name and /clear wait under More options', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await view.press({ type: 'IconButton', label: 'Send once' })
  assert.equal(view.find({ label: 'Name' }), null, 'not in the way')
  assert.ok(view.find({ label: 'Prompt' }))
  const more = titled(view, 'Collapsible', 'More options')
  assert.ok(more)
  assert.equal(more?.props.defaultOpen, false)
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
  await view.press({ text: '‹ Back' })
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
  await view.press({ text: '‹ Back' })
  assert.equal(row(titled(view, 'Callout', 'Discard what you wrote?')), 1, 'asked right under Back')
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

