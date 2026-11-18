import { assert, test } from 'orca/testing'
import {
  askedSoon,
  asksReport,
  blankSchedule,
  inspectOnEvent,
  type Io,
  limits,
  type LiveTerminal,
  locate,
  newMemory,
  onAgentStatus,
  type Schedule,
  type SendResult,
  tick
} from './engine'
import { noteText } from './i18n'
import { reportToken } from './report'

const rule = '──────────────────────────────'
const idle = ['⏺ done', rule, '❯ ', rule]
const typing = ['⏺ done', rule, '❯ half-written', rule]
const question = ['  1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel']
const permission = ['Do you want to proceed?', '❯ 1. Yes', '  2. No']
const working = ['⏺ Reading files…', '✻ Thinking (esc to interrupt)']

const nine = new Date(2026, 10, 13, 9, 0).getTime()
const min = 60_000

function term(over: Partial<LiveTerminal> = {}): LiveTerminal {
  return { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', tabId: 'tab1', leafId: 'leaf1', lastOutputAt: nine - 10 * min, ...over }
}

/** A fake Orca: open terminals, screens by handle, and what it was sent. */
function fakeIo(opts: { live?: LiveTerminal[] | null; screens?: Record<string, string[] | null | 'error'>; send?: SendResult } = {}) {
  const sent: [string, string][] = []
  const state = { live: opts.live === undefined ? [term()] : opts.live, screens: opts.screens ?? { h1: idle }, send: opts.send ?? { started: true } }
  const io: Io = {
    async read(handle) {
      const s = state.screens[handle]
      if (s === 'error') throw new Error('busy')
      return s === undefined ? null : s
    },
    async send(handle, text) {
      if ('error' in state.send) return state.send
      sent.push([handle, text])
      return state.send
    },
    async terminals() {
      return state.live
    }
  }
  return { io, sent, state }
}

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    ...blankSchedule('s1'),
    name: 'Morning',
    terminal: { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'docs', tabId: 'tab1', leafId: 'leaf1' },
    cron: '0 9 * * *',
    prompt: 'Plan the day',
    ...over
  }
}

test('at the set time, an idle terminal gets the prompt', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  const r = await tick([s], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
  assert.equal(s.sentAt, nine + 10_000)
  assert.equal(s.sawWorking, true, 'turn start seen while sending counts as working')
  assert.equal(s.pendingSince, null)
  assert.equal(s.lastStatus, 'sent')
  assert.ok(s.nextRunAt && s.nextRunAt > nine, 'next run moves to tomorrow')
  assert.deepEqual(r.notices, [])
})

test('a run whose time passed unchecked — asleep, Orca closed — still goes out once, marked late', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  const late = 6 * 60 * min + 2 * min
  const r = await tick([s], f.io, newMemory(), nine + late)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], 'caught up, not dropped')
  assert.equal(s.lateMs, late)
  assert.deepEqual(r.notices, [{ name: 'Morning', lateMs: late }])
  assert.ok(s.nextRunAt && s.nextRunAt > nine + late, 'the runs missed in between are not replayed')
  onAgentStatus([s], { terminalId: 'h1', state: 'done', receivedAt: nine + late + 4 * min })
  assert.equal(s.history[0].lateMs, late, 'the record keeps how late it went out')
  assert.equal(s.lateMs, null)
})

test('a run that only waited its turn, under the 60-minute limit, is not marked late', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  const r = await tick([s], f.io, newMemory(), nine + limits.maxWaitMs - min)
  assert.equal(f.sent.length, 1)
  assert.equal(s.lateMs, null)
  assert.deepEqual(r.notices, [])
  onAgentStatus([s], { terminalId: 'h1', state: 'done', receivedAt: nine + limits.maxWaitMs + 4 * min })
  assert.equal('lateMs' in s.history[0], false)
})

test('turn start not seen — sent, and the working event decides', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ send: { started: false } })
  await tick([s], f.io, newMemory(), nine + 10_000)
  assert.ok(s.sentAt)
  assert.equal(s.sawWorking, false)
})

test('waits while the terminal printed within the last minute, then sends', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [term({ lastOutputAt: nine - 20_000 })] })
  await tick([s], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.sent, [])
  assert.deepEqual(s.waitNote, { code: 'moving' })
  f.state.live = [term({ lastOutputAt: nine - 20_000 })]
  await tick([s], f.io, newMemory(), nine + 45_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], 'quiet for 65 s')
})

test('without lastOutputAt, a screen seen still for a minute counts as quiet', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [term({ lastOutputAt: null })] })
  const memory = newMemory()
  await tick([s], f.io, memory, nine + 10_000)
  assert.deepEqual(s.waitNote, { code: 'moving' }, 'first sight')
  await tick([s], f.io, memory, nine + 40_000)
  assert.deepEqual(f.sent, [])
  await tick([s], f.io, memory, nine + 70_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
})

test('a run a person asked for goes out after 5 still seconds — the same screen holds a scheduled run for the minute', async () => {
  const printed = nine - 2000
  const asked = sched({ pendingSince: nine })
  const memory = newMemory()
  memory.asked.add('s1')
  const f = fakeIo({ live: [term({ lastOutputAt: printed })] })
  await tick([asked], f.io, memory, nine + 1000)
  assert.deepEqual(f.sent, [], 'printed 3 s ago')
  assert.deepEqual(asked.waitNote, { code: 'moving' })
  assert.equal(askedSoon([asked], memory, nine + 1000), true, 'worth another look within seconds')
  await tick([asked], f.io, memory, nine + 4000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], 'printed 6 s ago')
  assert.equal(memory.asked.has('s1'), false, 'asked for by hand only until it goes out')
  assert.equal(askedSoon([asked], memory, nine + 4000), false)

  const due = sched({ pendingSince: nine })
  const g = fakeIo({ live: [term({ lastOutputAt: printed })] })
  const own = newMemory()
  await tick([due], g.io, own, nine + 4000)
  assert.deepEqual(g.sent, [], 'the schedule\'s own time: 6 s is not a minute')
  assert.deepEqual(due.waitNote, { code: 'moving' })
  assert.equal(askedSoon([due], own, nine + 4000), false, 'a scheduled run keeps the 30-second pace')
})

test('a run a person asked for: text unchanged for 5 seconds is enough while the status line repaints', async () => {
  const s = sched({ pendingSince: nine })
  const memory = newMemory()
  memory.asked.add('s1')
  const f = fakeIo({ live: [term({ lastOutputAt: nine })] })
  await tick([s], f.io, memory, nine + 500)
  f.state.live = [term({ lastOutputAt: nine + 3000 })]
  await tick([s], f.io, memory, nine + 3500)
  assert.deepEqual(f.sent, [], 'the same text for 3 s, repainted half a second ago')
  f.state.live = [term({ lastOutputAt: nine + 6000 })]
  await tick([s], f.io, memory, nine + 6500)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], 'the same text for 6 s')
})

test('a run a person asked for still waits for a working agent, text in the input box and a dialog', async () => {
  const held = async (screen: string[], over: { working?: boolean; printedAgo?: number } = {}) => {
    const s = sched({ pendingSince: nine })
    const memory = newMemory()
    memory.asked.add('s1')
    if (over.working) memory.agents.set('h1', 'working')
    // Still for 30 s unless said: enough for a run asked for by hand, were nothing else in the way.
    const f = fakeIo({ live: [term({ lastOutputAt: nine + 1000 - (over.printedAgo ?? 30_000) })], screens: { h1: screen } })
    await tick([s], f.io, memory, nine + 1000)
    return { sent: f.sent, note: s.waitNote, soon: askedSoon([s], memory, nine + 1000), asked: memory.asked.has('s1') }
  }
  assert.deepEqual(await held(idle, { working: true, printedAgo: 2000 }), { sent: [], note: { code: 'busy' }, soon: true, asked: true }, 'printing — looked at again within seconds')
  assert.deepEqual(await held(typing), { sent: [], note: { code: 'typing' }, soon: false, asked: true }, 'a person has to clear it — the usual pace')
  assert.deepEqual(await held(permission), { sent: [], note: { code: 'dialog' }, soon: false, asked: true })
  assert.deepEqual((await held(idle)).sent, [['h1', 'Plan the day']], 'the same terminal with nothing in the way')
})

test('a "working" nobody took back: a run a person asked for goes after 5 still seconds — a scheduled run gives it 3 minutes', async () => {
  // The agent stopped, the done event did not come, and the screen has been still for 30 s.
  const run = async (asked: boolean) => {
    const s = sched({ pendingSince: nine })
    const memory = newMemory()
    if (asked) memory.asked.add('s1')
    memory.agents.set('h1', 'working')
    const f = fakeIo({ live: [term({ lastOutputAt: nine - 29_000 })] })
    await tick([s], f.io, memory, nine + 1000)
    return { sent: f.sent.length, note: s.waitNote }
  }
  assert.deepEqual(await run(true), { sent: 1, note: null })
  assert.deepEqual(await run(false), { sent: 0, note: { code: 'busy' } })
})

test('quick looks at a run a person asked for: while it waits for what passes by itself, for two minutes', () => {
  const memory = newMemory()
  memory.asked.add('s1')
  const waiting = (code: 'moving' | 'busy' | 'otherRun' | 'missing' | 'noAgent' | 'cli' | 'noPrompt'): Schedule => ({ ...sched({ pendingSince: nine }), waitNote: { code } })
  const soon = (s: Schedule, after = 1000) => askedSoon([s], memory, nine + after)
  assert.deepEqual([soon(waiting('moving')), soon(waiting('busy')), soon(waiting('otherRun'))], [true, true, true])
  assert.deepEqual([soon(waiting('missing')), soon(waiting('noAgent')), soon(waiting('cli')), soon(waiting('noPrompt'))], [false, false, false, false], 'a person has to act')
  assert.equal(soon(waiting('busy'), limits.askedFastMs - 1), true)
  assert.equal(soon(waiting('busy'), limits.askedFastMs), false, 'then the usual 30-second pace — each look costs a CLI call')
  assert.equal(soon({ ...waiting('moving'), sentAt: nine }), false, 'its own run is going')
})

test('a run a person asked for with a new conversation: /clear, then the prompt 5 still seconds later', async () => {
  const s = sched({ pendingSince: nine, clearFirst: true })
  const memory = newMemory()
  memory.asked.add('s1')
  const f = fakeIo({ live: [term({ lastOutputAt: nine - 30_000 })] })
  await tick([s], f.io, memory, nine + 1000)
  assert.deepEqual(f.sent, [['h1', '/clear']])
  assert.equal(askedSoon([s], memory, nine + 1000), true, 'the screen settling after /clear is looked at within seconds')
  // /clear printed.
  f.state.live = [term({ lastOutputAt: nine + 1000 })]
  await tick([s], f.io, memory, nine + 4000)
  assert.equal(f.sent.length, 1, '3 s after /clear')
  await tick([s], f.io, memory, nine + 7000)
  assert.deepEqual(f.sent[1], ['h1', 'Plan the day'], '6 s after /clear')
})

test('waits for text left in the input box, a dialog, or a missing input box — then skips after 60 minutes', async () => {
  for (const [screen, code] of [
    [typing, 'typing'],
    [permission, 'dialog'],
    [working, 'noPrompt']
  ] as const) {
    const s = sched({ nextRunAt: nine })
    const f = fakeIo({ screens: { h1: [...screen] } })
    await tick([s], f.io, newMemory(), nine + 10_000)
    assert.deepEqual(s.waitNote, { code }, code)
    const r = await tick([s], f.io, newMemory(), nine + limits.maxWaitMs)
    assert.equal(s.pendingSince, null)
    assert.equal(s.history[0].status, 'skipped')
    assert.deepEqual(s.history[0].note, { code: 'waitedOut', reason: code })
    assert.equal(r.notices.length, 1)
    assert.deepEqual(f.sent, [], `never sent (${code})`)
  }
})

test('a stale "working" state stops blocking once the screen has been still for 3 minutes', async () => {
  const memory = newMemory()
  memory.agents.set('h1', 'working')
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [term({ lastOutputAt: nine - 2 * min })] })
  await tick([s], f.io, memory, nine)
  assert.deepEqual(s.waitNote, { code: 'busy' })
  f.state.live = [term({ lastOutputAt: nine - 2 * min })]
  await tick([s], f.io, memory, nine + 61_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
})

test('a terminal that is gone is waited for; after Orca restarts it is found again by pane', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [] })
  await tick([s], f.io, newMemory(), nine)
  assert.deepEqual(s.waitNote, { code: 'missing' })
  f.state.live = [term({ handle: 'h9', title: 'Morning (renamed)' })]
  f.state.screens = { h9: idle }
  await tick([s], f.io, newMemory(), nine + 30_000)
  assert.deepEqual(f.sent, [['h9', 'Plan the day']])
  assert.equal(s.terminal.handle, 'h9')
  assert.equal(s.terminal.title, 'Morning (renamed)')
})

test('locate — by handle first, then by pane id', () => {
  const ref = sched().terminal
  assert.equal(locate(ref, [term({ handle: 'h1', leafId: 'other' })])?.handle, 'h1')
  assert.equal(locate(ref, [term({ handle: 'h2', leafId: 'leaf1' })])?.handle, 'h2')
  assert.equal(locate(ref, [term({ handle: 'h2', leafId: 'other' })]), null)
  assert.equal(locate({ ...ref, leafId: '' }, [term({ handle: 'h2', leafId: '' })]), null, 'no pane id, no guess')
})

test('a terminal where only a shell is left is never sent to', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [term({ agent: null })] })
  await tick([s], f.io, newMemory(), nine)
  assert.deepEqual(s.waitNote, { code: 'noAgent' })
  assert.deepEqual(f.sent, [])
})

test('when the terminal list cannot be read, waits', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: null })
  await tick([s], f.io, newMemory(), nine)
  assert.deepEqual(s.waitNote, { code: 'cli' })
  assert.deepEqual(f.sent, [])
})

test('new conversation — /clear first, the prompt once the screen settles again', async () => {
  const s = sched({ nextRunAt: nine, clearFirst: true })
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine)
  assert.deepEqual(f.sent, [['h1', '/clear']])
  assert.deepEqual(s.waitNote, { code: 'cleared' })
  assert.equal(s.sentAt, null)
  // /clear redrew the screen
  f.state.live = [term({ lastOutputAt: nine + 1_000 })]
  await tick([s], f.io, newMemory(), nine + 30_000)
  assert.equal(f.sent.length, 1, 'still settling')
  await tick([s], f.io, newMemory(), nine + 62_000)
  assert.deepEqual(f.sent, [
    ['h1', '/clear'],
    ['h1', 'Plan the day']
  ])
  assert.ok(s.sentAt)
})

test('two schedules on one terminal — one per check', async () => {
  const a = sched({ id: 'a', nextRunAt: nine })
  const b = sched({ id: 'b', name: 'Second', prompt: 'Second prompt', nextRunAt: nine })
  const f = fakeIo()
  await tick([a, b], f.io, newMemory(), nine)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
  assert.deepEqual(b.waitNote, { code: 'sameTerminal' })
})

test("a run waits while another schedule's run is still going in that terminal", async () => {
  const a = sched({ id: 'a', nextRunAt: nine })
  const b = sched({ id: 'b', name: 'Second', prompt: 'Second prompt', nextRunAt: nine + min })
  const f = fakeIo()
  const memory = newMemory()
  await tick([a, b], f.io, memory, nine)
  assert.equal(a.sentAt, nine)
  // Two minutes on: no event came, the screen is still and the input box is empty — a's run is not closed yet.
  await tick([a, b], f.io, memory, nine + 2 * min)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], "b's prompt would be read as the end of a's run")
  assert.deepEqual(b.waitNote, { code: 'otherRun' })
  // Quiet for finishedQuietMs: a's run is closed by the screen, and b goes out on the same check.
  await tick([a, b], f.io, memory, nine + 4 * min)
  assert.equal(a.history[0].status, 'done')
  assert.deepEqual(f.sent, [
    ['h1', 'Plan the day'],
    ['h1', 'Second prompt']
  ])
  assert.equal(b.waitNote, null)
})

test("a run in another terminal does not hold this one back", async () => {
  const a = sched({ id: 'a', sentAt: nine - min, terminal: { handle: 'h2', title: 'Review', agent: 'codex', workspaceId: 'w1', workspace: 'docs', tabId: 'tab2', leafId: 'leaf2' } })
  const b = sched({ id: 'b', nextRunAt: nine })
  const f = fakeIo({ live: [term(), term({ handle: 'h2', title: 'Review', agent: 'codex', tabId: 'tab2', leafId: 'leaf2' })], screens: { h1: idle, h2: working } })
  await tick([a, b], f.io, newMemory(), nine)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
})

test('a failed send is recorded with the reason', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ send: { error: 'terminal_handle_stale' } })
  const r = await tick([s], f.io, newMemory(), nine)
  assert.equal(s.history[0].status, 'failed')
  assert.deepEqual(s.history[0].note, { code: 'sendFailed', detail: 'terminal_handle_stale' })
  assert.equal(s.pendingSince, null)
  assert.equal(r.notices.length, 1)
})

test('a run due while the previous one still runs waits for it, and gives up after 60 minutes', async () => {
  const s = sched({ sentAt: nine - 10 * min, pendingSince: nine, nextRunAt: nine + 24 * 60 * min })
  const f = fakeIo({ live: [term({ lastOutputAt: nine })] })
  await tick([s], f.io, newMemory(), nine + min)
  assert.deepEqual(s.waitNote, { code: 'previous' })
  assert.deepEqual(f.sent, [])
  f.state.live = [term({ lastOutputAt: nine + limits.maxWaitMs })]
  await tick([s], f.io, newMemory(), nine + limits.maxWaitMs)
  assert.equal(s.history[0].status, 'skipped')
  assert.deepEqual(s.history[0].note, { code: 'waitedOut', reason: 'previous' })
})

test('agent status — working then done ends the run', () => {
  const s = sched({ sentAt: nine, sawWorking: false })
  onAgentStatus([s], { terminalId: 'h1', state: 'done', receivedAt: nine + 1_000 })
  assert.ok(s.sentAt, 'done before working is not an end')
  onAgentStatus([s], { terminalId: 'h1', state: 'working', receivedAt: nine + 2_000 })
  const r = onAgentStatus([s], { terminalId: 'h1', state: 'done', receivedAt: nine + 4 * min })
  assert.equal(s.sentAt, null)
  assert.deepEqual(s.history[0], { at: nine + 4 * min, status: 'done', tookMs: 4 * min })
  assert.deepEqual(r.notices, [], 'a plain end is quiet')
})

test('agent status — outcome and waiting', () => {
  const ok = sched({ sentAt: nine, sawWorking: true })
  onAgentStatus([ok], { terminalId: 'h1', state: 'done', receivedAt: nine, mainAgent: { state: 'done', outcome: 'success', stateStartedAt: nine } })
  assert.equal(ok.history[0].status, 'success')
  const asking = sched({ sentAt: nine, sawWorking: true })
  const r = onAgentStatus([asking], { terminalId: 'h1', state: 'waiting', receivedAt: nine })
  assert.equal(asking.history[0].status, 'doneWaiting')
  assert.deepEqual(r.notices, [{ name: 'Morning', status: 'doneWaiting' }])
  const other = sched({ sentAt: nine, sawWorking: true })
  onAgentStatus([other], { terminalId: 'h2', state: 'done', receivedAt: nine })
  assert.ok(other.sentAt, 'another terminal')
})

test('agent status — blocked asks for a person once', () => {
  const s = sched({ sentAt: nine, sawWorking: true })
  const a = onAgentStatus([s], { terminalId: 'h1', state: 'blocked', receivedAt: nine })
  const b = onAgentStatus([s], { terminalId: 'h1', state: 'blocked', receivedAt: nine })
  assert.deepEqual(s.blocked, { code: 'person' })
  assert.equal(a.notices.length + b.notices.length, 1)
  onAgentStatus([s], { terminalId: 'h1', state: 'working', receivedAt: nine })
  assert.equal(s.blocked, null)
})

test('a stop event on a question or permission dialog holds the run instead of ending it', async () => {
  for (const screen of [question, permission]) {
    const s = sched({ sentAt: nine, sawWorking: true })
    const f = fakeIo({ screens: { h1: [...screen] } })
    const first = await inspectOnEvent([s], { terminalId: 'h1', state: 'done', receivedAt: nine }, f.io)
    assert.equal(first.hold, true)
    assert.deepEqual(s.blocked, { code: 'person' })
    assert.equal(first.notices.length, 1)
    const again = await inspectOnEvent([s], { terminalId: 'h1', state: 'waiting', receivedAt: nine }, f.io)
    assert.equal(again.hold, true)
    assert.equal(again.notices.length, 0, 'no repeat notice')
  }
  const s = sched({ sentAt: nine, sawWorking: true })
  const f = fakeIo()
  assert.equal((await inspectOnEvent([s], { terminalId: 'h1', state: 'done', receivedAt: nine }, f.io)).hold, false, 'idle screen')
})

test('stop events wait settleMs before reading — the dialog is drawn a moment after the event', async () => {
  for (const [settle, hold] of [
    [0, false],
    [60, true]
  ] as const) {
    const s = sched({ sentAt: nine, sawWorking: true })
    const f = fakeIo()
    setTimeout(() => (f.state.screens = { h1: [...question] }), 10)
    const r = await inspectOnEvent([s], { terminalId: 'h1', state: 'done', receivedAt: nine }, f.io, settle)
    assert.equal(r.hold, hold, `settle ${settle}`)
  }
})

test('working events do not read the screen', async () => {
  let reads = 0
  const s = sched({ sentAt: nine })
  const f = fakeIo()
  const io: Io = { ...f.io, read: async (h) => (reads++, f.io.read(h)) }
  await inspectOnEvent([s], { terminalId: 'h1', state: 'working', receivedAt: nine }, io)
  assert.equal(reads, 0)
})

test('watch — a closed terminal stops the run', async () => {
  const s = sched({ sentAt: nine })
  const f = fakeIo({ live: [] })
  await tick([s], f.io, newMemory(), nine + min)
  assert.equal(s.sentAt, null)
  assert.deepEqual(s.history[0].note, { code: 'closed' })
  assert.equal(s.history[0].status, 'aborted')
})

test('watch — a missed end event: quiet 3 minutes with an empty input box is done', async () => {
  const s = sched({ sentAt: nine })
  const f = fakeIo({ live: [term({ lastOutputAt: nine + 2 * min })] })
  await tick([s], f.io, newMemory(), nine + 4 * min)
  assert.ok(s.sentAt, 'quiet for 2 minutes only')
  await tick([s], f.io, newMemory(), nine + 5 * min)
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, 'done')
  assert.deepEqual(s.history[0].note, { code: 'byScreen' })
})

test('watch — quiet but stuck asks for a person once, and clears when the screen moves', async () => {
  const s = sched({ sentAt: nine })
  const memory = newMemory()
  const f = fakeIo({ live: [term({ lastOutputAt: nine })], screens: { h1: [...typing] } })
  const a = await tick([s], f.io, memory, nine + 4 * min)
  const b = await tick([s], f.io, memory, nine + 5 * min)
  assert.deepEqual(s.blocked, { code: 'stuckTyping' })
  assert.equal(a.notices.length + b.notices.length, 1)
  f.state.screens = { h1: [...working] }
  f.state.live = [term({ lastOutputAt: nine + 5 * min })]
  await tick([s], f.io, memory, nine + 6 * min)
  assert.equal(s.blocked, null)
  assert.ok(s.sentAt)
})

test('watch — no end in 6 hours is "no result"', async () => {
  const s = sched({ sentAt: nine })
  const f = fakeIo()
  const r = await tick([s], f.io, newMemory(), nine + limits.resultTimeoutMs)
  assert.equal(s.history[0].status, 'noResult')
  assert.deepEqual(r.notices, [{ name: 'Morning', status: 'noResult' }])
})

test('disabled schedules never go due', async () => {
  const s = sched({ enabled: false, nextRunAt: nine })
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine + min)
  assert.equal(s.nextRunAt, null)
  assert.equal(s.pendingSince, null)
  assert.deepEqual(f.sent, [])
})

test('send once — goes out when idle, then never comes due again (no cron, so no next run)', async () => {
  const s = sched({ once: true, cron: '', pendingSince: nine })
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']])
  assert.equal(s.nextRunAt, null)
  s.sentAt = null
  await tick([s], f.io, newMemory(), nine + 24 * 60 * min)
  assert.equal(s.pendingSince, null, 'no times — nothing comes due')
  assert.equal(f.sent.length, 1)
})

test('a schedule that asks for a result sends the ask after the prompt, in the chosen language, with the run\'s tag', async () => {
  for (const [lang, expect] of [
    ['en', /^Plan the day When you finish, end your reply with one line in this form: \[result (\w{4}) STATUS\] one-line summary \[link\] URL \[end\]/],
    ['ko', /^Plan the day 끝나면 답의 마지막 줄을 이 형식으로 적는다: \[result (\w{4}) STATUS\] 한 줄 요약 \[link\] URL \[end\]/]
  ] as const) {
    const s = sched({ nextRunAt: nine, report: true })
    const f = fakeIo()
    await tick([s], f.io, newMemory(), nine + 10_000, lang)
    assert.match(f.sent[0][1], expect)
    assert.equal(expect.exec(f.sent[0][1])?.[1], reportToken(nine + 10_000), 'the tag is the one the screen is read for')
    assert.ok(!f.sent[0][1].includes('\n'), 'one line — a prompt typed on one line stays on one')
  }
})

test('without the option nothing is added; a command (/…) never gets the ask', async () => {
  const plain = sched({ nextRunAt: nine })
  const command = sched({ nextRunAt: nine, report: true, prompt: '  /compact' })
  const f = fakeIo()
  await tick([plain], f.io, newMemory(), nine + 10_000)
  await tick([command], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.sent, [
    ['h1', 'Plan the day'],
    ['h1', '  /compact']
  ])
  assert.equal(asksReport(command), false)
})

const resultScreen = (at: number, line: string) => ['❯ Plan the day', `⏺ ${line.replace('TAG', reportToken(at))}`, rule, '❯ ', rule]

test('agent status — the result line on screen gives the run its status, summary and link', async () => {
  const sentAt = nine + 10_000
  const s = sched({ report: true, sentAt, sawWorking: true })
  const f = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG ok] 3 PRs need review [link] https://example.com/pr/128 [end]') } })
  const e = { terminalId: 'h1', state: 'done' as const, receivedAt: sentAt + 4 * min }
  const seen = await inspectOnEvent([s], e, f.io)
  assert.equal(seen.hold, false)
  onAgentStatus([s], e, seen.reports)
  assert.deepEqual(s.history[0], { at: sentAt + 4 * min, status: 'success', tookMs: 4 * min, summary: '3 PRs need review', link: 'https://example.com/pr/128' })
  assert.equal(s.lastStatus, 'success')
})

test('agent status — a run the agent calls failed is failed and announced with what it said; skipped is skipped', async () => {
  const sentAt = nine + 10_000
  const failed = sched({ report: true, sentAt, sawWorking: true })
  const f = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG failed] The build broke [end]') } })
  // The turn itself ended well — it is the agent that says the work failed.
  const e = { terminalId: 'h1', state: 'done' as const, receivedAt: sentAt + min, mainAgent: { state: 'done' as const, outcome: 'success', stateStartedAt: sentAt } }
  const r = onAgentStatus([failed], e, (await inspectOnEvent([failed], e, f.io)).reports)
  assert.equal(failed.history[0].status, 'failed')
  assert.deepEqual(r.notices, [{ name: 'Morning', status: 'failed', summary: 'The build broke' }])

  const skipped = sched({ report: true, sentAt, sawWorking: true })
  const g = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG skipped] Nothing new [end]') } })
  // Waiting for input with a result line — the agent finished; it is not asking anything.
  const w = { terminalId: 'h1', state: 'waiting' as const, receivedAt: sentAt + min }
  const q = onAgentStatus([skipped], w, (await inspectOnEvent([skipped], w, g.io)).reports)
  assert.equal(skipped.history[0].status, 'skipped')
  assert.equal(skipped.history[0].summary, 'Nothing new')
  assert.deepEqual(q.notices, [])
})

test('agent status — a turn that was stopped stays stopped whatever the screen says; no line, no summary', async () => {
  const sentAt = nine + 10_000
  const stopped = sched({ report: true, sentAt, sawWorking: true })
  const f = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG ok] Half done [end]') } })
  const e = { terminalId: 'h1', state: 'done' as const, receivedAt: sentAt + min, mainAgent: { state: 'done' as const, outcome: 'interruption', stateStartedAt: sentAt } }
  onAgentStatus([stopped], e, (await inspectOnEvent([stopped], e, f.io)).reports)
  assert.equal(stopped.history[0].status, 'aborted')
  assert.equal(stopped.history[0].summary, 'Half done')

  const silent = sched({ report: true, sentAt, sawWorking: true })
  const g = fakeIo()
  const d = { terminalId: 'h1', state: 'done' as const, receivedAt: sentAt + min }
  onAgentStatus([silent], d, (await inspectOnEvent([silent], d, g.io)).reports)
  assert.deepEqual(silent.history[0], { at: sentAt + min, status: 'done', tookMs: min, note: { code: 'noLine' } }, 'asked, ended as usual, nothing on screen — the record says so')
})

test('a schedule that did not ask never reads a result off the screen', async () => {
  const sentAt = nine + 10_000
  const s = sched({ sentAt, sawWorking: true })
  const f = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG failed] Not mine [end]') } })
  const e = { terminalId: 'h1', state: 'done' as const, receivedAt: sentAt + min }
  const seen = await inspectOnEvent([s], e, f.io)
  assert.equal(seen.reports.size, 0)
  onAgentStatus([s], e, seen.reports)
  assert.equal(s.history[0].status, 'done')
  assert.equal(s.history[0].summary, undefined)
})

test('watch — the result line ends the run on the first check that sees it, while the terminal still prints', async () => {
  const sentAt = nine
  const s = sched({ report: true, sentAt, sawWorking: true })
  const plain = sched({ id: 's2', name: 'Plain', sentAt, terminal: { ...sched().terminal, handle: 'h2', leafId: 'leaf2' } })
  const line = resultScreen(sentAt, '[result TAG failed] Could not reach the server [end]')
  const f = fakeIo({
    live: [term({ lastOutputAt: sentAt + 38_000 }), term({ handle: 'h2', leafId: 'leaf2', lastOutputAt: sentAt + 38_000 })],
    screens: { h1: line, h2: line }
  })
  const r = await tick([s, plain], f.io, newMemory(), sentAt + 40_000)
  assert.equal(s.sentAt, null, 'no end event, no quiet screen — the line is enough')
  assert.deepEqual(s.history[0], { at: sentAt + 40_000, status: 'failed', tookMs: 40_000, summary: 'Could not reach the server' })
  assert.deepEqual(r.notices, [{ name: 'Morning', status: 'failed', summary: 'Could not reach the server' }])
  assert.ok(r.log.includes('Morning: failed (result line)'))
  assert.ok(plain.sentAt, 'a run that did not ask for the line is not ended by one')
})

test('watch — the ask echoed with the prompt is not the result line', async () => {
  const sentAt = nine
  const s = sched({ report: true, sentAt, sawWorking: true })
  const f = fakeIo({ live: [term({ lastOutputAt: sentAt + 38_000 })], screens: { h1: resultScreen(sentAt, '[result TAG STATUS] one-line summary [link] URL [end]') } })
  await tick([s], f.io, newMemory(), sentAt + 40_000)
  assert.ok(s.sentAt, 'still going')
})

test('an idle agent that keeps repainting — the output time moves, the text does not — is quiet', async () => {
  // Seen on an idle Claude Code: new output every 7 to 171 s, the same text on screen throughout.
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  const memory = newMemory()
  const check = async (at: number): Promise<void> => {
    f.state.live = [term({ lastOutputAt: at - 3_000 })]
    await tick([s], f.io, memory, at)
  }
  await check(nine + 10_000)
  assert.deepEqual(s.waitNote, { code: 'moving' }, 'first sight')
  await check(nine + 40_000)
  assert.deepEqual(f.sent, [], 'the same text for 30 s')
  await check(nine + 70_000)
  assert.deepEqual(f.sent, [['h1', 'Plan the day']], 'the same text for a minute')

  // The run that went out ends by screen the same way — three minutes of the same text.
  f.state.screens.h1 = ['⏺ Planned the day', rule, '❯ ', rule]
  for (let at = nine + 100_000; at <= nine + 250_000; at += 30_000) await check(at)
  assert.ok(s.sentAt, 'the reply was first seen at 100 s — the same text for 150 s')
  await check(nine + 280_000)
  assert.equal(s.sentAt, null)
  assert.deepEqual(s.history[0].note, { code: 'byScreen' })
})

test('text that changes between checks is not quiet, however long ago the terminal says it printed', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo({ live: [term({ lastOutputAt: null })] })
  const memory = newMemory()
  for (const [at, line] of [[10_000, 'step 1'], [40_000, 'step 2'], [70_000, 'step 3'], [100_000, 'step 4']] as const) {
    f.state.screens.h1 = [`⏺ ${line}`, rule, '❯ ', rule]
    await tick([s], f.io, memory, nine + at)
  }
  assert.deepEqual(f.sent, [])
  assert.deepEqual(s.waitNote, { code: 'moving' })
})

test('a run asked for a result that ends without the line says so in its record', async () => {
  const sentAt = nine
  // Ended by the quiet screen, no line on it.
  const quiet = sched({ report: true, sentAt, sawWorking: true })
  await tick([quiet], fakeIo({ live: [term({ lastOutputAt: sentAt + min })] }).io, newMemory(), sentAt + 5 * min)
  assert.deepEqual([quiet.history[0].status, quiet.history[0].note], ['done', { code: 'byScreen', reason: 'noLine' }])
  assert.equal(noteText('en', quiet.history[0].note!), 'by screen: no result line on screen')
  assert.equal(noteText('ko', quiet.history[0].note!), '화면 기준 · 화면에 결과 줄이 없음')

  // Stopped at a question — it has not got to the line yet; nothing is missing.
  const asking = sched({ report: true, sentAt, sawWorking: true })
  onAgentStatus([asking], { terminalId: 'h1', state: 'waiting', receivedAt: sentAt + min })
  assert.deepEqual([asking.history[0].status, asking.history[0].note], ['doneWaiting', undefined])

  // Not asked, or a command that never gets the ask — no line was due.
  for (const over of [{ report: false }, { report: true, prompt: '/compact' }]) {
    const s = sched({ ...over, sentAt, sawWorking: true })
    onAgentStatus([s], { terminalId: 'h1', state: 'done', receivedAt: sentAt + min })
    assert.deepEqual([s.history[0].status, s.history[0].note], ['done', undefined])
  }
})

test('a result line that comes after the end — the agent waited on its own background work — is taken into the record', async () => {
  const sentAt = nine
  const ended = sentAt + 4 * min
  const record = { at: ended, status: 'done' as const, tookMs: 4 * min, note: { code: 'byScreen' as const, reason: 'noLine' as const } }
  const late = sched({ report: true, lastStatus: 'done', history: [record, { at: sentAt - 60 * min, status: 'done' }] })
  // The line is not there yet: the record stays as it is.
  const f = fakeIo({ live: [term({ lastOutputAt: ended })] })
  await tick([late], f.io, newMemory(), ended + 30_000)
  assert.deepEqual(late.history[0], record)
  f.state.screens.h1 = resultScreen(sentAt, '[result TAG skipped] Nothing changed [link] https://example.com/board [end]')
  const r = await tick([late], f.io, newMemory(), ended + min)
  assert.deepEqual(late.history[0], {
    at: ended,
    status: 'skipped',
    tookMs: 4 * min,
    note: { code: 'byScreen' },
    summary: 'Nothing changed',
    link: 'https://example.com/board'
  })
  assert.equal(late.lastStatus, 'skipped')
  assert.equal(late.history.length, 2, 'the same record, not a new one')
  assert.deepEqual(r.log, ['Morning: result line came after the end'])
  assert.deepEqual(f.sent, [], 'nothing is sent for it')

  // A failure that comes late is announced like any other.
  const failed = sched({ report: true, history: [{ at: ended, status: 'done', tookMs: 4 * min, note: { code: 'noLine' } }] })
  const g = fakeIo({ screens: { h1: resultScreen(sentAt, '[result TAG failed] The build broke [end]') } })
  const again = await tick([failed], g.io, newMemory(), ended + min)
  assert.deepEqual(failed.history[0], { at: ended, status: 'failed', tookMs: 4 * min, summary: 'The build broke' })
  assert.deepEqual(again.notices, [{ name: 'Morning', status: 'failed', summary: 'The build broke' }])
})

test('a late result line is taken only for the run it belongs to, and only for a while', async () => {
  const sentAt = nine
  const ended = sentAt + 4 * min
  const noLine = { at: ended, status: 'done' as const, tookMs: 4 * min, note: { code: 'noLine' as const } }
  const line = (at: number) => resultScreen(at, '[result TAG failed] Not this run [end]')
  // Another run's line — an earlier one still on screen.
  const other = sched({ report: true, history: [noLine] })
  await tick([other], fakeIo({ screens: { h1: line(sentAt - 30 * min) } }).io, newMemory(), ended + min)
  assert.deepEqual(other.history[0], noLine)
  // Past the time it is looked for: the terminals are not even listed.
  const old = sched({ report: true, history: [noLine] })
  const f = fakeIo({ screens: { h1: line(sentAt) } })
  let listed = 0
  const terminals = f.io.terminals
  f.io.terminals = async () => {
    listed += 1
    return terminals()
  }
  await tick([old], f.io, newMemory(), ended + limits.lateReportMs)
  assert.deepEqual([old.history[0], listed], [noLine, 0])
  // A record that says nothing is missing is left alone, whatever is on screen.
  const whole = sched({ report: true, history: [{ at: ended, status: 'done', tookMs: 4 * min }] })
  await tick([whole], fakeIo({ screens: { h1: line(sentAt) } }).io, newMemory(), ended + min)
  assert.equal(whole.history[0].status, 'done')
  // Its terminal is closed — nothing to read.
  const closed = sched({ report: true, history: [noLine] })
  await tick([closed], fakeIo({ live: [], screens: { h1: line(sentAt) } }).io, newMemory(), ended + min)
  assert.deepEqual(closed.history[0], noLine)
})

test('a send that throws counts as failed — the prompt is not typed again on the next check', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  let tries = 0
  f.io.send = async () => {
    tries++
    throw new Error('boom')
  }
  const r = await tick([s], f.io, newMemory(), nine + 10_000)
  assert.equal(tries, 1)
  assert.equal(s.pendingSince, null, 'no longer waiting to go out')
  assert.equal(s.sentAt, null)
  assert.equal(s.lastStatus, 'failed')
  assert.deepEqual(s.history[0].note, { code: 'sendFailed', detail: 'boom' })
  assert.ok(r.notices.some((n) => n.status === 'failed'), 'and a person is told')
  await tick([s], f.io, newMemory(), nine + 40_000)
  assert.equal(tries, 1, 'nobody saw how it ended — typed again, the prompt could run twice')

  // The same for the /clear that goes first.
  const c = sched({ nextRunAt: nine, clearFirst: true })
  await tick([c], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(c.history[0].note, { code: 'clearFailed', detail: 'boom' })
  assert.equal(c.pendingSince, null)
})

test('one schedule whose check throws is logged, and the others still go out', async () => {
  const bad = sched({ id: 'bad', name: 'Broken', nextRunAt: nine })
  Object.defineProperty(bad, 'clearFirst', {
    get() {
      throw new Error('boom')
    }
  })
  const good = sched({ id: 'good', name: 'Evening', nextRunAt: nine, terminal: { ...sched().terminal, handle: 'h2', leafId: 'leaf2', tabId: 'tab2' } })
  const f = fakeIo({ live: [term(), term({ handle: 'h2', leafId: 'leaf2', tabId: 'tab2' })], screens: { h1: idle, h2: idle } })
  const r = await tick([bad, good], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.sent, [['h2', 'Plan the day']], 'the one after it is not skipped')
  assert.ok(r.log.includes('Broken: check failed — boom'))
  assert.equal(bad.pendingSince, nine, 'still waiting — tried again at the next check')
})

test('a terminal list that throws is a wait, like one that could not be read', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  f.io.terminals = async () => {
    throw new Error('list broke')
  }
  const r = await tick([s], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(s.waitNote, { code: 'cli' })
  assert.ok(r.log.includes('terminal list failed — list broke'))
  assert.deepEqual(f.sent, [])
})
