import { assert, test } from 'orca/testing'
import {
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
