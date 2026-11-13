// 터미널 화면 끝을 읽어 입력 칸이 비었는지, 권한 창이 떠 있는지 본다.
// OrcaCron 앱(Sources/SchedulerCore/Terminals.swift)과 같은 규칙 — 에이전트마다 입력 칸 모양이 다르다.

export type PromptState = 'empty' | 'typing' | 'unknown'
export type AgentKind = 'claude' | 'codex' | 'gemini'

export const agentKinds: readonly AgentKind[] = ['claude', 'codex', 'gemini']

export function agentKind(identity: string | null | undefined): AgentKind | null {
  const k = (identity ?? '').toLowerCase()
  return (agentKinds as readonly string[]).includes(k) ? (k as AgentKind) : null
}

export const agentName: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }

const NBSP = ' '
const trimSpaces = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '')

export function promptState(lines: string[], agent: AgentKind = 'claude'): PromptState {
  if (agent === 'codex') return codexPrompt(lines)
  if (agent === 'gemini') return geminiPrompt(lines)
  return claudePrompt(lines)
}

/** 화면 맨 아래 빈 줄을 뗀다. */
function trimmedTail(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && trimSpaces(out[out.length - 1]) === '') out.pop()
  return out
}

/** 입력 칸 위의 가로줄 — 줄 대부분이 가로선 글자이고 10자 이상. */
function isRule(line: string): boolean {
  const t = [...trimSpaces(line)]
  if (t.length < 10) return false
  const n = t.filter((c) => '─━═—-╌┄'.includes(c)).length
  return n / t.length >= 0.8
}

/** Claude Code — 가로줄 바로 아래 `❯` 줄. 빈 칸의 흐린 예시 문구는 `❯` 뒤에 NBSP 가 붙는다. */
function claudePrompt(lines: string[]): PromptState {
  if (lines.length < 2) return 'unknown'
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = trimSpaces(lines[i])
    const mark = line[0]
    if (!mark || !'❯›>'.includes(mark)) continue
    if (!isRule(lines[i - 1])) {
      // `>` 는 출력(인용 등)에도 흔해 가로줄 아래가 아니면 넘어간다. `❯`·`›` 는 질문·권한 창의 선택 표시다.
      if (mark === '>') continue
      return 'unknown'
    }
    const rest = line.slice(1)
    if (rest.startsWith(NBSP)) return 'empty'
    const typed = trimSpaces(rest.split('   ')[0] ?? '')
    return typed === '' ? 'empty' : 'typing'
  }
  return 'unknown'
}

const codexPlaceholders = new Set(['Ask Codex to do anything', 'Ask a follow-up question'])

/** Codex(0.166) — 화면 끝 몇 줄 안의 마지막 `›` 줄. 지나간 대화의 사용자 글도 `›` 로 시작한다. 선택 창은 `› 1. Yes, proceed`. */
function codexPrompt(lines: string[]): PromptState {
  const tail = trimmedTail(lines).slice(-6)
  let i = -1
  tail.forEach((l, idx) => {
    if (trimSpaces(l).startsWith('›')) i = idx
  })
  if (i < 0) return 'unknown'
  const rest = trimSpaces(tail[i]).slice(1).replace(/^[  ]+|[  ]+$/g, '')
  if (rest === '' || codexPlaceholders.has(rest)) return 'empty'
  if (/^\d+\.\s/.test(rest)) return 'unknown'
  return 'typing'
}

/** Gemini CLI — 둥근 상자 안의 `> ` 줄. `! ` 는 셸 모드라 보내지 않는다. */
function geminiPrompt(lines: string[]): PromptState {
  const tail = trimmedTail(lines).slice(-12).reverse()
  for (const line of tail) {
    const t = trimSpaces(line)
    if (!t.startsWith('│') && !t.startsWith('|')) continue
    const inner = t.replace(/^[│|  ]+|[│|  ]+$/g, '')
    const mark = inner[0]
    if (mark !== '>' && mark !== '!') continue
    if (mark === '!') return 'unknown'
    const rest = inner.slice(1).replace(/^[  ]+|[  ]+$/g, '')
    return rest === '' || rest.startsWith('Type your message') ? 'empty' : 'typing'
  }
  return 'unknown'
}

const questions = ['Do you want to', 'Would you like to', 'Allow execution', 'Apply this change?']
const yesWords = ['Yes, proceed', 'Yes, just this once', 'Yes, allow once']

/** 권한·질문 창이 화면 끝에 떠 있는지 — 묻는 줄과 「예」 선택지가 함께 있거나, Claude Code 의 선택 창 안내
 *  (`Enter to select · ↑/↓ to navigate`, 질문 도구 실화면 2026-11-13)가 화면 맨 끝에 보이면. */
export function permissionPrompt(lines: string[]): boolean {
  const recent = lines.slice(-30).map((l) => l.replace(/^[ │| ]+|[ │| ]+$/g, ''))
  if (trimmedTail(recent).slice(-2).some((l) => l.startsWith('Enter to select'))) return true
  const asks = recent.some((l) => questions.some((q) => l.includes(q)))
  const yes = recent.some((line) => {
    const l = line.replace(/^[❯›>●○ ]+/, '')
    return l.startsWith('1. Yes') || l.startsWith('1.Yes') || yesWords.some((w) => l.includes(w))
  })
  return asks && yes
}

/** 보낸 글이 화면에 보이는가 — 글이 실제로 들어갔다는 증거. 첫 줄 앞 16자로 찾고, 긴 글은 에이전트가
 *  「[Pasted text #1 +5 lines]」처럼 접어 보이므로 그 표시도 들어간 것으로 본다. */
export function promptVisible(lines: string[], prompt: string): boolean {
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const first = prompt.split('\n').map(squash).find(Boolean) ?? ''
  if (!first) return false
  const head = [...first].slice(0, 16).join('')
  return lines.some((l) => squash(l).includes(head) || /\[Pasted/i.test(l))
}
