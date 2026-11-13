// Orca CLI 를 worker 안에서 부른다. 플러그인 API 의 agent.launch 는 다른 워크스페이스에 띄운 에이전트에 프롬프트를
// 넣지 못하고(1.4.255 실측 "agent_launch_terminal_not_running_agent"), 플러그인의 terminal.read 는 닫힌 터미널에도
// 오류를 내지 않는다. 같은 일을 CLI 로 하면 둘 다 된다 — README 「보내는 방식」.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export type CliResult = { ok: true; result: unknown } | { ok: false; error: string }
export type CliRunner = (args: string[]) => Promise<CliResult>

/** 실행 중인 Orca 와 같은 판의 CLI. worker 는 그 앱의 Orca Helper 로 돌므로 앱 안의 bin/orca 를 쓴다
 *  (PATH 의 orca 는 다른 판 앱을 가리킬 수 있다 — 이 맥에서는 1.4.192 를 가리켰다). */
export function findCli(execPath: string, exists: (path: string) => boolean = existsSync): string | null {
  const app = /^(.*?\.app)\/Contents\//.exec(execPath)?.[1]
  const bin = app ? `${app}/Contents/Resources/bin/orca` : null
  return bin && exists(bin) ? bin : null
}

/** CLI 의 --json 출력을 결과로. 실패면 메시지. */
export function parseCli(stdout: string, error: Error | null): CliResult {
  let parsed: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | undefined
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, error: error?.message ?? 'CLI 응답을 읽지 못함' }
  }
  if (parsed?.ok) return { ok: true, result: parsed.result }
  return { ok: false, error: parsed?.error?.message ?? parsed?.error?.code ?? error?.message ?? 'CLI 실패' }
}

export function cliRunner(bin: string, timeoutMs = 60_000): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => resolve(parseCli(stdout, error)))
    })
}

type LaunchResult = { outcome?: { kind?: string; handle?: string }; prompt?: { delivery?: string; outcome?: string } }

/** `orca agent launch` 결과 — 띄운 터미널, 또는 못 띄웠거나 글이 안 들어간 이유. */
export function launchedFrom(r: CliResult): { terminalId: string } | { error: string } {
  if (!r.ok) return { error: r.error }
  const res = r.result as LaunchResult
  const handle = res.outcome?.handle
  if (!handle) return { error: `터미널을 받지 못함(${res.outcome?.kind ?? '알 수 없음'})` }
  if (res.prompt?.outcome !== 'handed-to-terminal') return { error: `글이 들어가지 않음(${res.prompt?.outcome ?? '응답 없음'}) — 띄운 탭은 열려 있음` }
  return { terminalId: handle }
}

/** `orca terminal list` 결과 — 살아 있는 터미널 handle. 못 읽으면 null(모름). */
export function aliveFrom(r: CliResult): Set<string> | null {
  if (!r.ok) return null
  const list = (r.result as { terminals?: { handle?: string }[] }).terminals
  return list ? new Set(list.map((t) => t.handle ?? '').filter(Boolean)) : null
}

export const launchArgs = (workspaceId: string, agent: string, prompt: string): string[] => [
  'agent',
  'launch',
  '--agent',
  agent,
  '--surface',
  'terminal',
  '--worktree',
  workspaceId,
  '--prompt',
  prompt
]
