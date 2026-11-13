// Runs src/worker.ts against the same orca object Orca hands it (a fake host).
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliResult } from './cli'
import { blankSchedule, type Schedule } from './engine'
import type { TerminalOption } from './protocol'
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

function host(storage: Record<string, unknown> = {}) {
  return mockHost({
    storage: storage as never,
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'sonix_docs', path: '/repo/docs', branch: 'main', hostId: null }],
        truncated: false
      },
      'terminal.read': { lines: idle, truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
}

const terminal = { handle: 'h1', title: 'Morning', agent: 'claude', workspaceId: 'w1', workspace: 'sonix_docs', tabId: 't1', leafId: 'l1' }
const draft = { name: 'Morning report', terminal, cron: '0 9 * * 1-5', prompt: 'Plan the day', enabled: true, clearFirst: false }
const settle = () => new Promise((r) => setTimeout(r, 50))

// A failed assertion skips the test's own deactivate — stop the 30-second timer anyway, or Node never exits.
afterEach(() => {
  main.deactivate()
  main.cli.run = null
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
      ['h1', 'claude', 'Morning', 'sonix_docs'],
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
    [['terminal', 'send', '--terminal', 'h1', '--text', 'Plan the day', '--enter', '--wait-submit', '8']]
  )
  const stored = (h.data().storage.schedules as Schedule[])[0]
  assert.ok(stored.sentAt)
  assert.equal(stored.lastStatus, 'sent')
  assert.deepEqual(worker.refusals, [])
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
    calls.filter((c) => c[1] === 'send').map((c) => c[3]),
    ['h1']
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
  assert.deepEqual(calls.find((c) => c[1] === 'switch'), ['terminal', 'switch', '--terminal', 'h2'])
  await worker.deactivate()
  main.cli.run = null
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
