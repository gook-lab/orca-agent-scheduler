// Runs the Orca CLI from the worker. The plugin API's terminal.sendText only reaches the worktree open
// on screen, and its terminal.read raises no error for a closed terminal (Orca 1.4.255). The CLI does
// both for any workspace — README "Sending".
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { LiveTerminal, SendResult } from './engine'

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
      execFile(bin, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => resolve(parseCli(stdout, error)))
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
  const list = (r.result as { terminals?: CliTerminal[] }).terminals
  if (!list) return null
  return list
    .filter((t) => t.handle && t.writable !== false)
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

/** Type the text and press Enter, then watch up to 8 s for the agent to start a turn (never resends). */
export const sendArgs = (handle: string, text: string): string[] => ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '8']

/** `result.send.prompt.stages` holds `turn_started` once the agent was seen starting the turn (Orca 1.4.25x). */
export function sentFrom(r: CliResult): SendResult {
  if (!r.ok) return { error: r.error }
  const stages = (r.result as { send?: { prompt?: { stages?: unknown } } }).send?.prompt?.stages
  return { started: Array.isArray(stages) && stages.includes('turn_started') }
}
