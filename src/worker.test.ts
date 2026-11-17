// Runs src/worker.ts against the same orca object Orca hands it (a fake host).
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliResult } from './cli'
import { blankSchedule, type Schedule } from './engine'
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
