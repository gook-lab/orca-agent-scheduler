import { assert, test } from 'orca/testing'
import { agentKind, permissionPrompt, promptState, promptVisible } from './screen'

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

test('Claude Code 질문 창 — 선택 안내 줄이 화면 끝에 있을 때만', () => {
  // 질문 도구 실화면(2026-11-13 실기 시험 3)
  const question = [
    '  1. 예',
    '  2. 아니오',
    '     아니오',
    '  3. Type something.',
    rule,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ]
  assert.ok(permissionPrompt(question))
  assert.equal(promptState(question), 'unknown')
  assert.ok(!permissionPrompt([...question, '⏺ 답을 받았습니다', '', '', rule, '❯ ', rule]), '지나간 안내 줄은 아님')
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

test('보낸 글이 화면에 보이는지 — 첫 줄 앞부분, 접힌 붙여넣기 표시', () => {
  const prompt = '작업 파일 /Users/x/tasks/sentry-24h.md 을 읽고\n그 절차대로 실행한다.'
  assert.equal(promptVisible(['❯ 작업 파일 /Users/x/tasks/sentry-24h.md 을 읽고', '⏺ 읽는 중'], prompt), true)
  assert.equal(promptVisible(['› 작업  파일 /Users/x/tasks/sen'], prompt), true, '공백 수가 달라도 같은 글')
  assert.equal(promptVisible(['❯ [Pasted text #1 +12 lines]'], prompt), true)
  assert.equal(promptVisible(['Claude Code', '❯ Try "fix lint errors"'], prompt), false)
  assert.equal(promptVisible(['❯ 아무거나'], '   '), false, '빈 글은 보였다고 하지 않음')
})
