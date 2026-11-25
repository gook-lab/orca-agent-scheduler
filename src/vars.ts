// Variables in a prompt, filled in when the run goes out — README "Prompt variables".
import type { RunRecord } from './engine'

export type VarContext = {
  now: number
  /** The schedule's history, newest first. */
  history: readonly RunRecord[]
  /** What the precheck command printed, when the schedule has one. */
  precheck?: string
}

export const varNames = ['date', 'time', 'last_run', 'last_result', 'last_link', 'precheck'] as const
export type VarName = (typeof varNames)[number]

/** A filled-in value may hold at most this many characters; the rest is cut with … */
export const VAR_MAX = 2000

const pad2 = (n: number): string => String(n).padStart(2, '0')
const day = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const hm = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/** The run in which the agent last wrote a result line — its summary and link go together. */
const lastTold = (history: readonly RunRecord[]): RunRecord | undefined => history.find((r) => r.summary !== undefined)

/** The newest run that went out: only a run that was sent has a duration. */
const lastSent = (history: readonly RunRecord[]): RunRecord | undefined => history.find((r) => r.tookMs !== undefined)

/** One line, of bounded length. A line break inside the prompt could be read by the agent's input box as
 *  Enter and send half of it, so the lines of a value are joined with "; ". */
export function flatten(value: string): string {
  const one = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('; ')
  return one.length > VAR_MAX ? `${one.slice(0, VAR_MAX - 1)}…` : one
}

function valueOf(name: VarName, c: VarContext): string {
  const now = new Date(c.now)
  switch (name) {
    case 'date':
      return day(now)
    case 'time':
      return hm(now)
    case 'last_run': {
      const r = lastSent(c.history)
      if (!r) return ''
      const sent = new Date(r.at - (r.tookMs ?? 0))
      return `${day(sent)} ${hm(sent)}`
    }
    case 'last_result':
      return lastTold(c.history)?.summary ?? ''
    case 'last_link':
      return lastTold(c.history)?.link ?? ''
    case 'precheck':
      return c.precheck ?? ''
  }
}

const isVar = (name: string): name is VarName => (varNames as readonly string[]).includes(name)

/** `{{name}}` or `{{name|text used when it is empty}}`. Names this version does not know stay as typed. */
const pattern = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g

export function fillPrompt(prompt: string, c: VarContext): string {
  return prompt.replace(pattern, (whole, name: string, fallback: string | undefined) => {
    if (!isVar(name)) return whole
    const value = flatten(valueOf(name, c))
    return value || (fallback ?? '').trim()
  })
}

/** The variables a prompt uses, so the form can say what each will be. */
export const usedVars = (prompt: string): VarName[] =>
  [...new Set([...prompt.matchAll(pattern)].map((m) => m[1]).filter(isVar))] as VarName[]
