import { assert, test } from 'orca/testing'
import { cliRunner, findCli, holdAgents, parseCli, sendArgs, sentFrom, terminalsFrom } from './cli'
import type { LiveTerminal } from './engine'

test('실행 중인 Orca 앱 안의 CLI 를 찾는다 — PATH 의 다른 판 대신', () => {
  const helper = '/Applications/Orca 2.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
  assert.equal(findCli(helper, () => true), '/Applications/Orca 2.app/Contents/Resources/bin/orca')
  assert.equal(findCli(helper, () => false), null, '파일이 없으면 null')
  assert.equal(findCli('/opt/homebrew/bin/node', () => true), null, '앱 밖 Node 면 null')
})

test('CLI 출력 해석 — 성공, 오류 메시지, 읽을 수 없는 출력', () => {
  assert.deepEqual(parseCli('{"ok":true,"result":{"a":1}}', null), { ok: true, result: { a: 1 } })
  assert.deepEqual(parseCli('{"ok":false,"error":{"code":"selector_not_found","message":"selector_not_found"}}', new Error('exit 1')), {
    ok: false,
    error: 'selector_not_found'
  })
  assert.deepEqual(parseCli('', new Error('spawn ENOENT')), { ok: false, error: 'spawn ENOENT' })
})

test('terminal list → terminals that take input, with agent and pane', () => {
  const r = {
    ok: true as const,
    result: {
      terminals: [
        { handle: 'term_a', title: 'Morning', agentIdentity: 'claude', worktreeId: 'repo::/x/docs', tabId: 't1', leafId: 'l1', lastOutputAt: 1000, writable: true },
        { handle: 'term_b', title: 'Shell', worktreeId: 'folder:1', tabId: 't2', leafId: 'l2', writable: true },
        { handle: 'term_c', title: 'Read only', agentIdentity: 'codex', worktreeId: 'folder:1', tabId: 't3', leafId: 'l3', writable: false }
      ]
    }
  }
  assert.deepEqual(terminalsFrom(r), [
    { handle: 'term_a', title: 'Morning', agent: 'claude', workspaceId: 'repo::/x/docs', tabId: 't1', leafId: 'l1', lastOutputAt: 1000 },
    { handle: 'term_b', title: 'Shell', agent: null, workspaceId: 'folder:1', tabId: 't2', leafId: 'l2', lastOutputAt: null }
  ])
  assert.equal(terminalsFrom({ ok: false, error: 'x' }), null, 'unknown when the CLI fails')
  assert.equal(terminalsFrom({ ok: true, result: {} }), null)
})

test('send — text as is, Enter, wait up to 8 s for the turn to start', () => {
  assert.deepEqual(sendArgs('term_a', "quotes ' and $HOME stay"), [
    'terminal',
    'send',
    '--terminal=term_a',
    "--text=quotes ' and $HOME stay",
    '--enter',
    '--wait-submit',
    '8'
  ])
  assert.deepEqual(sentFrom({ ok: true, result: { send: { prompt: { stages: ['input_accepted', 'submitted', 'turn_started'] } } } }), { started: true })
  assert.deepEqual(sentFrom({ ok: true, result: { send: { prompt: { stages: ['input_accepted'] } } } }), { started: false })
  assert.deepEqual(sentFrom({ ok: true, result: {} }), { started: false })
  assert.deepEqual(sentFrom({ ok: false, error: 'terminal_handle_stale' }), { error: 'terminal_handle_stale' })
})

test('a blink in the agent is held for a while by pane — not for a terminal never seen with one', () => {
  const t = (agent: string | null, handle = 'h1', leafId = 'l1'): LiveTerminal => ({ handle, title: 'x', agent, workspaceId: 'w', tabId: 't', leafId, lastOutputAt: null })
  const seen = new Map<string, { agent: string; at: number }>()
  const agents = (list: LiveTerminal[]) => list.map((x) => x.agent)
  assert.deepEqual(agents(holdAgents([t('claude'), t(null, 'h9', 'l9')], seen, 0, 60_000)), ['claude', null], 'a plain shell stays a shell')
  assert.deepEqual(agents(holdAgents([t(null)], seen, 2_000, 60_000)), ['claude'], 'gone for a second — still Claude Code')
  assert.deepEqual(agents(holdAgents([t(null, 'h2')], seen, 50_000, 60_000)), ['claude'], 'by pane, though the handle changed')
  assert.deepEqual(agents(holdAgents([t(null)], seen, 61_000, 60_000)), [null], 'gone longer than that — the agent has quit')
  assert.deepEqual(agents(holdAgents([t('codex')], seen, 62_000, 60_000)), ['codex'], 'what Orca says now wins')
})

test('send — a prompt that starts with -- stays the text, not another flag', () => {
  // Given apart from --text, the CLI reads it as a flag: "Unknown flag", or its help for --help (Orca 1.4.261).
  for (const text of ['--- weekly check ---', '--help', '--terminal=term_b', '--enter']) {
    assert.deepEqual(sendArgs('term_a', text), ['terminal', 'send', '--terminal=term_a', `--text=${text}`, '--enter', '--wait-submit', '8'], 'never an argument of its own')
  }
})

test('an ok answer in a shape this version does not know: a send is still a send, a list is "could not read"', () => {
  assert.deepEqual(sentFrom({ ok: true, result: undefined }), { started: false }, 'no result at all')
  assert.deepEqual(sentFrom({ ok: true, result: null }), { started: false })
  assert.deepEqual(sentFrom({ ok: true, result: { send: {} } }), { started: false })
  assert.equal(terminalsFrom({ ok: true, result: undefined }), null)
  assert.equal(terminalsFrom({ ok: true, result: { terminals: 'none' } }), null, 'not a list')
  assert.deepEqual(
    terminalsFrom({ ok: true, result: { terminals: [null, 7, { handle: 5 }, { handle: '' }, { handle: 'h1' }] } })?.map((t) => t.handle),
    ['h1'],
    'entries without a handle are passed over'
  )
})

test('a call the system will not start is a failed call, not a rejected promise', async () => {
  // A NUL in an argument makes execFile throw before anything runs.
  const r = await cliRunner('/bin/echo')(['terminal', 'send', '--text=a\0b'])
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /null bytes/)
})
