import { assert, test } from 'orca/testing'
import {
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

test('watch — a missed end event still reads the result line off the quiet screen', async () => {
  const sentAt = nine
  const s = sched({ report: true, sentAt, sawWorking: true })
  const f = fakeIo({
    live: [term({ lastOutputAt: sentAt + min })],
    screens: { h1: resultScreen(sentAt, '[result TAG failed] Could not reach the server [end]') }
  })
  const r = await tick([s], f.io, newMemory(), sentAt + 5 * min)
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, 'failed')
  assert.equal(s.history[0].summary, 'Could not reach the server')
  assert.deepEqual(s.history[0].note, { code: 'byScreen' })
  assert.deepEqual(r.notices, [{ name: 'Morning', status: 'failed', summary: 'Could not reach the server' }])
})

test('a run asked for a result that ends without the line says so in its record', async () => {
  const sentAt = nine
  // Ended by the quiet screen, no line on it.
  const quiet = sched({ report: true, sentAt, sawWorking: true })
  await tick([quiet], fakeIo({ live: [term({ lastOutputAt: sentAt + min })] }).io, newMemory(), sentAt + 5 * min)
  assert.deepEqual([quiet.history[0].status, quiet.history[0].note], ['done', { code: 'byScreen', reason: 'noLine' }])
  assert.equal(noteText('en', quiet.history[0].note!), 'by screen: no result line on screen')
  assert.equal(noteText('ko', quiet.history[0].note!), '화면 기준 화면에 결과 줄이 없음')

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
