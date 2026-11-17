import { assert, test } from 'orca/testing'
import { blankTerminal, locate } from './engine'
import { importedId, itemsFrom, scheduleFrom } from './orcacron'

const pane = { tabId: '0bcc01df-a3a1-4886-a143-e47e107c84d2', leafId: 'c0bcd570-9ecc-4966-b92f-6d3532a143e2' }
const file = {
  schedules: [
    { id: 'ledger', name: 'Ledger update', cron: '3 0,6,12,18 * * *', enabled: true, task: 'ledger', terminal: { handle: 'term_a', label: 'notes · ledger', agent: 'claude', ...pane }, lastSummary: 'old', history: [{ status: '성공' }] },
    { id: 'typed', name: 'Morning', cron: '0 9 * * 1-5', enabled: false, prompt: '  Plan the day  ', clearFirst: true, terminal: { handle: 'term_b', label: 'Morning', agent: 'codex', tabId: 'pty:1', leafId: 'pty:1' } },
    { id: 'cmd', name: 'Compact', cron: '0 3 * * *', enabled: true, prompt: '/compact', terminal: { handle: 'term_a', label: 'notes · ledger' } },
    { id: 'quiet', name: 'No result', cron: '0 4 * * *', enabled: true, prompt: 'Tidy up', track: false, terminal: { handle: 'term_a', label: 'notes · ledger' } },
    { id: 'odd', name: 'Odd times', cron: 'whenever', enabled: true, prompt: 'Hi', terminal: { handle: 'term_a', label: 'notes · ledger' } },
    { id: 'once', name: 'One-off', cron: '', enabled: true, prompt: 'Just once', oneShot: true, terminal: { handle: 'term_a', label: 'notes · ledger' } },
    { id: 'empty', name: 'Nothing to send', cron: '0 5 * * *', enabled: true, terminal: { handle: 'term_a', label: 'notes · ledger' } },
    'not a schedule'
  ]
}

test("OrcaCron's schedules come over as the app would send them, minus its finish command", () => {
  const items = itemsFrom(file, '/home/me/.orca-cron/tasks')
  assert.deepEqual(
    items.map((i) => i.id),
    ['ledger', 'typed', 'cmd', 'quiet', 'odd'],
    'one-off sends and ones with nothing to send stay behind'
  )
  const [ledger, typed, cmd, quiet, odd] = items
  assert.equal(
    ledger.prompt,
    '[예약 실행 · Ledger update] 작업 파일 /home/me/.orca-cron/tasks/ledger.md 을 읽고 그 절차대로 실행한다(파일의 「실행기 finish」 줄은 요약 문구 형식 안내로만 쓴다).'
  )
  assert.equal(ledger.report, true, 'the app asked for a result — this plugin asks in its own way')
  assert.deepEqual(ledger.terminal, { ...blankTerminal(), handle: 'term_a', title: 'notes · ledger', agent: 'claude', ...pane })
  assert.equal(typed.prompt, '[예약 실행 · Morning] Plan the day')
  assert.equal(typed.clearFirst, true)
  assert.deepEqual([typed.terminal.tabId, typed.terminal.leafId], ['', ''], 'pty:1-style ids do not name a terminal for good')
  assert.equal(typed.terminal.agent, 'codex')
  assert.deepEqual([cmd.prompt, cmd.report], ['/compact', false], 'a command goes out as it is')
  assert.deepEqual([quiet.prompt, quiet.report], ['Tidy up', false])
  assert.deepEqual([ledger.badCron, odd.badCron], [false, true])
})

test('anything that is not the app\'s file reads as no schedules', () => {
  for (const bad of [null, 'text', 42, {}, { schedules: 'none' }, []]) assert.deepEqual(itemsFrom(bad, '/t'), [])
})

test('the terminal is found open as a schedule finds its own — by handle, or by pane', () => {
  const [ledger, typed] = itemsFrom(file, '/t')
  const moved = { ...blankTerminal(), handle: 'term_new', title: 'now', ...pane }
  const other = { ...blankTerminal(), handle: 'term_x', title: 'other', tabId: pane.tabId, leafId: 'ffffffff-0000-4000-8000-000000000000' }
  assert.equal(locate(ledger.terminal, [other, moved]), moved, 'Orca restarted: a new handle, the same pane')
  assert.equal(locate(ledger.terminal, [other]), null, 'another pane of the same tab is not it')
  assert.equal(locate(typed.terminal, [{ ...blankTerminal(), handle: 'term_z', tabId: 'pty:1', leafId: 'pty:1' }]), null, 'a pty:1-style id was not kept, so it matches nothing by pane')
  assert.equal(locate({ ...blankTerminal() }, [{ ...blankTerminal() }]), null, 'an empty handle is no match')
})

test('an imported schedule arrives switched off, under an id that is the same every time', () => {
  const [ledger] = itemsFrom(file, '/t')
  const s = scheduleFrom(ledger, ledger.terminal)
  assert.equal(s.id, importedId('ledger'))
  assert.equal(s.enabled, false, 'the app still runs its copy — on here too, the prompt would go out twice')
  assert.deepEqual([s.name, s.cron, s.report, s.once, s.nextRunAt, s.history], ['Ledger update', '3 0,6,12,18 * * *', true, false, null, []])
})

test('an id listed twice comes over once — the first one', () => {
  const twice = {
    schedules: [
      { id: 'dup', name: 'First', cron: '0 9 * * *', prompt: 'a', terminal: { handle: 'term_a', label: 'Morning' } },
      { id: 'dup', name: 'Second', cron: '0 10 * * *', prompt: 'b', terminal: { handle: 'term_a', label: 'Morning' } }
    ]
  }
  assert.deepEqual(
    itemsFrom(twice, '/t').map((i) => [i.id, i.name]),
    [['dup', 'First']]
  )
})
