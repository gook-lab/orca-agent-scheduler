// Reads the end of a terminal screen: is the input box empty, is a permission dialog open.
// The same rules as the OrcaCron app (Sources/SchedulerCore/Terminals.swift) — each agent draws its input box differently.

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

/** Drops the empty lines at the bottom of the screen. */
function trimmedTail(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && trimSpaces(out[out.length - 1]) === '') out.pop()
  return out
}

/** The rule above the input box — at least 10 characters, most of them line-drawing. */
function isRule(line: string): boolean {
  const t = [...trimSpaces(line)]
  if (t.length < 10) return false
  const n = t.filter((c) => '─━═—-╌┄'.includes(c)).length
  return n / t.length >= 0.8
}

/** Claude Code — the `❯` line right under the rule. In an empty box the dimmed example text follows `❯` after an NBSP. */
function claudePrompt(lines: string[]): PromptState {
  if (lines.length < 2) return 'unknown'
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = trimSpaces(lines[i])
    const mark = line[0]
    if (!mark || !'❯›>'.includes(mark)) continue
    if (!isRule(lines[i - 1])) {
      // `>` is common in output (quotes), so one not under the rule is passed by. `❯` and `›` there mark a choice in a question or permission dialog.
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

/** Codex (0.166) — the last `›` line within the final few lines. Earlier user turns start with `›` too. A choice dialog reads `› 1. Yes, proceed`. */
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

/** Gemini CLI — the `> ` line inside the rounded box. `! ` is shell mode, so nothing is sent. */
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

/** Whether a permission or question dialog is open at the end of the screen — a line that asks together
 *  with a "yes" choice, or Claude Code's choice hint (`Enter to select · ↑/↓ to navigate`, seen on the
 *  question tool's screen 2026-11-13) on the last lines. */
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
