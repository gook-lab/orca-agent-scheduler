import { assert, test } from 'orca/testing'
import { aliveFrom, findCli, launchArgs, launchedFrom, parseCli } from './cli'

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

test('agent launch 결과 — 글이 터미널에 넘어갔을 때만 성공', () => {
  const ok = { ok: true as const, result: { outcome: { kind: 'terminal', handle: 'term_1' }, prompt: { delivery: 'submit', outcome: 'handed-to-terminal' } } }
  assert.deepEqual(launchedFrom(ok), { terminalId: 'term_1' })
  const noPrompt = { ok: true as const, result: { outcome: { kind: 'terminal', handle: 'term_1' }, prompt: { outcome: 'dropped' } } }
  assert.match((launchedFrom(noPrompt) as { error: string }).error, /글이 들어가지 않음\(dropped\)/)
  const chat = { ok: true as const, result: { outcome: { kind: 'chat' } } }
  assert.match((launchedFrom(chat) as { error: string }).error, /터미널을 받지 못함\(chat\)/)
  assert.deepEqual(launchedFrom({ ok: false, error: 'selector_not_found' }), { error: 'selector_not_found' })
})

test('터미널 목록 — handle 모음, 못 읽으면 모름(null)', () => {
  assert.deepEqual([...(aliveFrom({ ok: true, result: { terminals: [{ handle: 'a' }, { handle: 'b' }] } }) ?? [])], ['a', 'b'])
  assert.equal(aliveFrom({ ok: false, error: 'x' }), null)
  assert.equal(aliveFrom({ ok: true, result: {} }), null)
})

test('띄우기 인자 — 터미널로, 고른 워크스페이스에, 글 그대로', () => {
  assert.deepEqual(launchArgs('folder:abc', 'codex', "따옴표 ' 와 $HOME 도 그대로"), [
    'agent',
    'launch',
    '--agent',
    'codex',
    '--surface',
    'terminal',
    '--worktree',
    'folder:abc',
    '--prompt',
    "따옴표 ' 와 $HOME 도 그대로"
  ])
})
