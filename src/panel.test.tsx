// `orca plugin test .` runs this with the same runtime and checks as Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import { blankSchedule, type Schedule } from './engine'
import type { ImportList, ScheduleDraft, TerminalOption } from './protocol'
import { recordText, statusText, whenText, words } from './i18n'
import * as panel from './panel'
import { drawnLength, linkParts, soft } from './text'
import { zoneText } from './timespec'

const open: TerminalOption[] = [
  { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'acme_notes', tabId: 't1', leafId: 'l1' },
  { handle: 'h2', title: 'Review', agent: 'codex', workspaceId: 'w2', workspace: 'toy', tabId: 't2', leafId: 'l2' }
]

/** What a person reads — without the places a long run of letters may break at. */
const plain = (text: string): string => text.replaceAll('\u200b', '')

type Calls = { saved: ScheduleDraft[]; focused: string[]; deleted: string[]; restored: Schedule[]; imported: string[][]; ran: string[]; tried: { command: string; workspaceId: string }[] }

type HostOpts = {
  terminals?: TerminalOption[]
  storage?: Record<string, unknown>
  /** What OrcaCron has to bring over; importing marks the asked ones as imported. */
  orcaCron?: ImportList
}

function host(calls: Partial<Calls> = {}, opts: HostOpts = {}) {
  const list = opts.terminals ?? open
  let app: ImportList = opts.orcaCron ?? { found: false, dir: '~/.orca-cron', items: [] }
  return mockHost({
    // Past the introduction unless a test says otherwise.
    storage: { onboarded: true, ...opts.storage } as never,
    requests: {
      'schedules.list': () => [],
      'terminals.list': () => list,
      'runner.status': () => ({ lastTickAt: null, log: [], cli: true }),
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
      'schedules.runNow': (input) => {
        calls.ran?.push((input as { id: string }).id)
        return blankSchedule((input as { id: string }).id) as never
      },
      'schedules.restore': (input) => {
        calls.restored?.push((input as { schedule: Schedule }).schedule)
        return (input as { schedule: Schedule }).schedule as never
      },
      'precheck.try': (input) => {
        calls.tried?.push(input as { command: string; workspaceId: string })
        const command = (input as { command: string }).command
        return {
          // The test kit's type() adds to what is in the field, so the last command typed decides.
          result: command.endsWith('ghh pr list')
            ? { code: 127, output: 'command not found: ghh' }
            : command.endsWith('exit 1')
              ? { code: 1, output: 'no open pull requests' }
              : { code: 0, output: '#12\n#15' },
          folder: '~/code/toy'
        } as never
      },
      'orcacron.list': () => app,
      'orcacron.import': (input) => {
        const ids = (input as { ids: string[] }).ids
        calls.imported?.push(ids)
        app = { ...app, items: app.items.map((i) => (ids.includes(i.id) ? { ...i, imported: true } : i)) }
        return { added: ids.length }
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

type View = Awaited<ReturnType<typeof mount>>
/** Opens every folded card — its rule, prompt, history, and Edit · Duplicate · Delete. */
async function unfold(view: View): Promise<void> {
  for (let more = view.find({ type: 'IconButton', label: 'More' }); more; more = view.find({ type: 'IconButton', label: 'More' })) await view.press(more)
}
/** Presses Edit, Duplicate or Delete on the nth card that shows it. */
const act = (view: View, text: 'Edit' | 'Duplicate' | 'Delete', nth = 0): Promise<void> => view.press(view.findAll({ type: 'Button', text })[nth])

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

test('above the list: badges for waiting, running and need attention — nothing while every schedule is at rest', async () => {
  const view = await mount(panel, { host: host() })
  type Node = { type?: string; children?: unknown[] }
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
  const badges = (): string[] => view.findAll({ type: 'Badge' }).map((e) => e.text)
  // What the Schedules tab draws under the search box: the badges if any, then one block per terminal.
  const under = (): string[] => (((view.tree() as Node).children?.[2] as Node).children ?? []).map((c) => (c as Node).type ?? '')
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))

  await view.post('schedules.changed', { schedules: [morning, off] })
  assert.deepEqual(under(), ['Stack', 'Stack'], 'at rest: the list starts right under the search box')
  assert.deepEqual(badges(), [], 'nothing out of the ordinary — no badges')
  // What runs next is on its card and in the status bar; on and off, on the switches.
  assert.equal(texts().some((x) => /Morning report|^Next /.test(x)), false, 'no line above the list repeats the next run — the name is on its switch')
  assert.equal(texts().some((x) => / on$| on · |runs? today|upcoming/i.test(x)), false, 'nor counts what the switches show')

  await view.post('schedules.changed', { schedules: [morning, stuck, off] })
  assert.deepEqual(under(), ['Row', 'Stack', 'Stack'], 'something is going on: its badges come first')
  assert.deepEqual(badges(), ['1 waiting', '1 need attention'])
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Check').length, 1, 'orange only for the one counted')

  await view.post('schedules.changed', { schedules: [{ ...morning, sentAt: Date.now() }, off] })
  assert.deepEqual(badges(), ['1 running'])
  await view.post('schedules.changed', { schedules: [morning, off] })
  assert.deepEqual(under(), ['Stack', 'Stack'], 'over: the badges go, and their line with them')
  await view.unmount()
})

test('a card starts with a round mark: what is going on now, else how the last run went; folded, the result is a word', async () => {
  const view = await mount(panel, { host: host() })
  type Last = NonNullable<Schedule['lastStatus']>
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const ran = (status: Last): Partial<Schedule> => ({ lastStatus: status, history: [{ at: Date.now() - 60_000, status, tookMs: 60_000 }] })
  const texts = (node: unknown): string[] => (typeof node === 'string' ? [node] : ((node as Node | null)?.children ?? []).flatMap(texts))
  const count = (node: unknown, type: string): number =>
    !node || typeof node !== 'object' ? 0 : ((node as Node).type === type ? 1 : 0) + ((node as Node).children ?? []).reduce((n: number, c) => n + count(c, type), 0)
  // The row a card starts with: the round mark, then the column beside it.
  const head = (node: unknown): [Node, Node] | null => {
    if (!node || typeof node !== 'object') return null
    const children = (node as Node).children ?? []
    const first = children[0] as Node | undefined
    if (first && typeof first === 'object' && first.props?.radius === 'full') return [first, children[1] as Node]
    for (const child of children) {
      const found = head(child)
      if (found) return found
    }
    return null
  }
  const draw = async (over: Partial<Schedule>): Promise<[Node, Node]> => {
    await view.post('schedules.changed', {
      schedules: [{ ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] }, nextRunAt: at(9, 0, 1), ...over }]
    })
    const found = head(view.tree())
    assert.ok(found, 'the card starts with its mark')
    return found
  }
  // The glyph, the colour, and whether the circle has a line: a neutral fill is the card's own colour.
  const mark = async (over: Partial<Schedule>): Promise<unknown[]> => {
    const [circle] = await draw(over)
    return [texts(circle).join(''), circle.props?.background, circle.props?.border === true]
  }
  assert.deepEqual(await mark({}), ['•', 'neutral', true], 'no run yet')
  assert.deepEqual(await mark(ran('success')), ['✓', 'success', false])
  assert.deepEqual(await mark(ran('done')), ['✓', 'success', false], 'ended without a result line — still a finished run')
  assert.deepEqual(await mark(ran('failed')), ['✕', 'danger', false])
  assert.deepEqual(await mark(ran('skipped')), ['–', 'neutral', true], 'the agent said there was nothing to do — an ordinary result, not a warning')
  assert.deepEqual(
    await mark({ lastStatus: 'skipped', history: [{ at: Date.now() - 60_000, status: 'skipped', note: { code: 'waitedOut', reason: 'busy' } }] }),
    ['–', 'warning', false],
    'given up after an hour of waiting — a run that never went out'
  )
  assert.deepEqual(await mark(ran('doneWaiting')), ['?', 'warning', false], 'stopped at a question')
  // What is going on now comes before the last result.
  assert.deepEqual(await mark({ ...ran('failed'), sentAt: Date.now() }), ['▸', 'accent', false], 'running')
  assert.deepEqual(await mark({ ...ran('success'), pendingSince: Date.now() - 60_000, waitNote: { code: 'typing' } }), ['!', 'warning', false], 'a person must act')
  assert.deepEqual(await mark({ ...ran('success'), pendingSince: Date.now() }), ['…', 'neutral', true], 'waiting its turn')
  assert.deepEqual(
    await mark({ ...ran('success'), terminal: { ...open[0], handle: 'h-gone', leafId: 'l-gone' } }),
    ['!', 'warning', false],
    'on, and its terminal is closed'
  )
  assert.deepEqual(await mark({ ...ran('failed'), enabled: false }), ['', 'neutral', true], 'off says only that: an empty circle')
  assert.deepEqual(
    await mark({ ...ran('failed'), enabled: false, terminal: { ...open[0], handle: 'h-gone', leafId: 'l-gone' } }),
    ['', 'neutral', true],
    'off with a closed terminal is still just off'
  )

  // One column beside the mark, so every line starts at the same edge: the name with its switch, the
  // next run with the two buttons, then the last run. Not run yet, a card ends after two lines.
  const failed = statusText('en', 'failed')
  const [, fresh] = await draw({})
  assert.equal(fresh.children?.length, 2, 'not run yet: no line kept empty for the buttons')
  assert.equal(count(fresh.children?.[0], 'Switch'), 1)
  assert.equal(count(fresh.children?.[1], 'IconButton'), 2, 'send now and open sit beside the next run')
  const [, withRun] = await draw(ran('failed'))
  assert.equal(withRun.children?.length, 3)
  assert.ok(texts(withRun.children?.[2]).includes(failed), 'the last run is the third line of the same column')
  const [, going] = await draw({ ...ran('failed'), sentAt: Date.now() })
  assert.equal(count(going.children?.[2], 'Spinner'), 1, 'a run that is going takes that line')
  // Why a run waits, and that its terminal is closed, are lines of that column too. What a person must
  // deal with is a block of its own under it, the card's whole width.
  const [, waiting] = await draw({ ...ran('success'), pendingSince: Date.now(), waitNote: { code: 'moving' } })
  assert.ok(texts(waiting).includes('Waiting to send'), 'that a run waits starts at the same edge as the name')
  assert.equal(count(waiting, 'Badge'), 0, 'as a word: a grey badge is the colour of the card in a dark theme')
  const [, closed] = await draw({ ...ran('success'), terminal: { ...open[0], handle: 'h-gone', leafId: 'l-gone' } })
  assert.ok(texts(closed).some((line) => /This terminal is closed/.test(line)))
  const [, urgent] = await draw({ ...ran('success'), pendingSince: Date.now() - 60_000, waitNote: { code: 'typing' } })
  assert.equal(count(urgent, 'Callout'), 0, 'the warning keeps the whole width')
  assert.ok(titled(view, 'Callout', 'Check'))

  // Folded: the mark has the colour, so the result is a word. Opened: the badge, with what the agent wrote.
  await draw(ran('failed'))
  assert.equal(view.find({ type: 'Badge', text: failed }), null, 'no badge beside the mark')
  assert.equal(view.find({ type: 'Text', text: failed })?.props.tone, 'danger')
  await unfold(view)
  assert.ok(view.find({ type: 'Badge', text: failed }), 'opened: the badge')
  assert.equal(view.find({ type: 'Text', text: failed }), null)

  // The filled surface keeps a line around it: a light theme gives that surface the panel's own colour.
  const lines: unknown[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const { props, children } = node as Node
    if (props?.background === 'card') lines.push(props.border)
    children?.forEach(walk)
  }
  walk(view.tree())
  assert.deepEqual(lines, [true], 'one card, with its line')
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
    history: [{ at: Date.now() - 86400_000, status: 'done', tookMs: 3 * 60_000, lateMs: 6 * 3600_000 + 2 * 60_000 }]
  }
  const gone: Schedule = { ...blankSchedule('s2'), name: 'Old', terminal: { ...open[1], handle: 'h-gone', leafId: 'l-gone' }, prompt: 'x' }
  await view.post('schedules.changed', { schedules: [running, gone] })
  assert.ok(view.find({ type: 'Text', text: 'Waiting to send' }))
  assert.equal(view.find({ text: 'Screen changed a moment ago (working or typing)' })?.props.muted, true, 'an ordinary wait stays grey')
  assert.ok(view.find({ text: /This terminal is closed/ }))
  assert.equal(titled(view, 'Callout', 'Check'), null, 'nothing here needs a person yet — the count on top says 0 too')
  assert.equal(view.find({ text: 'Done' }), null, 'folded: the run that waits takes the place of the one before it')
  assert.equal(view.find({ text: / · took 3 min$/ }), null)
  assert.equal(view.find({ text: /sent 6 h 2 min late/ }), null, 'which opens with the card, with how late it went out')
  await view.press(view.findAll({ type: 'IconButton', label: 'More' })[0])
  const record = view.find({ text: /sent 6 h 2 min late · took 3 min/ })
  assert.ok(record, 'caught up after its time — the record says how late')
  assert.equal(titled(view, 'Collapsible', 'History (1)'), null, 'one run is the line in sight — no History of one')
  assert.notEqual(record.props.truncate, true, 'and wraps rather than losing its end at 360px')
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

test('a block reads as one terminal — its title first, its workspace after; the chevron folds it, ↗ shows it in Orca', async () => {
  const focused: string[] = []
  const view = await mount(panel, { host: host({ focused }) })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] } }
  // A closed terminal that never had a title: its workspace stands in, once.
  const bare: Schedule = { ...blankSchedule('s2'), name: 'Sweep', terminal: { ...open[1], handle: 'gone', leafId: 'gone', title: '', workspace: 'solo' } }
  await view.post('schedules.changed', { schedules: [s, bare] })
  const texts = view.findAll({ type: 'Text' })
  const title = texts.findIndex((e) => e.text === 'Morning')
  const where = texts.findIndex((e) => e.text === 'acme_notes')
  assert.ok(title >= 0 && where > title, 'the title leads — with the workspace first a block read as a project')
  assert.equal(texts[title].props.weight, 'medium')
  assert.equal(texts[title].props.truncate, true, 'a long title ends in … — a Button ran over the buttons beside it')
  assert.equal(texts[where].props.muted, true)
  assert.equal(view.findAll({ type: 'Button' }).filter((e) => e.text === 'Morning' || e.text === 'acme_notes').length, 0)
  const solo = view.findAll({ type: 'Text', text: 'solo' })
  assert.deepEqual(solo.map((e) => e.props.weight), ['medium'], 'no title: the workspace in its place, not twice')
  await view.press(view.findAll({ label: 'Collapse' })[0])
  assert.equal(view.find({ label: 'Morning report' }), null, 'folded')
  await view.press({ label: 'Expand' })
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
  assert.equal(view.find({ type: 'Button', text: 'Duplicate' }), null, 'folded: what is done now and then stays out of the way')
  await unfold(view)
  await act(view, 'Duplicate')
  assert.equal(view.find({ label: 'Name' })?.props.value, 'Release copy')
  await view.press({ text: 'Create schedule' })
  assert.equal('id' in saved[0], false, 'saved as a new schedule')
  assert.equal(saved[0].prompt, 'Ship it')
  await act(view, 'Delete')
  assert.deepEqual(deleted, [], 'asked first')
  assert.ok(titled(view, 'Callout', 'Delete “Release”?'))
  assert.equal(view.findAll({ type: 'Button', text: 'Delete' }).length, 1, 'the question takes the buttons\' place — one Delete to press')
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(titled(view, 'Callout', 'Delete “Release”?'), null)
  await act(view, 'Delete')
  await act(view, 'Delete')
  assert.deepEqual(deleted, ['s1'])
  assert.equal(titled(view, 'Callout', 'Delete “Release”?'), null, 'the question goes with the press — it does not wait for the worker to answer')
  await view.post('schedules.changed', { schedules: [] })
  assert.equal(view.find({ label: 'No schedules yet' }), null, 'the block stays while Undo is offered')
  assert.ok(view.find({ text: 'Deleted “Release”' }), 'Undo where the schedule was, under its terminal')
  assert.ok(view.find({ type: 'Text', text: 'Morning' }), 'its terminal line still on top')
  await view.press({ text: 'Undo' })
  assert.equal(restored[0].id, 's1')
  assert.equal(view.find({ text: 'Deleted “Release”' }), null)
  await view.post('schedules.changed', { schedules: [s] })
  assert.equal(titled(view, 'Callout', 'Delete “Release”?'), null, 'back as it was — not asking again')
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
  assert.ok(view.find({ text: /This terminal is closed/ }))
  await view.unmount()
})

test('Send now is for a schedule at rest — off while one waits or runs, or its terminal is closed', async () => {
  const ran: string[] = []
  const view = await mount(panel, { host: host({ ran }) })
  const rest: Schedule = { ...blankSchedule('s1'), name: 'At rest', terminal: { ...open[0] }, nextRunAt: Date.now() + 3600_000 }
  const queued: Schedule = { ...rest, id: 's2', name: 'Queued', pendingSince: Date.now() }
  const going: Schedule = { ...rest, id: 's3', name: 'Going', sentAt: Date.now() - 5000, lastStatus: 'sent' }
  const closed: Schedule = { ...rest, id: 's4', name: 'Closed', terminal: { ...open[0], handle: 'h-gone', leafId: 'l-gone' } }
  await view.post('schedules.changed', { schedules: [rest, queued, going, closed] })
  const play = view.findAll({ type: 'IconButton', label: 'Send now' })
  assert.deepEqual(
    play.map((b) => [b.props.disabled, b.props.tooltip]),
    [
      [false, 'Sends as soon as the terminal is idle'],
      [true, 'Already waiting to send'],
      [true, 'Already running — send again when this run ends'],
      [true, 'This terminal is closed — nothing can be sent to it']
    ]
  )
  assert.ok(view.find({ type: 'Text', text: 'Waiting to send' }), 'a press shows at once, before the first check gives a reason')
  await view.press(play[0])
  assert.deepEqual(ran, ['s1'])
  await view.unmount()
})

test('a warning comes with what to do about it — pick another terminal, or go to this one', async () => {
  const focused: string[] = []
  const view = await mount(panel, { host: host({ focused }) })
  const base: Schedule = { ...blankSchedule('s1'), name: 'Asks', terminal: { ...open[0] }, nextRunAt: Date.now() + 3600_000 }
  const dialog: Schedule = { ...base, pendingSince: Date.now() - 60_000, waitNote: { code: 'dialog' } }
  const missing: Schedule = {
    ...base,
    id: 's2',
    name: 'Lost',
    terminal: { ...open[0], handle: 'h-gone', leafId: 'l-gone' },
    pendingSince: Date.now() - 60_000,
    waitNote: { code: 'missing' }
  }
  const closedOn: Schedule = { ...base, id: 's3', name: 'Closed, on', terminal: { ...open[1], handle: 'h-x', leafId: 'l-x' } }
  const closedOff: Schedule = { ...closedOn, id: 's4', name: 'Closed, off', enabled: false }
  // Its terminal went away after the last check found a dialog — the note is still the dialog's.
  const dialogGone: Schedule = { ...dialog, id: 's5', name: 'Asked, then closed', terminal: { ...open[0], handle: 'h-y', leafId: 'l-y' } }
  await view.post('schedules.changed', { schedules: [dialog, missing, closedOn, closedOff, dialogGone] })
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Check').length, 3, 'the three that are due and stuck')
  assert.equal(view.findAll({ type: 'Button', text: 'Show this terminal in Orca' }).length, 1, 'only where there is a terminal to show')
  await view.press({ type: 'Button', text: 'Show this terminal in Orca' })
  assert.deepEqual(focused, ['h1'], 'the dialog is answered in the terminal')
  const closedText = view.findAll({ text: 'This terminal is closed — nothing can be sent to it' }).filter((e) => e.type === 'Text')
  assert.deepEqual(
    closedText.map((e) => [e.props.tone, e.props.muted]),
    [
      ['warning', false],
      [undefined, true]
    ],
    'orange while the schedule is on — its next run has nowhere to go; grey when it is off'
  )
  const pick = view.findAll({ type: 'Button', text: 'Pick a terminal' })
  assert.equal(pick.length, 3, 'the one waiting for its terminal and the two closed ones')
  await view.press(pick[0])
  assert.equal(view.find({ label: 'Name' })?.props.value, 'Lost', 'Edit opens')
  assert.ok(view.find({ type: 'ListItem', label: 'Review' }), 'at the list of open terminals')
  await view.unmount()
})

test('deleting a schedule says what goes with it', async () => {
  const deleted: string[] = []
  const view = await mount(panel, { host: host({ deleted }) })
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: 'Release',
    terminal: { ...open[0] },
    history: [
      { at: Date.now() - 3600_000, status: 'done' },
      { at: Date.now() - 7200_000, status: 'done' }
    ]
  }
  const other: Schedule = { ...blankSchedule('s2'), name: 'Other', terminal: { ...open[0] } }
  await view.post('schedules.changed', { schedules: [s, other] })
  await unfold(view)
  await act(view, 'Delete', 0)
  assert.ok(view.find({ text: 'Its 2 past results go with it.' }))
  // Release now shows its question's Delete; Other's own is the second.
  await act(view, 'Delete', 1)
  assert.equal(titled(view, 'Callout', 'Delete “Release”?'), null, 'one question at a time')
  assert.ok(titled(view, 'Callout', 'Delete “Other”?'))
  assert.equal(view.find({ text: /past result/ }), null, 'nothing to lose, nothing said')
  assert.deepEqual(deleted, [])
  await act(view, 'Edit')
  await view.press({ type: 'IconButton', label: 'Close' })
  assert.equal(titled(view, 'Callout', 'Delete “Other”?'), null, 'the question does not wait behind the form')
  await act(view, 'Delete', 1)
  await view.press(view.findAll({ type: 'IconButton', label: 'Less' })[1])
  await unfold(view)
  assert.equal(titled(view, 'Callout', 'Delete “Other”?'), null, 'nor inside a card that was folded')
  await act(view, 'Delete', 0)
  await view.post('schedules.changed', { schedules: [other] })
  await view.post('schedules.changed', { schedules: [s, other] })
  assert.equal(titled(view, 'Callout', 'Delete “Release”?'), null, 'nor come back with a schedule that left the list and returned')
  await view.unmount()
})

test('editing a schedule on a closed terminal keeps that terminal first, marked not open', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const gone = { ...open[0], handle: 'h-gone', leafId: 'l-gone', title: 'Old docs' }
  const s: Schedule = { ...blankSchedule('s1'), name: 'Release', terminal: gone, prompt: 'Ship it' }
  await view.post('schedules.changed', { schedules: [s] })
  await unfold(view)
  await act(view, 'Edit')
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
  await unfold(view)
  await act(view, 'Edit')
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
  const moving = view.find({ text: 'Screen changed a moment ago (working or typing)' })
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

test('no favorites — terminals stand by workspace and title, and a list an earlier version stored is left alone', async () => {
  const view = await mount(panel, { host: host({}, { storage: { favorites: ['l2'] } }) })
  const s = (id: string, t: TerminalOption): Schedule => ({ ...blankSchedule(id), name: id, terminal: { ...t } })
  await view.post('schedules.changed', { schedules: [s('a', open[0]), s('b', open[1])] })
  const blocks = () => view.findAll({ label: /— Show this terminal in Orca$/ }).map((e) => e.label)
  const stars = () => view.findAll({ type: 'Button' }).filter((e) => e.text === '☆' || e.text === '★').length
  assert.deepEqual(blocks(), ['Claude Code — Show this terminal in Orca', 'Codex — Show this terminal in Orca'], 'the starred one is not first')
  assert.equal(stars(), 0)
  await view.select({ type: 'Tabs' }, 'terminals')
  assert.deepEqual(blocks(), ['Claude Code — Show this terminal in Orca', 'Codex — Show this terminal in Orca'])
  assert.equal(stars(), 0)
  assert.deepEqual(view.host.data().storage.favorites, ['l2'], 'not read, not written')
  await view.unmount()
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

test('the empty list is one line and a button; how sending works is in Settings, not under the list', async () => {
  const view = await mount(panel, { host: host() })
  const empty = view.find({ label: 'No schedules yet' })
  assert.equal(empty?.props.description, 'Press + on a terminal in the Terminals tab to start.')
  const rule = /^Checks every 30 seconds/
  assert.equal(view.find({ text: rule }), null, 'the rule is not spelled out up front')
  assert.equal(view.find({ text: 'How sending works' }), null, 'and the list has no button for it')
  await view.press({ label: 'Settings' })
  assert.ok(titled(view, 'Callout', 'How sending works'))
  assert.ok(view.find({ text: rule }))
  assert.deepEqual(
    view.findAll({ type: 'Link' }).map((e) => [e.props.href, e.text]),
    [['https://github.com/gook-lab/orca-agent-scheduler/releases', "What's new"]],
    'and leads to what each version changed'
  )
  await view.press({ text: 'Show the introduction again' })
  assert.ok(view.find({ label: 'Prompts on a schedule' }))
  await view.press({ text: 'Skip' })
  assert.ok(view.find({ label: 'No schedules yet' }), 'opened again, it returns to where it was')
  await view.press({ text: 'Open Terminals' })
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'terminals')
  await view.unmount()
})

test('time left on a card — to the minute, so a card does not tick by the second', () => {
  const en = words('en').ui.inAbout
  const ko = words('ko').ui.inAbout
  assert.deepEqual([en(59_000), en(728_000), en(3_725_000), en(90_000_000)], ['now', 'in 12m', 'in 1h 02m', 'in 1d 1h'])
  assert.deepEqual([ko(59_000), ko(728_000), ko(3_725_000), ko(90_000_000)], ['곧', '12분 뒤', '1시간 02분 뒤', '1일 1시간 뒤'])
})

test('the time left on a card moves while the panel is in view, and rests while hidden', async () => {
  const view = await mount(panel, { host: host() })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  // 60.3 s away is "in 1m"; one tick of the clock later it is under a minute — "now".
  const soon = (): Schedule => ({ ...blankSchedule('a'), name: 'Morning report', terminal: { ...open[0] }, enabled: true, nextRunAt: Date.now() + 60_300 })
  const left = (): string | null =>
    view.findAll({ type: 'Text' }).map((e) => plain(e.text)).find((x) => x.startsWith('next '))?.split(' · ').pop() ?? null
  await wait(1100)
  await view.settled()
  await view.post('schedules.changed', { schedules: [soon()] })
  assert.equal(left(), 'in 1m')
  await wait(1600)
  await view.settled()
  assert.equal(left(), 'now', 'a second later the minute turned')
  await view.setVisible(false)
  await view.post('schedules.changed', { schedules: [soon()] })
  assert.equal(left(), 'in 1m')
  await wait(1600)
  await view.settled()
  assert.equal(left(), 'in 1m', 'not redrawn while nobody sees it')
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

test('without the Orca CLI the Terminals tab and the form say so, instead of asking for an agent', async () => {
  const view = await mount(panel, {
    host: mockHost({
      storage: { onboarded: true } as never,
      requests: { 'schedules.list': () => [], 'terminals.list': () => [], 'runner.status': () => ({ lastTickAt: null, log: [], cli: false }) }
    })
  })
  await view.select({ type: 'Tabs' }, 'terminals')
  const missing = view.find({ label: 'Orca CLI not found' })
  assert.ok(String(missing?.props.description).includes('macOS only'))
  assert.equal(view.find({ label: 'No agent terminals are open in Orca' }), null, 'running claude would not help')
  assert.equal(view.find({ type: 'Button', text: 'Reload terminals' }), null, 'neither would reading the list again')
  await view.press({ type: 'IconButton', label: 'New schedule' })
  assert.ok(view.find({ label: 'Orca CLI not found' }), 'the picker says the same')
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
    'each agent has its own icon in the picker'
  )
  await view.press({ type: 'IconButton', label: 'Close' })
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ type: 'Separator' }))
  assert.equal(rootGap(), 'md')
  await view.unmount()
})

test('a new schedule asks for a one-line result unless switched off; a one-off only when switched on', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await fillBasics(view)
  const option = view.find({ type: 'Checkbox', label: 'Ask for a one-line result' })
  assert.equal(option?.props.checked, true)
  assert.match(String(option?.props.description), /how it went \(ok, failed or skipped\), a summary, and a link if there is one/, 'and says what it asks for')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].report, true)

  await fillBasics(view)
  await view.toggle({ label: 'Ask for a one-line result' })
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[1].report, false)

  await view.press({ type: 'IconButton', label: 'Send once' })
  assert.equal(view.find({ label: 'Ask for a one-line result' }), null, 'under More options')
  await view.press({ type: 'ListItem', label: 'Review' })
  await view.type({ label: 'Prompt' }, 'Summarise the open PRs')
  await view.press({ text: 'Send' })
  assert.equal(saved[2].report, false)

  await view.press({ type: 'IconButton', label: 'Send once' })
  await view.toggle(titled(view, 'Collapsible', 'More options')!)
  await view.toggle({ label: 'Ask for a one-line result' })
  await view.press({ type: 'ListItem', label: 'Review' })
  await view.type({ label: 'Prompt' }, 'Summarise the open PRs')
  await view.press({ text: 'Send' })
  assert.equal(saved[3].report, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a record shows what the agent wrote — the summary, and the link by its address; editing keeps the option as saved', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  const link = 'https://github.com/acme/notes/pull/128'
  const asked: Schedule = {
    ...blankSchedule('s1'),
    name: 'Morning report',
    terminal: { ...open[0] },
    prompt: 'Plan the day',
    report: true,
    nextRunAt: Date.now() + 3600_000,
    lastStatus: 'success',
    history: [
      { at: Date.now() - 3600_000, status: 'success', tookMs: 4 * 60_000, summary: '3 PRs need review, 1 has a failing check', link },
      { at: Date.now() - 86400_000, status: 'failed', tookMs: 60_000, summary: 'The build broke' }
    ]
  }
  const silent: Schedule = { ...blankSchedule('s2'), name: 'Old one', terminal: { ...open[0] }, prompt: 'x', nextRunAt: Date.now() + 7200_000 }
  await view.post('schedules.changed', { schedules: [asked, silent] })
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))
  assert.ok(texts().includes(`${whenText('en', asked.history[0].at)} · took 4 min`), 'folded: how the last run went, when, how long')
  assert.equal(view.find({ type: 'Text', text: '3 PRs need review, 1 has a failing check' }), null, 'what the agent wrote opens with the card')
  assert.equal(view.findAll({ type: 'Link' }).length, 0, 'and so does its link')
  assert.equal(titled(view, 'Collapsible', 'History (2)'), null, 'history waits in the opened card')
  assert.equal(view.find({ text: 'Plan the day' }), null, 'and so does the prompt')
  await unfold(view)
  const summary = view.find({ type: 'Text', text: '3 PRs need review, 1 has a failing check' })
  assert.ok(summary)
  assert.notEqual(summary.props.truncate, true, 'the whole sentence, wrapped')
  const shown = view.findAll({ type: 'Link' })
  assert.deepEqual(
    shown.map((e) => [e.props.href, e.text]),
    [[link, 'github.com']],
    'the link is the site it leads to; a record without one has none'
  )
  // When, how long and the link share the line under it. The test kit reads a line's parts with a space
  // between them; on screen the path follows the site directly.
  assert.ok(texts().includes(`${whenText('en', asked.history[0].at)} · took 4 min · github.com /acme/notes/pull/128`), 'what the agent wrote first, then when, how long and where')
  assert.ok(texts().indexOf('3 PRs need review, 1 has a failing check') < texts().findIndex((x) => x.includes('took 4 min')))
  assert.ok(view.find({ type: 'Text', text: 'Plan the day' }), 'opened: what this schedule sends')
  await view.toggle(titled(view, 'Collapsible', 'History (2)')!)
  assert.ok(view.find({ type: 'Text', text: 'The build broke' }), 'older results under History')

  await act(view, 'Edit', 0)
  assert.equal(view.find({ label: 'Ask for a one-line result' })?.props.checked, true)
  await view.press({ text: 'Cancel' })
  await act(view, 'Edit', 1)
  assert.equal(view.find({ label: 'Ask for a one-line result' })?.props.checked, false, 'a schedule from before the option stays as it was')
  await view.press({ text: 'Save' })
  assert.equal(saved[0].report, false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

const appList: ImportList = {
  found: true,
  dir: '~/.orca-cron',
  items: [
    { id: 'ledger', name: 'Ledger update', cron: '0 9 * * 1-5', terminal: { ...open[0] }, open: true, imported: false, badCron: false },
    { id: 'night', name: 'Night tidy', cron: '0 3 * * *', terminal: { ...open[1], handle: 'gone', title: 'Closed one' }, open: false, imported: false, badCron: false },
    { id: 'odd', name: 'Odd times', cron: 'whenever', terminal: { ...open[0] }, open: true, imported: false, badCron: true }
  ]
}

test("Settings offers OrcaCron's schedules when the app's data is there — they come over switched off", async () => {
  const imported: string[][] = []
  const view = await mount(panel, { host: host({ imported }, { orcaCron: appList }) })
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ text: 'Import from OrcaCron' }))
  assert.ok(view.find({ text: /~\/\.orca-cron.*switched off.*goes out twice/ }), 'says where from, and why they arrive off')
  assert.ok(view.find({ text: 'Weekdays 09:00 · Morning' }))
  assert.ok(view.find({ text: 'Every day 03:00 · Closed one · not open' }))
  assert.ok(view.find({ text: 'whenever · Morning' }))
  assert.ok(view.find({ type: 'Badge', text: 'cannot import — times not understood' }))
  await view.press({ text: 'Import 2 schedules' })
  assert.deepEqual(imported, [['ledger', 'night']], 'the one whose times cannot be read is not asked for')
  assert.match(String(titled(view, 'Callout', 'Imported 2 schedules, switched off')?.text), /Turn each one off in OrcaCron, then switch it on in the Schedules tab\.$/)
  assert.equal(view.findAll({ type: 'Badge', text: 'imported' }).length, 2)
  assert.equal(view.find({ type: 'Button', text: /^Import / }), null, 'nothing left to import')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Settings says nothing about OrcaCron on a computer without it; all imported reads as done', async () => {
  const none = await mount(panel, { host: host() })
  await none.press({ label: 'Settings' })
  assert.equal(none.find({ text: 'Import from OrcaCron' }), null)
  await none.unmount()

  const done: ImportList = { ...appList, items: appList.items.slice(0, 2).map((i) => ({ ...i, imported: true })) }
  const view = await mount(panel, { host: host({}, { orcaCron: done }) })
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ text: 'Everything is already imported.' }))
  assert.equal(view.find({ type: 'Button', text: /^Import / }), null)
  await view.unmount()

  const ko = await mount(panel, { host: host({}, { orcaCron: appList, storage: { langPref: 'ko' } }) })
  await ko.press({ label: '설정' })
  assert.ok(ko.find({ text: 'OrcaCron 에서 가져오기' }))
  assert.ok(ko.find({ text: '예약 2개 가져오기' }))
  await ko.unmount()
})

test('a one-off send shows its result like a schedule does — how long, why it failed, the summary, the link', async () => {
  const view = await mount(panel, { host: host() })
  const once = (id: string, name: string, over: Partial<Schedule>): Schedule => ({ ...blankSchedule(id), once: true, name, terminal: { ...open[0] }, cron: '', ...over })
  const done = once('o1', 'Summarise the open PRs', {
    report: true,
    lastStatus: 'success',
    history: [{ at: at(12, 3), status: 'success', tookMs: 4 * 60_000, summary: '2 PRs wait for review', link: 'https://github.com/acme/notes/pulls' }]
  })
  const failed = once('o2', 'Deploy notes', { lastStatus: 'failed', history: [{ at: at(11, 0), status: 'failed', note: { code: 'sendFailed', detail: 'terminal_handle_stale' } }] })
  const asking = once('o3', 'Pick a name', { lastStatus: 'doneWaiting', history: [{ at: at(10, 0), status: 'doneWaiting', tookMs: 60_000 }] })
  const nothing = once('o4', 'Sweep the notes', { lastStatus: 'skipped', history: [{ at: at(9, 30), status: 'skipped', tookMs: 20_000, summary: 'Nothing to sweep' }] })
  const givenUp = once('o5', 'Late note', { lastStatus: 'skipped', history: [{ at: at(9, 0), status: 'skipped', note: { code: 'waitedOut', reason: 'busy' } }] })
  await view.post('schedules.changed', { schedules: [done, failed, asking, nothing, givenUp] })
  await view.toggle(titled(view, 'Collapsible', 'Sent 5 · last today 12:03')!)
  assert.deepEqual(
    view.findAll({ type: 'Badge', text: 'Skipped' }).map((e) => e.props.tone),
    ['neutral', 'warning'],
    'an agent with nothing to do — a plain badge; a send given up after an hour — orange'
  )
  assert.ok(view.findAll({ type: 'Text' }).some((e) => plain(e.text) === 'today 09:30 · took 20 s'), 'a short run in seconds')
  assert.ok(view.findAll({ type: 'Text' }).some((e) => plain(e.text) === 'today 12:03 · took 4 min · github.com /acme/notes/pulls'))
  assert.ok(view.find({ type: 'Text', text: '2 PRs wait for review' }))
  assert.deepEqual(
    view.findAll({ type: 'Link' }).map((e) => [e.props.href, e.text]),
    [['https://github.com/acme/notes/pulls', 'github.com']]
  )
  assert.ok(view.findAll({ type: 'Text' }).some((e) => plain(e.text) === 'today 11:00 · Send failed: terminal_handle_stale'), 'why a send failed stays with it')
  assert.equal(view.find({ type: 'Badge', text: 'Done (awaiting input)' })?.props.tone, 'warning', 'stopped at a question — a person is needed, so not green')
  assert.equal(view.find({ type: 'Badge', text: 'Succeeded' })?.props.tone, 'success')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a search opens a folded block and its sent group to show what it found; the fold is back when the search is cleared', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = { ...blankSchedule('s1'), name: 'Morning report', terminal: { ...open[0] }, nextRunAt: at(9, 0, 1) }
  const sent: Schedule = { ...blankSchedule('o1'), once: true, name: 'Summarise the open PRs', terminal: { ...open[0] }, cron: '', lastStatus: 'done', history: [{ at: at(12, 3), status: 'done' }] }
  await view.post('schedules.changed', { schedules: [s, sent] })
  await view.press({ label: 'Collapse' })
  assert.equal(view.find({ label: 'Morning report' }), null)
  await view.type({ label: 'Find' }, 'morning')
  assert.ok(view.find({ label: 'Morning report' }), 'found inside the folded block')
  await view.type({ label: 'Find' }, 'summarise', { replace: true })
  assert.ok(view.find({ type: 'Text', text: 'Summarise the open PRs' }), 'and inside its folded sent group')
  await view.type({ label: 'Find' }, ' ', { replace: true })
  assert.equal(view.find({ label: 'Morning report' }), null, 'folded as it was')
  assert.ok(view.find({ text: '1 schedule · next tomorrow 09:00' }))
  await view.unmount()
})

test('History shows every record it counts; a long site name is shown whole in a link', async () => {
  const view = await mount(panel, { host: host() })
  const site = `docs.${'a'.repeat(60)}.example`
  const history = Array.from({ length: 12 }, (_, i) => ({ at: Date.now() - (i + 1) * 3600_000, status: 'success' as const, summary: `run ${i + 1}`, ...(i === 0 ? { link: `https://${site}/${'p'.repeat(80)}` } : {}) }))
  const s: Schedule = { ...blankSchedule('s1'), name: 'Hourly', terminal: { ...open[0] }, lastStatus: 'success', history }
  await view.post('schedules.changed', { schedules: [s] })
  await unfold(view)
  await view.toggle(titled(view, 'Collapsible', 'History (12)')!)
  assert.equal(view.findAll({ type: 'Text', text: /^run \d+$/ }).length, 13, 'the newest above, then all twelve')
  assert.equal(plain(view.findAll({ type: 'Link' })[0].text), site, 'the site is never the part cut off')
  const line = view.findAll({ type: 'Text' }).map((e) => plain(e.text)).find((text) => text.includes(site))
  const address = line?.slice(line.indexOf(site))
  assert.ok(address?.startsWith(`${site} /ppp`) && address.endsWith('…') && address.length === site.length + 1 + 40, 'the path is')
  await view.unmount()
})

test('the form says which clock the times are on, and that a command gets no result ask', async () => {
  const view = await mount(panel, { host: host() })
  await fillBasics(view)
  assert.ok(view.find({ type: 'Text', text: `Times are this computer's local time (${zoneText()}).` }))
  assert.match(String(view.find({ label: 'Ask for a one-line result' })?.props.description), /^Adds a sentence/)
  await view.type({ label: 'Prompt' }, '  /compact', { replace: true })
  assert.match(String(view.find({ label: 'Ask for a one-line result' })?.props.description), /^Not added to a prompt that starts with \//)
  await view.press({ text: 'Cancel' })
  await view.press({ text: 'Discard' })
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Language' }, 'ko')
  await view.press({ label: '닫기' })
  await view.press({ type: 'IconButton', label: '새 예약' })
  assert.ok(view.find({ type: 'Text', text: `시각은 이 컴퓨터의 현지 시각입니다(${zoneText()}).` }))
  await view.unmount()
})

test('OrcaCron — when what is left cannot be imported, it does not say everything was', async () => {
  const stuck: ImportList = { ...appList, items: [{ ...appList.items[0], imported: true }, appList.items[2]] }
  const view = await mount(panel, { host: host({}, { orcaCron: stuck }) })
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ type: 'Badge', text: 'cannot import — times not understood' }))
  assert.equal(view.find({ text: 'Everything is already imported.' }), null)
  assert.equal(view.find({ type: 'Button', text: /^Import / }), null)
  assert.ok(view.find({ text: /limit on late runs does not come over/ }), 'what the copy leaves behind is said before importing')
  await view.unmount()
})

test('nothing a person or an agent wrote can push a card wider than the panel — long runs of letters get places to break', async () => {
  const longest = (text: string): number => Math.max(...text.split(/[\s\u200b]/).map((piece) => piece.length))
  // The site is the link, whole and on one line when it fits; the path breaks after its separators, and
  // inside an id that has none.
  const address = linkParts('https://claude.ai/artifact/a1B2c3D4e5F6g7H8i9J0k1L2m3N4')
  assert.equal(address.site, 'claude.ai')
  assert.equal(plain(address.path), '/artifact/a1B2c3D4e5F6g7H8i9J0k1L2m3N4', 'the same letters')
  assert.ok(address.path.startsWith('/\u200bartifact/\u200b'), 'a break after each separator')
  assert.ok(longest(address.path) <= 16)
  assert.ok(longest(linkParts(`https://docs.${'a'.repeat(60)}.example/`).site) <= 16, 'a site too long for any panel breaks too')
  assert.equal(soft('3 PRs need review'), '3 PRs need review', 'words with spaces are left as written')
  assert.ok(longest(soft(`see ${'x'.repeat(70)}`)) <= 16)

  // The card — name, record note, summary, link — draws them all that way.
  const run = 'A'.repeat(48)
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: `Nightly-${run}`,
    terminal: { ...open[0] },
    prompt: `Read ${run} and report`,
    lastStatus: 'failed',
    history: [{ at: Date.now() - 60_000, status: 'failed', note: { code: 'sendFailed', detail: `no_such_${run}` }, summary: `path/${run}`, link: `https://example.com/${run}` }]
  }
  const view = await mount(panel, { host: host() })
  await view.post('schedules.changed', { schedules: [s] })
  await unfold(view)
  const drawn = [...view.findAll({ type: 'Text' }), ...view.findAll({ type: 'Link' })].map((e) => e.text).filter((text) => plain(text).includes('AAAA'))
  assert.equal(drawn.length, 3, 'the summary, the line with the note and the link, and the prompt')
  for (const text of drawn) assert.ok(longest(text) <= 16, text)
  const name = view.find({ type: 'Switch' })?.props.label as string
  assert.equal(plain(name), `Nightly-${run}`)
  assert.ok(longest(name) <= 16)
  await view.unmount()
})

test('a folded card is for a glance — name, next run, how the last one went; the rest opens in place', async () => {
  const view = await mount(panel, { host: host() })
  const next = Date.now() + (2 * 60 + 33) * 60_000 + 30_000
  const long = `Collect the numbers ${'and check them again '.repeat(12)}`
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: 'Board check',
    terminal: { ...open[0] },
    cron: '13 12,19 * * *',
    prompt: long,
    clearFirst: true,
    nextRunAt: next,
    lastStatus: 'done',
    history: [
      { at: at(15, 44), status: 'done', tookMs: 17 * 60_000, note: { code: 'byScreen', reason: 'noLine' } },
      { at: at(12, 13), status: 'skipped', tookMs: 4 * 60_000, note: { code: 'byScreen' }, summary: 'Nothing changed' }
    ]
  }
  await view.post('schedules.changed', { schedules: [s] })
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))
  const card = (): string[] => view.findAll({ type: 'IconButton' }).map((e) => e.label ?? '').filter((label) => ['Send now', 'More', 'Less', 'Edit', 'Duplicate', 'Delete'].includes(label))
  assert.deepEqual(card(), ['Send now', 'More'], 'two buttons, not four')
  const line = texts().find((x) => x.startsWith('next '))
  assert.ok(line?.startsWith(`next ${whenText('en', next)} · in 2h 3`) && /in 2h 3[23]m$/.test(line), `when, and how long until then — ${line}`)
  assert.ok(texts().includes('today 15:44 · took 17 min'), 'how the last run went: the badge, when, how long')
  assert.equal(texts().some((x) => /by screen|result line/i.test(x)), false, 'how the end was seen opens with the card')
  assert.equal(texts().some((x) => x.includes('12:13') || x.includes('/clear') || x.includes('Collect')), false, 'the rule and the prompt wait')

  await view.press({ type: 'IconButton', label: 'More' })
  assert.deepEqual(card(), ['Send now', 'Less'])
  assert.ok(texts().some((x) => x.includes('12:13') && x.endsWith('· /clear')), 'the rule, and that it clears first')
  const shown = texts().find((x) => x.startsWith('Collect the numbers'))
  assert.ok(shown && shown.length === 160 && shown.endsWith('…'), 'the start of the prompt, not all of it')
  assert.deepEqual(
    view.findAll({ type: 'Button' }).map((e) => e.text).filter((x) => ['Edit', 'Duplicate', 'Delete'].includes(x)),
    ['Edit', 'Duplicate', 'Delete']
  )
  assert.ok(texts().includes('today 15:44 · took 17 min · by screen: no result line on screen'), 'opened, the last run says how its end was seen')
  assert.equal(texts().includes('today 15:44 · took 17 min'), false, 'in place of the short line, not under it')
  assert.equal(texts().includes('Nothing changed'), false, 'older runs wait under History')
  await view.toggle(titled(view, 'Collapsible', 'History (2)')!)
  assert.ok(texts().includes('today 12:13 · took 4 min · by screen'))
  assert.ok(texts().includes('Nothing changed'))

  await view.press({ type: 'IconButton', label: 'Less' })
  assert.deepEqual(card(), ['Send now', 'More'])
  assert.equal(view.find({ type: 'Button', text: 'Edit' }), null)
  assert.ok(texts().includes('today 15:44 · took 17 min'), 'folded again, the short line is back')
  await view.unmount()
})

test('a folded card says why the last run did not go well — one line of what the agent wrote, cut where it runs out', async () => {
  const view = await mount(panel, { host: host() })
  type Last = NonNullable<Schedule['lastStatus']>
  const ran = (id: string, status: Last, summary?: string): Schedule => ({
    ...blankSchedule(id),
    name: `Check ${id}`,
    terminal: { ...open[0] },
    prompt: 'x',
    nextRunAt: Date.now() + 3600_000,
    lastStatus: status,
    history: [{ at: Date.now() - 3600_000, status, tookMs: 60_000, ...(summary ? { summary } : {}) }]
  })
  const wrong: Last[] = ['failed', 'noResult', 'aborted', 'doneWaiting']
  const fine: Last[] = ['success', 'done', 'skipped']
  const long = `Could not publish the board: ${'the script stopped at the sign-in step, '.repeat(6)}and asked for a new token`
  const all = (said: boolean): Schedule[] => [
    ...wrong.map((status) => ran(status, status, said ? `why ${status}` : undefined)),
    ...fine.map((status) => ran(status, status, said ? `said ${status}` : undefined)),
    ran('long', 'failed', said ? long : undefined),
    ran('silent', 'failed')
  ]
  const shown = (text: string) => view.findAll({ type: 'Text' }).filter((e) => plain(e.text) === text)
  const cut = (): number => view.findAll({ type: 'Text' }).filter((e) => e.props.truncate === true).length

  await view.post('schedules.changed', { schedules: all(false) })
  const without = cut()
  await view.post('schedules.changed', { schedules: all(true) })
  for (const status of wrong) {
    const [line, ...more] = shown(`why ${status}`)
    assert.ok(line && more.length === 0, `${status}: what the agent wrote, on the folded card`)
    assert.equal(line.props.truncate, true, `${status}: one line, so the card's height does not follow the text`)
  }
  for (const status of fine) assert.equal(shown(`said ${status}`).length, 0, `${status}: nothing to act on — it opens with the card`)
  assert.equal(shown(long)[0]?.props.truncate, true, 'a long one is handed over whole and cut at the edge of the card')
  assert.equal(cut(), without + wrong.length + 1, 'no line for a failed run the agent wrote nothing about, nor for the ones that went well')

  await unfold(view)
  for (const status of wrong) {
    const lines = shown(`why ${status}`)
    assert.equal(lines.length, 1, `${status}: opened, it is said once`)
    assert.notEqual(lines[0].props.truncate, true, `${status}: and whole`)
  }
  assert.equal(shown('said success').length, 1, 'opened: what the agent wrote, as before')
  assert.equal(cut(), without, 'nothing is cut in an opened card')
  await view.unmount()
})

test('a folded card says why a run never went out, or how it was lost — what the plugin knows, when the agent wrote nothing', async () => {
  const view = await mount(panel, { host: host() })
  type Record = Schedule['history'][number]
  const card = (id: string, r: Omit<Record, 'at'>): Schedule => ({
    ...blankSchedule(id),
    name: `Check ${id}`,
    terminal: { ...open[0] },
    prompt: 'x',
    nextRunAt: Date.now() + 3600_000,
    lastStatus: r.status,
    history: [{ at: Date.now() - 3600_000, ...r }]
  })
  const shown = (text: string) => view.findAll({ type: 'Text' }).filter((e) => plain(e.text) === text)
  // The word after the mark, by card: its colour says whether a person may want to look.
  const word = (text: string) => view.findAll({ type: 'Text', text }).map((e) => e.props.tone)
  await view.post('schedules.changed', {
    schedules: [
      card('missed', { status: 'skipped', note: { code: 'waitedOut', reason: 'busy' } }),
      card('nothing', { status: 'skipped', tookMs: 28_000, summary: 'Nothing changed since the last run' }),
      card('unsent', { status: 'failed', note: { code: 'sendFailed', detail: 'terminal_handle_stale' } }),
      card('closed', { status: 'aborted', tookMs: 60_000, note: { code: 'closed' } }),
      card('said', { status: 'failed', tookMs: 60_000, note: { code: 'byScreen' }, summary: 'The build broke' }),
      card('seen', { status: 'failed', tookMs: 60_000, note: { code: 'byScreen' } })
    ]
  })
  assert.deepEqual(word('Skipped'), ['warning', 'neutral'], 'given up after an hour — orange; an agent with nothing to do — a plain word')
  const [missed] = shown('Waited 60 min: agent is working')
  assert.equal(missed?.props.truncate, true, 'the run that never went out says so, on one line')
  assert.equal(shown('Nothing changed since the last run').length, 0, 'an ordinary skip keeps its summary for the opened card')
  assert.equal(shown('Send failed: terminal_handle_stale').length, 1)
  assert.equal(shown('Terminal closed — result unknown').length, 1)
  assert.equal(shown('The build broke').length, 1, 'what the agent wrote comes first')
  assert.equal(shown('by screen').length, 0, 'how an end was seen is not a reason')

  await unfold(view)
  assert.equal(shown('Waited 60 min: agent is working').length, 0, 'opened, the reason is in the record line — once')
  assert.ok(view.findAll({ type: 'Text' }).some((e) => /· Waited 60 min: agent is working$/.test(plain(e.text))))
  assert.deepEqual(
    view.findAll({ type: 'Badge', text: 'Skipped' }).map((e) => e.props.tone),
    ['warning', 'neutral']
  )
  // A grey badge is the card's own colour in a dark theme — the line around it is what shows it.
  const lined = view.findAll({ type: 'Box' }).filter((e) => e.props.border === true && e.props.radius === 'full' && e.text === 'Skipped')
  assert.equal(lined.length, 1, 'the plain one gets a line; the orange one is a pill by itself')
  await view.unmount()
})

test('a run of under a minute says its seconds — 17 seconds read `took 0 min`', () => {
  const took = (ms: number) => [recordText('en', { tookMs: ms }), recordText('ko', { tookMs: ms })]
  assert.deepEqual(took(17_000), ['took 17 s', '걸린 시간 17초'])
  assert.deepEqual(took(59_999), ['took 59 s', '걸린 시간 59초'])
  assert.deepEqual(took(400), ['took 1 s', '걸린 시간 1초'], 'never zero')
  assert.deepEqual(took(60_000), ['took 1 min', '걸린 시간 1분'], 'from a minute on, minutes as before')
  assert.deepEqual(took(4 * 60_000 + 40_000), ['took 5 min', '걸린 시간 5분'])
  assert.equal(recordText('en', { lateMs: 62 * 60_000, tookMs: 20_000 }), 'sent 1 h 2 min late · took 20 s')
})

test('on a terminal line the shorter of title and workspace keeps its width — the other takes what is left', async () => {
  const view = await mount(panel, { host: host() })
  const on = (id: string, title: string, workspace: string): Schedule => ({
    ...blankSchedule(id),
    name: `Check ${id}`,
    // Closed terminals: a line is drawn from what the schedule remembers.
    terminal: { ...open[0], handle: `gone-${id}`, leafId: `gone-${id}`, title, workspace }
  })
  await view.post('schedules.changed', {
    schedules: [
      on('long', 'Review the open pull requests before lunch', 'toy'),
      on('short', 'Notes', 'storefront-web-client'),
      // Six Hangul letters are drawn about as wide as twelve Latin ones.
      on('wide', '아침 정리 보고', 'notes')
    ]
  })
  // The box around a word: whether it gives way when room runs out, whether it takes spare room, its cap.
  const box = (text: string) => {
    const found = view.findAll({ type: 'Box' }).filter((e) => e.text === text)
    assert.equal(found.length, 1, text)
    return [found[0].props.shrink, found[0].props.grow === true, found[0].props.maxWidth]
  }
  assert.deepEqual(box('Review the open pull requests before lunch'), [true, false, undefined], 'a long title gives way …')
  assert.deepEqual(box('toy'), [false, false, '34%'], '… to a short workspace, which stays whole: no cut title beside empty room')
  assert.deepEqual(box('Notes'), [false, false, '66%'], 'a short title stays whole')
  assert.deepEqual(box('storefront-web-client'), [true, true, undefined], 'and a long workspace takes the rest')
  assert.deepEqual(box('아침 정리 보고'), [true, false, undefined], 'Hangul counts double: this title is the long one')
  assert.deepEqual([drawnLength('abc de'), drawnLength('토큰 교체')], [6, 9])
  await view.unmount()
})

test('while a run waits to be sent, a folded card says that in place of the last run — which opens with the card', async () => {
  const view = await mount(panel, { host: host() })
  const why = 'The server did not answer'
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: 'Board check',
    terminal: { ...open[0] },
    prompt: 'x',
    nextRunAt: Date.now() + 3600_000,
    lastStatus: 'failed',
    history: [{ at: Date.now() - 3600_000, status: 'failed', tookMs: 33 * 60_000, summary: why }]
  }
  const draw = (over: Partial<Schedule> = {}): Promise<void> => view.post('schedules.changed', { schedules: [{ ...s, ...over }] })
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))
  const failed = statusText('en', 'failed')
  // The last run on a folded card: its result as a word, when and how long, and why.
  const lastRun = (): boolean[] => [texts().includes(failed), texts().some((x) => x.endsWith('took 33 min')), texts().includes(why)]
  const waits = (): boolean => texts().includes('Waiting to send')

  await draw()
  assert.deepEqual([...lastRun(), waits()], [true, true, true, false], 'at rest: how the last run went, and why')

  await draw({ pendingSince: Date.now(), waitNote: { code: 'busy' } })
  assert.deepEqual([...lastRun(), waits()], [false, false, false, true], 'a run waits its turn: that, and not the one before it')

  await draw({ pendingSince: Date.now() - 60_000, waitNote: { code: 'typing' } })
  assert.ok(titled(view, 'Callout', 'Check'), 'a person must act: the warning')
  assert.deepEqual(lastRun(), [false, false, false], 'and not the run before it either')

  await draw({ pendingSince: Date.now(), waitNote: { code: 'busy' } })
  await unfold(view)
  assert.ok(view.find({ type: 'Badge', text: failed }) && texts().includes(why), 'opened: the last run, whole')
  assert.ok(waits(), 'and that one waits')

  await view.press({ type: 'IconButton', label: 'Less' })
  assert.deepEqual([...lastRun(), waits()], [false, false, false, true], 'folded again')
  await draw()
  assert.deepEqual([...lastRun(), waits()], [true, true, true, false], 'the wait over, the last run is back')
  await view.unmount()
})

test('a precheck is typed under its own fold, saved with the schedule, and reopens open; Send once has none', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ saved }) })
  await fillBasics(view)
  assert.equal(view.find({ label: 'Command (optional)' }), null, 'folded while empty')
  await view.toggle(titled(view, 'Collapsible', 'Precheck')!)
  await view.type({ label: 'Command (optional)' }, 'gh pr list | grep .')
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[0].precheck, 'gh pr list | grep .')

  await fillBasics(view)
  await view.press({ text: 'Create schedule' })
  assert.equal(saved[1].precheck, '', 'none unless typed')

  await view.press({ type: 'IconButton', label: 'Send once' })
  assert.equal(titled(view, 'Collapsible', 'Precheck'), null)
  await view.press({ type: 'ListItem', label: 'Review' })
  await view.type({ label: 'Prompt' }, 'Summarise the open PRs')
  await view.press({ text: 'Send' })
  assert.equal('precheck' in saved[2], false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the form lists the prompt variables, and warns when {{precheck}} has no command to fill it', async () => {
  const view = await mount(panel, { host: host() })
  await fillBasics(view)
  assert.ok(view.findAll({ type: 'Text' }).some((e) => plain(e.text).startsWith('Filled in when it goes out: {{date}} {{time}}')))
  const warning = () => view.findAll({ type: 'Text' }).find((e) => plain(e.text).includes('no precheck command is set')) ?? null
  assert.equal(warning(), null)
  await view.type({ label: 'Prompt' }, 'Review {{precheck}}')
  assert.ok(warning())
  await view.toggle(titled(view, 'Collapsible', 'Precheck')!)
  await view.type({ label: 'Command (optional)' }, 'gh pr list')
  assert.equal(warning(), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a run its precheck held back is grey, and the folded card says what the command said', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: 'PR review',
    terminal: { ...open[0] },
    prompt: 'Review',
    precheck: 'gh pr list | grep .',
    nextRunAt: Date.now() + 3600_000,
    lastStatus: 'skipped',
    history: [{ at: Date.now() - 60_000, status: 'skipped', note: { code: 'precheckNo', detail: 'exit 1' } }]
  }
  await view.post('schedules.changed', { schedules: [s] })
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))
  assert.ok(texts().includes('Precheck said no: exit 1'))
  assert.equal(view.find({ type: 'Text', text: 'Skipped' })?.props.tone, 'neutral')
  await unfold(view)
  assert.ok(texts().some((t) => t.endsWith('Precheck: gh pr list | grep .')), 'the opened card shows the command')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Try it now runs the precheck on the picked terminal\'s workspace and says what the run would do', async () => {
  const tried: { command: string; workspaceId: string }[] = []
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host({ tried, saved }) })
  await view.press({ type: 'IconButton', label: 'New schedule' })
  await view.toggle(titled(view, 'Collapsible', 'Precheck')!)
  const button = () => view.find({ type: 'Button', text: 'Try it now' })
  assert.equal(button()?.props.disabled, true, 'no command, no terminal')
  const texts = (): string[] => view.findAll({ type: 'Text' }).map((e) => plain(e.text))
  assert.ok(texts().includes('Pick a terminal first — the command runs in its workspace folder.'))
  await view.press({ type: 'ListItem', label: 'Review' })
  assert.equal(button()?.props.disabled, true, 'still no command')
  await view.type({ label: 'Command (optional)' }, 'gh pr list')
  await view.press({ type: 'Button', text: 'Try it now' })
  assert.deepEqual(tried, [{ command: 'gh pr list', workspaceId: 'w2' }])
  assert.equal(texts().some((x) => x.startsWith('Goes out as:')), false, 'a prompt without variables has no preview')
  assert.ok(texts().includes('Exit 0 — this run would go out (ran in ~/code/toy)'))
  assert.ok(texts().includes('Printed: #12; #15'))

  await view.type({ label: 'Command (optional)' }, 'gh pr list; exit 1')
  assert.equal(texts().some((x) => x.startsWith('Exit 0')), false, 'an answer about the old command goes when it changes')
  await view.press({ type: 'Button', text: 'Try it now' })
  assert.ok(texts().includes('This run would be skipped (ran in ~/code/toy)'))
  assert.ok(texts().includes('Precheck said no: exit 1 — no open pull requests'))

  await view.type({ label: 'Command (optional)' }, 'ghh pr list')
  await view.press({ type: 'Button', text: 'Try it now' })
  assert.ok(texts().includes('This run would fail (ran in ~/code/toy)'))
  assert.deepEqual(saved, [], 'trying saves nothing')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a prompt with variables shows how it would go out now — the last result, and the precheck once tried', async () => {
  const view = await mount(panel, { host: host() })
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: 'PR review',
    terminal: { ...open[1] },
    prompt: 'Carry on from {{last_result|nothing}} with {{precheck}}',
    precheck: 'gh pr list',
    report: true,
    nextRunAt: Date.now() + 3600_000,
    lastStatus: 'success',
    history: [{ at: Date.now() - 3600_000, status: 'success', tookMs: 60_000, summary: 'Reviewed #9' }]
  }
  await view.post('schedules.changed', { schedules: [s] })
  await unfold(view)
  await act(view, 'Edit', 0)
  const preview = () => view.findAll({ type: 'Text' }).map((e) => plain(e.text)).find((x) => x.startsWith('Goes out as:')) ?? null
  assert.equal(preview(), 'Goes out as: Carry on from Reviewed #9 with (what the precheck prints)')
  await view.press({ type: 'Button', text: 'Try it now' })
  assert.equal(preview(), 'Goes out as: Carry on from Reviewed #9 with #12; #15')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
