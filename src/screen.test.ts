import { assert, test } from 'orca/testing'
import { agentKind, permissionPrompt, promptState } from './screen'

const rule = '──────────────────────────────'

test('Claude Code 입력 칸', () => {
  assert.equal(promptState(['끝', rule, '❯', rule, '  ⏵⏵ bypass']), 'empty')
  assert.equal(promptState([rule, '❯ 지난 24시간 에러', rule]), 'typing')
  assert.equal(promptState([rule, '❯ Try "edit 254.html"', rule]), 'empty')
  assert.equal(promptState(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), 'unknown')
  assert.equal(promptState([]), 'unknown')
})

// Codex 0.166 실화면(2026-11-13) — 지나간 사용자 글도 › 로 시작한다
const codexIdle = [
  '› Claude입니다. 대기해 주세요.',
  '  Worked for 3s • 2:28 PM',
  '  ↳ Recap: 완료했습니다.',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol low · ~/sonix/toy · 토이 섹션 교차 검토',
  '  ? for shortcuts                                         ⚠ 1 warning · f2 to view',
  ''
]

test('Codex 입력 칸', () => {
  assert.equal(promptState(codexIdle, 'codex'), 'empty')
  assert.equal(promptState(codexIdle, 'claude'), 'unknown')
  const typed = [...codexIdle]
  typed[3] = '› 오늘 에러 정리해 줘'
  assert.equal(promptState(typed, 'codex'), 'typing')
  const ask = [
    '  Would you like to run the following command?',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again for this command in this session (p)',
    '  3. No, and tell Codex what to do differently (esc)'
  ]
  assert.equal(promptState(ask, 'codex'), 'unknown')
  assert.ok(permissionPrompt(ask))
  assert.ok(!permissionPrompt(codexIdle))
})

test('Gemini CLI 입력 칸', () => {
  const box = '╭──────────────────────────────╮'
  const end = '╰──────────────────────────────╯'
  assert.equal(promptState([box, '│ >   Type your message or @path/to/file  │', end, '~/x  no sandbox'], 'gemini'), 'empty')
  assert.equal(promptState([box, '│ > 정리해 줘          │', '│   둘째 줄           │', end], 'gemini'), 'typing')
  assert.equal(promptState([box, '│ !   Type your message or @path/to/file  │', end], 'gemini'), 'unknown')
  assert.equal(promptState(['> 지난 글', '✦ 답'], 'gemini'), 'unknown')
  assert.ok(permissionPrompt(['│ Allow execution?   │', '│ ● Yes, allow once  │', '│ ○ No (esc)         │']))
})

test('에이전트 종류', () => {
  assert.equal(agentKind('codex'), 'codex')
  assert.equal(agentKind('Gemini'), 'gemini')
  assert.equal(agentKind(null), null)
  assert.equal(agentKind('opencode'), null)
})
