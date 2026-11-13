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

function host(calls: Partial<Calls> = {}, opts: { terminals?: TerminalOption[]; storage?: Record<string, unknown> } = {}) {
  return mockHost({
    storage: (opts.storage ?? {}) as never,
    requests: {
      'schedules.list': () => [],
      'terminals.list': () => opts.terminals ?? open,
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
  await view.press({ type: 'Button', text: 'New schedule' })
  await view.type({ label: 'Name' }, 'Code review')
  await view.select({ label: 'Terminal' }, 'h2')
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
  const select = view.find({ label: 'Terminal' })
  assert.deepEqual(
    (select?.props.options as { label: string }[]).map((o) => o.label),
    ['Claude Code · Morning · sonix_docs', 'Codex · Review · toy']
  )
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
  await view.press({ type: 'Button', text: 'New schedule' })
  assert.equal(view.find({ text: 'Create schedule' })?.props.disabled, true, 'no terminal yet')
  await view.select({ label: 'Terminal' }, 'h1')
  await view.type({ label: 'Time 1' }, '25:00', { replace: true })
  assert.ok(view.find({ text: /Check the time fields/ }))
  assert.equal(view.find({ text: 'Create schedule' })?.props.disabled, true)
  await view.press({ text: '‹ Back' })
  assert.ok(view.find({ label: 'No schedules yet' }), 'Back returns to the list')
  await view.unmount()
})

test('Korean on switch, and on reopen from storage', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'Language' }, 'ko')
  assert.ok(view.find({ label: '예약이 없습니다' }))
  assert.equal(view.host.data().storage.lang, 'ko', 'stored for the worker')
  await view.unmount()
  const again = await mount(panel, { host: host({}, { storage: { lang: 'ko' } }) })
  assert.ok(again.find({ text: '예약 없는 터미널 2' }))
  await again.press({ type: 'Button', text: '새 예약' })
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
  assert.ok(view.find({ text: 'Next today 23:59 · Morning report' }))
  await view.unmount()
})

test('one block per terminal — closed terminals keep theirs, open ones without schedules below', async () => {
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
  assert.ok(view.find({ text: /Screen changed in the last minute/ }), 'wait reason under the warning title')
  assert.ok(view.find({ text: /This terminal is not open/ }))
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Check').length, 2, 'warning title in English')
  assert.ok(view.find({ text: 'Done' }))
  assert.ok(view.find({ text: /took 3 min/ }))
  assert.equal(view.find({ type: 'Button', text: 'toy' })?.props.disabled, true, 'a closed terminal cannot be shown')
  assert.ok(view.find({ text: 'Terminals without schedules 5' }), 'h2 is open without schedules, plus four spares')
  assert.ok(view.find({ text: '1 more' }))
  assert.equal(view.find({ text: 'Spare 6' }), null, 'only the first four')
  await view.press({ text: '1 more' })
  assert.ok(view.find({ text: 'Spare 6' }))
  assert.deepEqual(view.errors, [])
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

test('pressing a terminal shows it in Orca', async () => {
  const focused: string[] = []
  const view = await mount(panel, { host: host({ focused }) })
  await view.press({ type: 'Button', text: 'toy' })
  await view.press({ label: 'Claude Code — Show this terminal in Orca' })
  assert.deepEqual(focused, ['h2', 'h1'])
  await view.unmount()
})

test('send once from a terminal line — no days or times, the name may stay empty', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const sendButtons = view.findAll({ label: 'Send once' })
  await view.press(sendButtons[1])
  assert.equal(view.find({ label: 'Terminal' })?.props.value, 'h2', 'that terminal picked')
  assert.equal(view.find({ label: 'Days' }), null)
  assert.equal(view.find({ text: 'Send' })?.props.disabled, true, 'no prompt yet')
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
  assert.ok(titled(view, 'Callout', 'Deleted “Release”'))
  await view.press({ text: 'Undo' })
  assert.equal(restored[0].id, 's1')
  assert.equal(titled(view, 'Callout', 'Deleted “Release”'), null)
  await view.unmount()
})

test('the worker pushes the terminal list — a closed terminal turns its block grey', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  await view.post('schedules.changed', { schedules: [s] })
  assert.equal(view.find({ type: 'Button', text: 'sonix_docs' })?.props.disabled, false)
  await view.post('terminals.changed', { terminals: [open[1]] })
  assert.equal(view.find({ type: 'Button', text: 'sonix_docs' })?.props.disabled, true)
  assert.ok(view.find({ text: /This terminal is not open/ }))
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
