// 예약 실행기 worker. 상태 막대 항목이 있어 플러그인이 켜져 있는 동안 계속 돈다(30초마다 확인).
// 예약은 storage 의 'schedules' 한 곳에 두고, 고치는 일은 모두 여기서 한다. 패널은 요청으로 묻고 알림으로 받는다.
// 에이전트 띄우기와 살아 있는 터미널 목록은 Orca CLI 로 한다(이유는 src/cli.ts).
import type { OrcaWorkerApi } from 'orca/worker'
import { aliveFrom, type CliRunner, cliRunner, findCli, launchArgs, launchedFrom } from './cli'
import { clock } from './cron'
import { blankSchedule, inspectOnEvent, type Io, newMemory, nextAfter, onAgentStatus, type Schedule, type StatusEvent, tick } from './engine'
import type { RunnerStatus, ScheduleDraft, WorkspaceOption } from './protocol'
import './protocol'
import { agentKind } from './screen'

export const KEY = 'schedules'
export const TICK_MS = 30_000
/** 멈춤 알림 뒤 화면이 그려지기를 기다리는 시간 — 질문 창은 첫 알림보다 조금 늦게 그려진다. */
export const SETTLE_MS = 1500

type HostError = Error & { code?: string }

/** 화면 읽기에서 다음 확인 때 다시 볼 오류 — 바쁨·시간 초과, 플러그인을 다시 읽는 동안의 권한 확인. */
const transientRead = new Set(['rate_limited', 'unavailable', 'timeout', 'consent_required'])

function invalid(message: string): HostError {
  const e: HostError = new Error(message)
  e.code = 'invalid_params'
  return e
}

/** 저장된 값이 옛 모양이어도 빠진 칸을 채운다. */
function normalize(value: unknown): Schedule[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof v.id === 'string')
    .map((v) => ({ ...blankSchedule(v.id as string), ...(v as Partial<Schedule>) }))
}

let timer: ReturnType<typeof setInterval> | undefined

/** CLI 실행기 — 비어 있으면 실행 중인 Orca 앱의 CLI 를 찾아 쓴다. 시험에서 가짜로 바꿔 끼운다. */
export const cli: { run: CliRunner | null } = { run: null }

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let list = normalize(await orca.storage.get(KEY))
  let saved = JSON.stringify(list)
  const memory = newMemory()
  const status: RunnerStatus = { lastTickAt: null, log: [] }
  const bin = cli.run ? null : findCli(process.execPath)
  const run: CliRunner | null = cli.run ?? (bin ? cliRunner(bin) : null)
  orca.log(run ? `Orca CLI: ${bin ?? '시험용'}` : `Orca CLI 를 찾지 못함(worker: ${process.execPath})`)

  // 한 번에 하나씩 — 확인(tick)과 패널의 고치기가 서로 덮어쓰지 않게.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  const io: Io = {
    async read(terminalId) {
      try {
        const r = await orca.host.call('terminal.read', { terminalId, maxLines: 200 })
        return r.lines
      } catch (error) {
        const code = (error as HostError).code
        if (code && transientRead.has(code)) throw error
        orca.log(`terminal.read ${terminalId}: ${code ?? ''} ${(error as Error).message}`)
        return null
      }
    },
    async launch(workspaceId, agent, prompt) {
      if (!run) return { error: 'Orca CLI 를 찾지 못함' }
      const r = launchedFrom(await run(launchArgs(workspaceId, agent, prompt)))
      if ('error' in r) orca.log(`agent launch ${workspaceId} ${agent}: ${r.error}`)
      return r
    },
    async alive() {
      return run ? aliveFrom(await run(['terminal', 'list'])) : null
    }
  }

  const notify = (notices: string[]): void => {
    for (const n of notices) {
      void orca.host.call('notifications.show', { title: 'OrcaCron', body: n }).catch(() => undefined)
    }
  }

  const persist = async (): Promise<void> => {
    const text = JSON.stringify(list)
    if (text === saved) return
    saved = text
    await orca.storage.set(KEY, list)
    orca.panels.post('schedules.changed', { schedules: list })
    updateStatusBar()
  }

  const updateStatusBar = (): void => {
    const stuck = list.filter((s) => s.blocked || (s.waitNote && s.pendingSince !== null))
    const next = list
      .filter((s) => s.enabled && s.nextRunAt !== null)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
    const at = next?.nextRunAt ? new Date(next.nextRunAt) : null
    const text = stuck.length > 0 ? `예약 ${stuck.length}개 확인 필요` : at ? `${clock(at.getHours() * 60 + at.getMinutes())} ${next.name}` : '예약 없음'
    const tooltip = [
      at ? `다음: ${at.toLocaleString('ko-KR')} · ${next.name}` : '켜진 예약 없음',
      ...stuck.map((s) => `${s.name}: ${s.blocked ?? s.waitNote}`)
    ].join('\n')
    void orca.host
      .call('statusBar.update', { id: 'next', text, tone: stuck.length > 0 ? 'warning' : 'neutral', tooltip })
      .catch(() => undefined)
  }

  const runTick = (): Promise<void> =>
    serial(async () => {
      const now = Date.now()
      const r = await tick(list, io, memory, now)
      status.lastTickAt = now
      status.log = [...r.log.map((l) => `${new Date(now).toLocaleTimeString('ko-KR')} ${l}`), ...status.log].slice(0, 50)
      for (const l of r.log) orca.log(l)
      notify(r.notices)
      await persist()
    })

  orca.events.on('agent.status.changed', (e) =>
    serial(async () => {
      const seen = await inspectOnEvent(list, e as StatusEvent, io, SETTLE_MS)
      const r = seen.hold ? { changed: false, notices: [] } : onAgentStatus(list, e as StatusEvent)
      notify([...seen.notices, ...r.notices])
      if (seen.changed || r.changed) await persist()
    })
  )

  orca.panels.handle('schedules.list', () => list)

  orca.panels.handle('workspaces.list', async (): Promise<WorkspaceOption[]> => {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces.map(({ id, name, branch, path, kind }) => ({ id, name, branch, path, kind }))
  })

  orca.panels.handle('schedules.save', (draft: ScheduleDraft) =>
    serial(async () => {
      const name = draft.name.trim()
      if (!name) throw invalid('이름을 적어 주세요')
      if (!draft.workspaceId) throw invalid('워크스페이스를 골라 주세요')
      if (!agentKind(draft.agent)) throw invalid('에이전트를 골라 주세요(Claude Code·Codex·Gemini CLI)')
      if (!draft.prompt.trim()) throw invalid('보낼 글을 적어 주세요')
      const nextRunAt = nextAfter(draft.cron, Date.now())
      if (nextRunAt === null) throw invalid('이 시각으로는 앞으로 돌지 않습니다 — 시각을 확인해 주세요')
      const old = draft.id ? list.find((s) => s.id === draft.id) : undefined
      const id = old?.id ?? draft.id ?? newId()
      const s: Schedule = { ...(old ?? blankSchedule(id)), ...draft, name, id }
      s.nextRunAt = s.enabled ? nextRunAt : null
      list = old ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]
      await persist()
      return s
    })
  )

  orca.panels.handle('schedules.delete', ({ id }) =>
    serial(async () => {
      list = list.filter((s) => s.id !== id)
      await persist()
      return { ok: true as const }
    })
  )

  orca.panels.handle('schedules.toggle', ({ id, enabled }) =>
    serial(async () => {
      const s = find(list, id)
      s.enabled = enabled
      s.nextRunAt = enabled ? nextAfter(s.cron, Date.now()) : null
      if (!enabled) {
        s.pendingSince = null
        s.waitNote = null
      }
      await persist()
      return s
    })
  )

  orca.panels.handle('schedules.runNow', async ({ id }) => {
    const s = await serial(async () => {
      const s = find(list, id)
      if (s.pendingSince === null) s.pendingSince = Date.now()
      await persist()
      return s
    })
    void runTick()
    return s
  })

  orca.panels.handle('runner.status', () => status)

  updateStatusBar()
  if (timer) clearInterval(timer)
  timer = setInterval(() => void runTick(), TICK_MS)
  void runTick()
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

function find(list: Schedule[], id: string): Schedule {
  const s = list.find((x) => x.id === id)
  if (!s) throw invalid('없는 예약입니다')
  return s
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}
