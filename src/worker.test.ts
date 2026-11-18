// Runs src/worker.ts against the same orca object Orca hands it (a fake host).
import { mock } from 'node:test'
import { afterEach, assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { CliResult } from './cli'
import { blankSchedule, limits, type Schedule } from './engine'
import { importedId } from './orcacron'
import type { ImportList, RunnerStatus, TerminalOption } from './protocol'
import { reportToken } from './report'
import * as main from './worker'

const rule = '──────────────────────────────'
const idle = ['⏺ done', rule, '❯ ', rule]
const old = Date.now() - 10 * 60_000

/** A fake Orca CLI — two agent terminals and a shell; sends start a turn. Collects the arguments. */
function fakeCli(over: { send?: CliResult; list?: CliResult } = {}) {
  const calls: string[][] = []
  main.cli.run = async (args): Promise<CliResult> => {
    calls.push(args)
    if (args[1] === 'send') return over.send ?? { ok: true, result: { send: { prompt: { stages: ['input_accepted', 'turn_started'] } } } }
    return (
      over.list ?? {
        ok: true,
        result: {
          terminals: [
            { handle: 'h1', title: 'Morning', agentIdentity: 'claude', worktreeId: 'w1', tabId: 't1', leafId: 'l1', lastOutputAt: old, writable: true },
            { handle: 'h2', title: 'Review', agentIdentity: 'codex', worktreeId: 'repo::/x/toy', tabId: 't2', leafId: 'l2', lastOutputAt: old, writable: true },
            { handle: 'h3', title: 'zsh', worktreeId: 'w1', tabId: 't3', leafId: 'l3', writable: true }
          ]
        }
      }
    )
  }
  return calls
}

function host(storage: Record<string, unknown> = {}, lines: string[] = idle) {
  return mockHost({
    storage: storage as never,
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'acme_notes', path: '/repo/docs', branch: 'main', hostId: null }],
        truncated: false
      },
      'terminal.read': { lines, truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
}

const terminal = { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'acme_notes', tabId: 't1', leafId: 'l1' }
const draft = { name: 'Morning report', terminal, cron: '0 9 * * 1-5', prompt: 'Plan the day', enabled: true, clearFirst: false }
const settle = () => new Promise((r) => setTimeout(r, 50))
/** What each send typed — the value of its `--text=`. */
const sentText = (calls: string[][]): string[] => calls.filter((c) => c[1] === 'send').map((c) => c[3].slice('--text='.length))

// A failed assertion skips the test's own deactivate — stop the 30-second timer anyway, or Node never exits.
const realOrcaCron = { ...main.orcaCron }
afterEach(() => {
  main.deactivate()
  main.cli.run = null
  Object.assign(main.orcaCron, realOrcaCron)
})

test('saving fills the next run, stores it and tells the panel', async () => {
  fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const saved = (await worker.request('schedules.save', draft)) as Schedule
  assert.ok(saved.id)
  assert.ok(saved.nextRunAt && saved.nextRunAt > Date.now())
  const stored = h.data().storage.schedules as Schedule[]
  assert.equal(stored.length, 1)
  assert.deepEqual(stored[0].terminal, terminal)
  assert.ok(worker.posts.some((p) => p.event === 'schedules.changed'))
  assert.ok(h.callsOf('statusBar.update').length > 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('bad schedules are refused with the reason, in the chosen language', async () => {
  fakeCli()
  for (const [lang, expect] of [
    ['en', [/name/, /terminal/, /prompt/, /never runs/]],
    ['ko', [/이름/, /터미널/, /보낼 글/, /앞으로 돌지 않/]]
  ] as const) {
    const worker = await mountWorker(main, { host: host(lang === 'ko' ? { lang: 'ko' } : {}) })
    const bad = [
      { ...draft, name: ' ' },
      { ...draft, terminal: { ...terminal, agent: 'aider' } },
      { ...draft, prompt: '' },
      { ...draft, cron: '0 9 31 2 *' }
    ]
    for (let i = 0; i < bad.length; i++) await assert.rejects(worker.request('schedules.save', bad[i]), expect[i])
    await worker.deactivate()
  }
})

test('toggle, edit, delete', async () => {
  fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  const off = (await worker.request('schedules.toggle', { id: s.id, enabled: false })) as Schedule
  assert.equal(off.enabled, false)
  assert.equal(off.nextRunAt, null)
  const edited = (await worker.request('schedules.save', { ...draft, id: s.id, name: 'Renamed', enabled: false, clearFirst: true })) as Schedule
  assert.equal(edited.id, s.id)
  assert.equal(edited.clearFirst, true)
  assert.equal((h.data().storage.schedules as Schedule[]).length, 1)
  await worker.request('schedules.delete', { id: s.id })
  assert.equal((h.data().storage.schedules as Schedule[]).length, 0)
  await assert.rejects(worker.request('schedules.toggle', { id: 'none', enabled: true }), /No such schedule/)
  await worker.deactivate()
})

test('the panel gets the agent terminals of every workspace — no shells, workspace names filled in', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: host() })
  const list = (await worker.request('terminals.list')) as TerminalOption[]
  assert.deepEqual(
    list.map((t) => [t.handle, t.agent, t.title, t.workspace]),
    [
      ['h1', 'claude', 'Morning', 'acme_notes'],
      ['h2', 'codex', 'Review', 'toy']
    ]
  )
  await worker.deactivate()
})

test('send now — goes into the chosen terminal through the Orca CLI once it is idle', async () => {
  const calls = fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.deepEqual(
    calls.filter((c) => c[1] === 'send'),
    [['terminal', 'send', '--terminal=h1', '--text=Plan the day', '--enter', '--wait-submit', '8']]
  )
  const stored = (h.data().storage.schedules as Schedule[])[0]
  assert.ok(stored.sentAt)
  assert.equal(stored.lastStatus, 'sent')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  main.cli.run = null
})

test('send now while that schedule\'s run is going does not queue a second send', async () => {
  const calls = fakeCli()
  const going: Schedule = { ...blankSchedule('s1'), ...draft, sentAt: Date.now() - 5000, lastStatus: 'sent' }
  const h = host({ schedules: [going] })
  const worker = await mountWorker(main, { host: h })
  await worker.request('schedules.runNow', { id: 's1' })
  await settle()
  assert.equal((h.data().storage.schedules as Schedule[])[0].pendingSince, null)
  assert.deepEqual(sentText(calls), [])
  await worker.deactivate()
  main.cli.run = null
})

/** Runs with the limits for a run asked for by hand shrunk, so a test need not wait real seconds. */
async function quickAsked(fn: () => Promise<void>): Promise<void> {
  const kept = { quiet: limits.askedQuietMs, check: limits.askedCheckMs }
  limits.askedQuietMs = 300
  limits.askedCheckMs = 100
  try {
    await fn()
  } finally {
    limits.askedQuietMs = kept.quiet
    limits.askedCheckMs = kept.check
  }
}
/** One agent terminal that printed at `at`. */
const printedAt = (at: number): CliResult => ({
  ok: true,
  result: { terminals: [{ handle: 'h1', title: 'Morning', agentIdentity: 'claude', worktreeId: 'w1', tabId: 't1', leafId: 'l1', lastOutputAt: at, writable: true }] }
})
const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
const status = (state: 'working' | 'done') => ({ workspaceId: null, paneKey: 'p', terminalId: 'h1', state, receivedAt: Date.now() })

test('send now on a resting terminal that just printed — looked at again within seconds, not at the next 30-second check', () =>
  quickAsked(async () => {
    const calls = fakeCli({ list: printedAt(Date.now()) })
    const h = host()
    const worker = await mountWorker(main, { host: h })
    const s = (await worker.request('schedules.save', draft)) as Schedule
    await worker.request('schedules.runNow', { id: s.id })
    await settle()
    assert.deepEqual(sentText(calls), [], 'the screen printed a moment ago')
    assert.deepEqual((h.data().storage.schedules as Schedule[])[0].waitNote, { code: 'moving' })
    await later(700)
    assert.deepEqual(sentText(calls), ['Plan the day'], 'sent once still for the shortened limit — the 30-second timer never fired here')
    await worker.deactivate()
  }))

test('Send once is asked for by hand as well', () =>
  quickAsked(async () => {
    const calls = fakeCli({ list: printedAt(Date.now()) })
    const worker = await mountWorker(main, { host: host() })
    await worker.request('schedules.save', { ...draft, name: '', once: true })
    await later(700)
    assert.deepEqual(sentText(calls), ['Plan the day'])
    await worker.deactivate()
  }))

test('a scheduled run held by the same screen keeps the 30-second pace and the full minute', () =>
  quickAsked(async () => {
    const calls = fakeCli({ list: printedAt(Date.now()) })
    const waiting: Schedule = { ...blankSchedule('s1'), ...draft, pendingSince: Date.now() }
    const worker = await mountWorker(main, { host: host({ schedules: [waiting] }) })
    await later(700)
    assert.deepEqual(sentText(calls), [])
    assert.equal(calls.filter((c) => c[1] === 'list').length, 2, 'one check: its read of the terminal list, and the one for the panel after it')
    await worker.deactivate()
  }))

test('send now behind a working agent goes out when the agent stops — its stop brings the next look', () =>
  quickAsked(async () => {
    const calls = fakeCli({ list: printedAt(Date.now()) })
    const h = host()
    const worker = await mountWorker(main, { host: h })
    const s = (await worker.request('schedules.save', draft)) as Schedule
    await worker.emit('agent.status.changed', status('working'))
    await worker.request('schedules.runNow', { id: s.id })
    await later(700)
    assert.deepEqual(sentText(calls), [], 'still for longer than the shortened limit, but the agent is working')
    assert.deepEqual((h.data().storage.schedules as Schedule[])[0].waitNote, { code: 'busy' })
    await worker.emit('agent.status.changed', status('done'))
    await later(200)
    assert.deepEqual(sentText(calls), ['Plan the day'])
    await worker.deactivate()
  }))

test('turning the plugin off stops the quick looks at a run asked for by hand', () =>
  quickAsked(async () => {
    // Never still for long enough here, so the run keeps waiting.
    limits.askedQuietMs = 60_000
    const calls = fakeCli({ list: printedAt(Date.now()) })
    const h = host()
    const worker = await mountWorker(main, { host: h })
    const s = (await worker.request('schedules.save', draft)) as Schedule
    await worker.request('schedules.runNow', { id: s.id })
    await later(350)
    const lists = () => calls.filter((c) => c[1] === 'list').length
    assert.deepEqual((h.data().storage.schedules as Schedule[])[0].waitNote, { code: 'moving' })
    assert.ok(lists() >= 6, `looked again every 100 ms while it waited (${lists()} reads of the terminal list)`)
    await worker.deactivate()
    const before = lists()
    await later(350)
    assert.equal(lists(), before)
  }))

test('a check still running when the plugin is turned off does not start the quick looks again', () =>
  quickAsked(async () => {
    limits.askedQuietMs = 60_000
    let lists = 0
    let hold = false
    const held: (() => void)[] = []
    const answer = printedAt(Date.now())
    main.cli.run = (args) => {
      if (args[1] !== 'list') return Promise.resolve({ ok: true, result: {} })
      lists++
      return hold ? new Promise((resolve) => held.push(() => resolve(answer))) : Promise.resolve(answer)
    }
    const worker = await mountWorker(main, { host: host() })
    const s = (await worker.request('schedules.save', draft)) as Schedule
    await worker.request('schedules.runNow', { id: s.id })
    await settle()
    hold = true
    await later(150)
    assert.equal(held.length, 1, 'the next quick look is reading the terminal list')
    await worker.deactivate()
    hold = false
    for (const go of held.splice(0)) go()
    await later(50)
    const before = lists
    await later(350)
    assert.equal(lists, before)
  }))

test('a sent run ends when the agent works and stops', async () => {
  fakeCli()
  const sent: Schedule = { ...blankSchedule('s1'), ...draft, sentAt: Date.now() - 60_000, lastStatus: 'sent' }
  const h = host({ schedules: [sent] })
  const worker = await mountWorker(main, { host: h })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 'h1', state: 'working', receivedAt: Date.now() })
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'p',
    terminalId: 'h1',
    state: 'done',
    receivedAt: Date.now(),
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: Date.now() }
  })
  const stored = h.data().storage.schedules as Schedule[]
  assert.equal(stored[0].sentAt, null)
  assert.equal(stored[0].history[0].status, 'success')
  assert.ok(worker.logs.includes('Morning report: success (agent done)'), 'the log says the agent\'s event ended it')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a run stopped at a question dialog is held and announced in the chosen language', async () => {
  for (const [lang, text] of [
    ['en', /permission or question dialog/],
    ['ko', /권한·질문 창/]
  ] as const) {
    fakeCli()
    const sent: Schedule = { ...blankSchedule('s1'), ...draft, sentAt: Date.now() - 60_000, sawWorking: true, lastStatus: 'sent' }
    const h = mockHost({
      storage: { schedules: [sent], lang } as never,
      results: {
        'terminal.read': { lines: ['  1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel'], truncated: false },
        'statusBar.update': { ok: true },
        'notifications.show': { delivered: true }
      }
    })
    const worker = await mountWorker(main, { host: h })
    await settle()
    await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 'h1', state: 'done', receivedAt: Date.now() })
    const stored = h.data().storage.schedules as Schedule[]
    assert.ok(stored[0].sentAt, 'not ended')
    assert.equal(stored[0].history.length, 0)
    assert.deepEqual(stored[0].blocked, { code: 'person' })
    const shown = h.callsOf('notifications.show') as { title: string; body: string }[]
    assert.equal(shown.length, 1)
    assert.equal(shown[0].title, 'Agent Scheduler')
    assert.match(shown[0].body, text)
    await worker.deactivate()
  }
})

test('a run caught up after its time is announced with how late it went out, in the chosen language', async () => {
  for (const [lang, text] of [
    ['en', 'Morning report: sent 2 h 0 min late'],
    ['ko', 'Morning report: 2시간 0분 늦게 보냄']
  ] as const) {
    fakeCli()
    const missed: Schedule = { ...blankSchedule('s1'), ...draft, nextRunAt: Date.now() - 2 * 3600_000 }
    const h = host({ schedules: [missed], lang })
    const worker = await mountWorker(main, { host: h })
    await settle()
    const stored = h.data().storage.schedules as Schedule[]
    assert.ok(stored[0].sentAt, 'sent at the first check')
    assert.deepEqual(
      (h.callsOf('notifications.show') as { body: string }[]).map((n) => n.body),
      [text]
    )
    await worker.deactivate()
    main.cli.run = null
  }
})

test('the status bar follows the language and flags waits a person must fix', async () => {
  fakeCli({ list: { ok: true, result: { terminals: [] } } })
  const due: Schedule = { ...blankSchedule('s1'), ...draft, pendingSince: Date.now() - 60_000 }
  const h = host({ schedules: [due], lang: 'ko' })
  const worker = await mountWorker(main, { host: h })
  await settle()
  const bars = h.callsOf('statusBar.update') as { text: string; tone: string; tooltip: string }[]
  const last = bars[bars.length - 1]
  assert.equal(last.text, '예약 1개 확인 필요')
  assert.equal(last.tone, 'warning')
  assert.match(last.tooltip, /터미널이 열려 있지 않음/)
  await worker.deactivate()
})

test('older stored shapes load — legacy fields dropped, unknown statuses and notes cleared', () => {
  const legacy = {
    id: 's-old',
    name: 'Old',
    workspaceId: 'w1',
    workspace: 'docs',
    agent: 'codex',
    terminalId: 'term_x',
    delivered: true,
    cron: '0 9 * * *',
    prompt: 'x',
    enabled: true,
    waitNote: '지난 회차가 아직 실행 중',
    lastStatus: '성공',
    history: [{ at: 1, status: '성공', summary: '걸린 시간 3분' }]
  }
  const [s] = main.normalize([legacy, 'junk', { noId: true }])
  assert.equal(s.id, 's-old')
  assert.equal(s.terminal.handle, '')
  assert.equal(s.waitNote, null)
  assert.equal(s.lastStatus, null)
  assert.deepEqual(s.history, [])
  assert.equal('workspaceId' in s, false)
  assert.equal('delivered' in s, false)
  assert.equal(main.normalize([legacy, 'junk', { noId: true }]).length, 1)
})

test('send once — saved without a name, sent right away into that terminal', async () => {
  const calls = fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', { ...draft, name: '', once: true, prompt: 'Summarise the open PRs\nthen stop' })) as Schedule
  assert.equal(s.once, true)
  assert.equal(s.cron, '', 'no times, whatever cron the draft carried')
  assert.equal(s.name, 'Summarise the open PRs', 'named from the first line')
  assert.equal(s.nextRunAt, null)
  await settle()
  assert.deepEqual(
    calls.filter((c) => c[1] === 'send').map((c) => c[2]),
    ['--terminal=h1']
  )
  // A schedule (not a one-off send) still needs a name.
  await assert.rejects(worker.request('schedules.save', { ...draft, name: '' }), /name/)
  await worker.deactivate()
  main.cli.run = null
})

test('finished one-off sends are kept up to ONCE_KEEP', async () => {
  fakeCli()
  const old = Array.from({ length: main.ONCE_KEEP + 2 }, (_, i) => ({
    ...blankSchedule(`o${i}`),
    ...draft,
    once: true,
    cron: '',
    history: [{ at: 1000 + i, status: 'done' as const }]
  }))
  const h = host({ schedules: old })
  const worker = await mountWorker(main, { host: h })
  await worker.request('schedules.save', { ...draft, once: true, cron: '' })
  const stored = h.data().storage.schedules as Schedule[]
  const finished = stored.filter((s) => s.once && s.history.length > 0)
  assert.equal(finished.length, main.ONCE_KEEP)
  assert.equal(finished.some((s) => s.id === 'o0' || s.id === 'o1'), false, 'the oldest two dropped')
  assert.equal(stored.filter((s) => s.once && s.history.length === 0).length, 1, 'the new one stays')
  await worker.deactivate()
  main.cli.run = null
})

test('undo — a deleted schedule comes back with its next run', async () => {
  fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  await worker.request('schedules.delete', { id: s.id })
  const back = (await worker.request('schedules.restore', { schedule: s })) as Schedule
  assert.equal(back.id, s.id)
  assert.ok(back.nextRunAt && back.nextRunAt > Date.now())
  assert.equal((h.data().storage.schedules as Schedule[]).length, 1)
  await worker.request('schedules.restore', { schedule: s })
  assert.equal((h.data().storage.schedules as Schedule[]).length, 1, 'restoring twice adds nothing')
  await worker.deactivate()
  main.cli.run = null
})

test('focus — brings Orca to the terminal with the CLI', async () => {
  const calls = fakeCli()
  const worker = await mountWorker(main, { host: host() })
  const r = (await worker.request('terminals.focus', { handle: 'h2' })) as { ok: boolean }
  assert.equal(r.ok, true)
  assert.deepEqual(calls.find((c) => c[1] === 'switch'), ['terminal', 'switch', '--terminal=h2'])
  await worker.deactivate()
  main.cli.run = null
})

test('the worker says whether it found the Orca CLI; without it no terminal is listed', async () => {
  fakeCli()
  let worker = await mountWorker(main, { host: host() })
  assert.equal(((await worker.request('runner.status')) as RunnerStatus).cli, true)
  await worker.deactivate()
  // No fake CLI, and the test's Node is not inside an Orca app — as on Windows or Linux, where there is
  // no <app>/Contents/Resources/bin/orca next to the worker.
  main.cli.run = null
  worker = await mountWorker(main, { host: host() })
  assert.equal(((await worker.request('runner.status')) as RunnerStatus).cli, false)
  assert.deepEqual(await worker.request('terminals.list'), [])
  await worker.deactivate()
})

test('the terminal list is pushed to the panel after a check, and only when it changes', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: host() })
  await settle()
  const pushes = () => worker.posts.filter((p) => p.event === 'terminals.changed')
  assert.equal(pushes().length, 1)
  assert.deepEqual(
    (pushes()[0].payload as { terminals: TerminalOption[] }).terminals.map((t) => t.handle),
    ['h1', 'h2']
  )
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 'h1', state: 'working', receivedAt: Date.now() })
  await worker.request('schedules.runNow', { id: ((await worker.request('schedules.save', draft)) as Schedule).id })
  await settle()
  assert.equal(pushes().length, 1, 'same list — not pushed again')
  await worker.deactivate()
  main.cli.run = null
})

test('a terminal whose agent blinks out for a moment stays in the panel list', async () => {
  let blink = false
  main.cli.run = async (args): Promise<CliResult> => {
    if (args[1] !== 'list') return { ok: false, error: 'unused' }
    return {
      ok: true,
      result: { terminals: [{ handle: 'h1', title: 'Morning', worktreeId: 'w1', tabId: 't1', leafId: 'l1', writable: true, ...(blink ? {} : { agentIdentity: 'claude' }) }] }
    }
  }
  const worker = await mountWorker(main, { host: host() })
  const handles = async () => ((await worker.request('terminals.list')) as TerminalOption[]).map((t) => [t.handle, t.agent])
  assert.deepEqual(await handles(), [['h1', 'claude']])
  blink = true
  assert.deepEqual(await handles(), [['h1', 'claude']], 'Orca lost the agent for a second — the form still finds the terminal')
  await worker.deactivate()
})

test('a schedule saved with the result option sends the ask, and the line on screen ends up in its record and its failure notice', async () => {
  const calls = fakeCli()
  const h0 = host()
  const w0 = await mountWorker(main, { host: h0 })
  const saved = (await w0.request('schedules.save', { ...draft, report: true })) as Schedule
  assert.equal(saved.report, true)
  await w0.request('schedules.runNow', { id: saved.id })
  await settle()
  const text = sentText(calls)[0] ?? ''
  assert.match(text, /^Plan the day When you finish, end your reply with one line in this form: \[result \w{4} STATUS\]/)
  const sentAt = (h0.data().storage.schedules as Schedule[])[0].sentAt as number
  assert.ok(text.includes(`[result ${reportToken(sentAt)} STATUS]`), 'the tag sent is the tag read for')
  await w0.deactivate()

  const running = h0.data().storage.schedules as Schedule[]
  const h = host({ schedules: running }, ['❯ Plan the day', `⏺ [result ${reportToken(sentAt)} failed] The build broke [link] https://example.com/run/7 [end]`, rule, '❯ ', rule])
  const worker = await mountWorker(main, { host: h })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 'h1', state: 'done', receivedAt: Date.now() })
  const done = (h.data().storage.schedules as Schedule[])[0]
  assert.equal(done.sentAt, null)
  assert.equal(done.history[0].status, 'failed')
  assert.equal(done.history[0].summary, 'The build broke')
  assert.equal(done.history[0].link, 'https://example.com/run/7')
  assert.deepEqual(
    (h.callsOf('notifications.show') as { body: string }[]).map((n) => n.body),
    ['Morning report: Failed — The build broke']
  )
  await worker.deactivate()
})

test('schedules stored before the result option load with it off', async () => {
  const [old] = main.normalize([{ id: 's1', name: 'Old', prompt: 'x' }])
  assert.equal(old.report, false)
  assert.equal(main.normalize([{ id: 's1', report: 'yes' }])[0].report, false)
  assert.equal(main.normalize([{ id: 's1', report: true }])[0].report, true)
})

const appFile = JSON.stringify({
  schedules: [
    { id: 'ledger', name: 'Ledger update', cron: '3 0,6,12,18 * * *', enabled: true, task: 'ledger', terminal: { handle: 'gone', label: 'Morning (then)', agent: 'claude', tabId: 't1', leafId: 'l1' } },
    { id: 'night', name: 'Night tidy', cron: '0 3 * * *', enabled: true, prompt: 'Tidy up', terminal: { handle: 'closed', label: 'Closed one', agent: 'codex' } },
    { id: 'odd', name: 'Odd times', cron: 'whenever', enabled: true, prompt: 'Hi', terminal: { handle: 'h1', label: 'Morning' } }
  ]
})

function fakeApp(text: string | null) {
  const asked: string[] = []
  main.orcaCron.dir = () => '/home/me/.orca-cron'
  main.orcaCron.read = (path) => {
    asked.push(path)
    return text
  }
  return asked
}

test("OrcaCron — its schedules are listed with their terminals matched to the open ones", async () => {
  fakeCli()
  const asked = fakeApp(appFile)
  const worker = await mountWorker(main, { host: host() })
  const list = (await worker.request('orcacron.list')) as ImportList
  assert.deepEqual(asked, ['/home/me/.orca-cron/schedules.json'])
  assert.equal(list.found, true)
  assert.equal(list.dir, '/home/me/.orca-cron')
  assert.deepEqual(
    list.items.map((i) => [i.id, i.open, i.imported, i.badCron]),
    [
      ['ledger', false, false, false],
      ['night', false, false, false],
      ['odd', true, false, true]
    ]
  )
  assert.equal(list.items[2].terminal.workspace, 'acme_notes', 'an open terminal comes with its workspace')
  assert.equal(list.items[0].terminal.title, 'Morning (then)', 'a terminal not found keeps the name the app knew it by')
  await worker.deactivate()
})

test('OrcaCron — importing adds them switched off, once; a schedule whose times cannot be read stays behind', async () => {
  fakeCli()
  fakeApp(appFile)
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const first = (await worker.request('orcacron.import', { ids: ['ledger', 'night', 'odd', 'nope'] })) as { added: number }
  assert.equal(first.added, 2)
  const stored = h.data().storage.schedules as Schedule[]
  assert.deepEqual(
    stored.map((s) => [s.id, s.enabled, s.nextRunAt, s.report]),
    [
      [importedId('ledger'), false, null, true],
      [importedId('night'), false, null, true]
    ]
  )
  assert.match(stored[0].prompt, /^\[예약 실행 · Ledger update\] 작업 파일 \/home\/me\/\.orca-cron\/tasks\/ledger\.md 을 읽고/)
  await settle()
  assert.equal((h.data().storage.schedules as Schedule[])[0].sentAt, null, 'switched off — nothing goes out')

  const again = (await worker.request('orcacron.import', { ids: ['ledger', 'night'] })) as { added: number }
  assert.equal(again.added, 0, 'already here')
  assert.equal((h.data().storage.schedules as Schedule[]).length, 2)
  const list = (await worker.request('orcacron.list')) as ImportList
  assert.deepEqual(
    list.items.map((i) => i.imported),
    [true, true, false]
  )
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('OrcaCron — without the app\'s data, or with a file that is not JSON, nothing is offered', async () => {
  fakeCli()
  fakeApp(null)
  const worker = await mountWorker(main, { host: host() })
  assert.deepEqual(await worker.request('orcacron.list'), { found: false, dir: '/home/me/.orca-cron', items: [] })
  fakeApp('{ not json')
  assert.deepEqual(await worker.request('orcacron.list'), { found: true, dir: '/home/me/.orca-cron', items: [] })
  assert.deepEqual(await worker.request('orcacron.import', { ids: ['ledger'] }), { added: 0 })
  await worker.deactivate()
})

test('stored entries this version cannot read are dropped field by field, not thrown on', () => {
  const [s] = main.normalize([
    {
      id: 's1',
      name: 7,
      cron: 5,
      prompt: null,
      enabled: 'yes',
      nextRunAt: 'soon',
      sentAt: Number.NaN,
      terminal: { handle: 42, title: 'Morning', leafId: null },
      history: [null, 'x', { at: 'then', status: 'done' }, { at: 1, status: 'done', tookMs: '3', note: 'old', summary: 9, link: 'https://example.com/a' }]
    }
  ])
  assert.deepEqual([s.name, s.cron, s.prompt, s.enabled, s.nextRunAt, s.sentAt], ['', '', '', true, null, null])
  assert.deepEqual([s.terminal.handle, s.terminal.title, s.terminal.leafId, s.terminal.agent], ['', 'Morning', '', 'claude'])
  assert.deepEqual(s.history, [{ at: 1, status: 'done', link: 'https://example.com/a' }])
})

test('one stored schedule whose times are not text does not stop the others from going out', async () => {
  const calls = fakeCli()
  const due = Date.now() - 1000
  const bad = { ...blankSchedule('bad'), name: 'Broken', terminal, cron: 5, prompt: 'Never' }
  const good = { ...blankSchedule('good'), name: 'Morning', terminal, cron: '0 9 * * *', prompt: 'Plan the day', nextRunAt: due }
  const h = host({ schedules: [bad, good] })
  const worker = await mountWorker(main, { host: h })
  await settle()
  assert.deepEqual(
    sentText(calls),
    ['Plan the day']
  )
  const stored = h.data().storage.schedules as Schedule[]
  assert.deepEqual(
    stored.map((s) => [s.id, s.cron, s.nextRunAt === null]),
    [
      ['bad', '', true],
      ['good', '0 9 * * *', false]
    ]
  )
  await worker.deactivate()
})

test('an OrcaCron file that lists one id twice adds one schedule', async () => {
  fakeCli()
  main.orcaCron.dir = () => '/home/me/.orca-cron'
  main.orcaCron.read = () =>
    JSON.stringify({
      schedules: [
        { id: 'dup', name: 'First', cron: '0 9 * * *', prompt: 'a', terminal: { handle: 'h1', label: 'Morning' } },
        { id: 'dup', name: 'Second', cron: '0 10 * * *', prompt: 'b', terminal: { handle: 'h1', label: 'Morning' } }
      ]
    })
  const h = host()
  const worker = await mountWorker(main, { host: h })
  assert.deepEqual(await worker.request('orcacron.import', { ids: ['dup'] }), { added: 1 })
  assert.deepEqual(
    (h.data().storage.schedules as Schedule[]).map((s) => [s.id, s.name]),
    [[importedId('dup'), 'First']]
  )
  await worker.deactivate()
})

test("only a plain file of a sane size is read from OrcaCron's folder", () => {
  const read = main.orcaCron.read
  assert.equal(read('/no/such/folder/schedules.json'), null)
  assert.equal(read('/'), null, 'a folder is not the file')
  // The program running this test is a plain file far past the limit. A pipe is turned away the same
  // way, before the read that would never return.
  assert.equal(read(process.execPath), null)
})

test('a stored link that is not a web link is dropped with the rest kept', () => {
  const [s] = main.normalize([{ id: 's1', history: [{ at: 1, status: 'success', summary: 'Done', link: 'javascript:alert(1)' }, { at: 0, status: 'success', link: 'https://a@b.example/' }] }])
  assert.deepEqual(s.history, [
    { at: 1, status: 'success', summary: 'Done' },
    { at: 0, status: 'success' }
  ])
})

/** A host whose storage can refuse writes. What it took is in `store`. */
function flakyHost() {
  const store: Record<string, unknown> = {}
  const state: { refuse: (value: unknown) => boolean } = { refuse: () => false }
  const h = mockHost({
    results: {
      'workspace.list': { workspaces: [], truncated: false },
      'terminal.read': { lines: idle, truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'storage.set': ({ key, value }: { key: string; value: unknown }) => {
        if (state.refuse(value)) throw hostError('unavailable', 'disk full')
        store[key] = value
        return { ok: true }
      }
    }
  })
  return { h, store, state }
}
const listed = async (worker: Awaited<ReturnType<typeof mountWorker>>): Promise<Schedule[]> => (await worker.request('schedules.list')) as Schedule[]

test('an edit storage refuses is not kept: trying again adds one schedule, and a toggle or delete goes back', async () => {
  fakeCli()
  const { h, store, state } = flakyHost()
  const worker = await mountWorker(main, { host: h })
  state.refuse = () => true
  await assert.rejects(worker.request('schedules.save', draft), /disk full/)
  assert.deepEqual(await listed(worker), [], 'the panel was told it failed, and it is not in the list')
  state.refuse = () => false
  const s = (await worker.request('schedules.save', draft)) as Schedule
  assert.equal((store.schedules as Schedule[]).length, 1, 'one schedule, not the refused one as well')
  assert.equal((await listed(worker)).length, 1)

  state.refuse = () => true
  await assert.rejects(worker.request('schedules.toggle', { id: s.id, enabled: false }), /disk full/)
  await assert.rejects(worker.request('schedules.delete', { id: s.id }), /disk full/)
  const [kept] = await listed(worker)
  assert.equal(kept.enabled, true, 'still on')
  assert.ok(kept.nextRunAt, 'with its next run')
  await worker.deactivate()
})

test('a write that fails after a send is tried again — the run stays known and nothing is sent twice', async () => {
  const calls = fakeCli()
  const { h, store, state } = flakyHost()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  const sent = (v: unknown): boolean => (v as Schedule[]).some((x) => x.sentAt !== null)
  state.refuse = sent
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.equal(sentText(calls).length, 1)
  assert.equal(sent(store.schedules), false, 'the write after the send was refused')
  assert.ok(worker.logs.includes('check failed: disk full'), 'and that is in the log')
  state.refuse = () => false
  // Any later write carries it: here the next press, which itself changes nothing.
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.equal(sent(store.schedules), true, 'stored now')
  assert.equal(sentText(calls).length, 1, 'and not sent a second time')
  await worker.deactivate()
})

/** Two Claude Code terminals — a schedule can be moved from one to the other. */
const twoClaude: CliResult = {
  ok: true,
  result: {
    terminals: [
      { handle: 'h1', title: 'Morning', agentIdentity: 'claude', worktreeId: 'w1', tabId: 't1', leafId: 'l1', lastOutputAt: old, writable: true },
      { handle: 'h4', title: 'Evening', agentIdentity: 'claude', worktreeId: 'w1', tabId: 't4', leafId: 'l4', lastOutputAt: old, writable: true }
    ]
  }
}
const evening = { handle: 'h4', title: 'Evening', agent: 'claude', workspaceId: 'w1', workspace: 'acme_notes', tabId: 't4', leafId: 'l4' }

test('a schedule whose run is going keeps its terminal — its end is read off the one it was sent to', async () => {
  fakeCli({ list: twoClaude })
  const worker = await mountWorker(main, { host: host() })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.ok((await listed(worker))[0].sentAt, 'running')
  await assert.rejects(worker.request('schedules.save', { ...draft, id: s.id, terminal: evening }), /still going/)
  const renamed = (await worker.request('schedules.save', { ...draft, id: s.id, name: 'Renamed' })) as Schedule
  assert.equal(renamed.name, 'Renamed', 'everything else can change meanwhile')
  const [now] = await listed(worker)
  assert.deepEqual(now.terminal, terminal)
  assert.ok(now.sentAt, 'and the run goes on')
  await worker.deactivate()
})

test('moved while it waits, a schedule starts over on the new terminal: /clear is typed there', async () => {
  const calls = fakeCli({ list: twoClaude })
  const worker = await mountWorker(main, { host: host() })
  const fresh = { ...draft, name: 'Fresh start', clearFirst: true }
  const s = (await worker.request('schedules.save', fresh)) as Schedule
  const sends = (): string[][] => calls.filter((x) => x[1] === 'send').map((x) => [x[2], x[3]])
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.deepEqual(sends(), [['--terminal=h1', '--text=/clear']], 'cleared; the prompt goes out on a later check')
  await worker.request('schedules.save', { ...fresh, id: s.id, terminal: evening })
  await worker.request('schedules.runNow', { id: s.id })
  await settle()
  assert.deepEqual(sends()[1], ['--terminal=h4', '--text=/clear'], 'the /clear typed into the old terminal says nothing about this one')
  await worker.deactivate()
})

test('a save reads its input as loosely as storage is read — a missing or mistyped field is a refusal, not a crash', async () => {
  fakeCli()
  const worker = await mountWorker(main, { host: host() })
  // The form's own wording, not a TypeError that happens to name the field.
  const save = (input: unknown): Promise<unknown> => worker.request('schedules.save', input as never)
  await assert.rejects(save(null), /^Error: Enter a name$/)
  await assert.rejects(save({ ...draft, name: 5 }), /^Error: Enter a name$/)
  await assert.rejects(save({ ...draft, terminal: 'h1' }), /^Error: Pick an agent terminal/)
  await assert.rejects(save({ ...draft, prompt: undefined }), /^Error: Enter the prompt to send$/)
  await assert.rejects(save({ ...draft, cron: 9 }), /^Error: This never runs again/)
  assert.deepEqual(await listed(worker), [])
  await worker.deactivate()
})

test('checks do not pile up behind a CLI call that hangs: one runs, one waits', async () => {
  let lists = 0
  const held: (() => void)[] = []
  main.cli.run = (args) => {
    if (args[1] !== 'list') return Promise.resolve({ ok: true, result: {} })
    lists++
    return new Promise((resolve) => held.push(() => resolve({ ok: true, result: { terminals: [] } })))
  }
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const waiting: Schedule = { ...blankSchedule('s1'), name: 'A', terminal, prompt: 'x', pendingSince: Date.now() }
    const worker = await mountWorker(main, { host: host({ schedules: [waiting] }) })
    await settle()
    assert.equal(lists, 1, 'the first check is reading the terminal list, and the CLI does not answer')
    // Two minutes of the 30-second timer.
    for (let i = 0; i < 4; i++) mock.timers.tick(main.TICK_MS)
    // Let everything through: each check reads the list once, and once more for the panel afterwards.
    for (let i = 0; i < 20 && (held.length > 0 || i < 3); i++) {
      for (const go of held.splice(0)) go()
      await settle()
    }
    assert.equal(lists, 4, 'two checks ran — the one that hung and one behind it — not five')
    await worker.deactivate()
  } finally {
    mock.timers.reset()
  }
})
