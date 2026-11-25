// Runs the Orca CLI from the worker. The plugin API's terminal.sendText only reaches the worktree open
// on screen, and its terminal.read raises no error for a closed terminal (Orca 1.4.255). The CLI does
// both for any workspace — README "Sending".
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { CheckResult, LiveTerminal, SendResult } from './engine'
import { messageOf } from './text'

export type CliResult = { ok: true; result: unknown } | { ok: false; error: string }
export type CliRunner = (args: string[]) => Promise<CliResult>

/** The CLI of the running Orca. The worker runs as that app's Orca Helper, so use the app's own bin/orca
 *  (`orca` on PATH can point at another version — on this Mac it was 1.4.192). */
export function findCli(execPath: string, exists: (path: string) => boolean = existsSync): string | null {
  const app = /^(.*?\.app)\/Contents\//.exec(execPath)?.[1]
  const bin = app ? `${app}/Contents/Resources/bin/orca` : null
  return bin && exists(bin) ? bin : null
}

/** The CLI's --json output as a result; the message on failure. */
export function parseCli(stdout: string, error: Error | null): CliResult {
  let parsed: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | undefined
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, error: error?.message ?? 'unreadable CLI output' }
  }
  if (parsed?.ok) return { ok: true, result: parsed.result }
  return { ok: false, error: parsed?.error?.message ?? parsed?.error?.code ?? error?.message ?? 'CLI failed' }
}

export function cliRunner(bin: string, timeoutMs = 60_000): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      // execFile throws, rather than calling back, for arguments it will not pass on (a NUL in the text).
      // That is a failed call like any other: as a rejected promise it ended the whole check.
      try {
        execFile(bin, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => resolve(parseCli(stdout, error)))
      } catch (error) {
        resolve({ ok: false, error: messageOf(error) })
      }
    })
}

/** A precheck is cut off after this long. */
export const CHECK_TIMEOUT_MS = 30_000

/** The shell a precheck runs in: the user's login shell on macOS and Linux, so PATH holds what their
 *  terminal has (Homebrew's gh, for one) — Orca's own process may start with a short PATH. */
export function shellOf(platform: string, env: Record<string, string | undefined>): [string, string[]] {
  if (platform === 'win32') return [env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']]
  return [env.SHELL || '/bin/sh', ['-lc']]
}

/** Runs a precheck command in `cwd`. Its exit code and what it printed (stdout, else stderr). */
export function runCheck(command: string, cwd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const [shell, flags] = shellOf(process.platform, process.env)
  return new Promise((resolve) => {
    try {
      execFile(shell, [...flags, command], { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        const output = String(stdout).trim() || String(stderr).trim()
        if (!error) return resolve({ code: 0, output })
        const e = error as Error & { code?: number | string; killed?: boolean }
        // A number is the exit code; a string is a spawn error (ENOENT: no such shell or folder).
        if (typeof e.code === 'number') return resolve({ code: e.code, output })
        if (e.killed || e.code === undefined) return resolve({ code: null, output })
        resolve({ error: `${e.code}: ${messageOf(error)}` })
      })
    } catch (error) {
      resolve({ error: messageOf(error) })
    }
  })
}

type CliTerminal = {
  handle?: string
  title?: string
  agentIdentity?: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  lastOutputAt?: number
  writable?: boolean
}

/** `orca terminal list` → the terminals that take input. Null when the list could not be read. */
export function terminalsFrom(r: CliResult): LiveTerminal[] | null {
  if (!r.ok) return null
  const list = (r.result as { terminals?: unknown } | null | undefined)?.terminals
  // An answer in a shape this version does not know is "could not read", not an exception.
  if (!Array.isArray(list)) return null
  return list
    .filter((t): t is CliTerminal => typeof t === 'object' && t !== null && typeof t.handle === 'string' && t.handle !== '' && t.writable !== false)
    .map((t) => ({
      handle: t.handle as string,
      title: t.title ?? '',
      agent: t.agentIdentity ?? null,
      workspaceId: t.worktreeId ?? '',
      tabId: t.tabId ?? '',
      leafId: t.leafId ?? '',
      lastOutputAt: typeof t.lastOutputAt === 'number' ? t.lastOutputAt : null
    }))
}

/**
 * Orca drops a working terminal's agent for a second or two now and then (11-13: one busy Claude
 * terminal, 7 times in 30 one-second reads, the handle unchanged). A terminal whose agent was seen within
 * `holdMs` keeps it — otherwise it falls out of the panel's list and a pending run turns orange for
 * nothing. Nothing goes out on this alone: the screen still has to show that agent's input box.
 * `seen` remembers the last agent by pane.
 */
export function holdAgents(
  list: LiveTerminal[],
  seen: Map<string, { agent: string; at: number }>,
  now: number,
  holdMs: number
): LiveTerminal[] {
  return list.map((t) => {
    const key = t.leafId || t.handle
    if (t.agent) {
      seen.set(key, { agent: t.agent, at: now })
      return t
    }
    const last = seen.get(key)
    return last && now - last.at <= holdMs ? { ...t, agent: last.agent } : t
  })
}

/** Type the text and press Enter, then watch up to 8 s for the agent to start a turn (never resends).
 *  Values go as `--flag=value`: given apart, a prompt that starts with `--` is read as another flag
 *  ("Unknown flag", or the help text for `--help`) and never reaches the terminal. */
export const sendArgs = (handle: string, text: string): string[] => ['terminal', 'send', `--terminal=${handle}`, `--text=${text}`, '--enter', '--wait-submit', '8']

/** `result.send.prompt.stages` holds `turn_started` once the agent was seen starting the turn (Orca 1.4.25x).
 *  An ok answer without the stages is still a send: the text went in, only the turn's start was not seen. */
export function sentFrom(r: CliResult): SendResult {
  if (!r.ok) return { error: r.error }
  const stages = (r.result as { send?: { prompt?: { stages?: unknown } } } | null | undefined)?.send?.prompt?.stages
  return { started: Array.isArray(stages) && stages.includes('turn_started') }
}
