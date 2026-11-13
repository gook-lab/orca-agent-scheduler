import { assert, test } from 'orca/testing'
import { findCli, parseCli, sendArgs, sentFrom, terminalsFrom } from './cli'

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
    '--terminal',
    'term_a',
    '--text',
    "quotes ' and $HOME stay",
    '--enter',
    '--wait-submit',
    '8'
  ])
  assert.deepEqual(sentFrom({ ok: true, result: { send: { prompt: { stages: ['input_accepted', 'submitted', 'turn_started'] } } } }), { started: true })
  assert.deepEqual(sentFrom({ ok: true, result: { send: { prompt: { stages: ['input_accepted'] } } } }), { started: false })
  assert.deepEqual(sentFrom({ ok: true, result: {} }), { started: false })
  assert.deepEqual(sentFrom({ ok: false, error: 'terminal_handle_stale' }), { error: 'terminal_handle_stale' })
})
