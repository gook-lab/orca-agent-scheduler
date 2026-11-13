// 예약 실행기 worker. 상태 막대 항목이 있어 플러그인이 켜져 있는 동안 계속 돈다(30초마다 확인).
// 예약은 storage 의 'schedules' 한 곳에 두고, 패널은 같은 키를 읽는다. 고치는 일은 모두 여기서 한다.
import type { OrcaWorkerApi } from 'orca/worker'
import { clock } from './cron'
import {
  blankSchedule,
  type Io,
  newMemory,
  nextAfter,
  onAgentStatus,
  type Schedule,
  type StatusEvent,
  tick
} from './engine'
import type { RunnerStatus, ScheduleDraft } from './protocol'
import './protocol'

export const KEY = 'schedules'
export const TICK_MS = 30_000

type HostError = Error & { code?: string }

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

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let list = normalize(await orca.storage.get(KEY))
  let saved = JSON.stringify(list)
  const memory = newMemory()
  const status: RunnerStatus = { lastTickAt: null, log: [] }

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
        const r = await orca.host.call('terminal.read', { terminalId, maxLines: 60 })
        return r.lines
      } catch (error) {
        const code = (error as HostError).code
        // 바쁘거나 시간이 걸린 것은 다음에 다시 — 그 밖의 실패는 터미널이 없는 것으로 본다.
        if (code === 'rate_limited' || code === 'unavailable' || code === 'timeout') throw error
        orca.log(`terminal.read ${terminalId}: ${code ?? String(error)}`)
        return null
      }
    },
    async send(terminalId, text) {
      try {
        const r = await orca.host.call('terminal.sendText', { terminalId, text, enter: true })
        return r.accepted
      } catch (error) {
        orca.log(`terminal.sendText ${terminalId}: ${(error as HostError).code ?? String(error)}`)
        return false
      }
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
    const text = stuck.length > 0 ? `예약 ${stuck.length}개 대기` : at ? `${clock(at.getHours() * 60 + at.getMinutes())} ${next.name}` : '예약 없음'
    const tooltip = [
      at ? `다음: ${at.toLocaleString('ko-KR')} · ${next.name}` : '켜진 예약 없음',
      ...stuck.map((s) => `${s.name}: ${s.blocked ?? s.waitNote}`)
    ].join('\n')
    void orca.host
      .call('statusBar.update', { id: 'next', text, tone: stuck.length > 0 ? 'warning' : 'neutral', tooltip })
      .catch(() => undefined)
  }

  /** 지금 보고 있는 워크스페이스의 에이전트 상태·제목을 받아 둔다(다른 워크스페이스는 알림으로 쌓인다). */
  const refreshAgents = async (): Promise<void> => {
    try {
      const { agents } = await orca.host.call('agents.list')
      for (const a of agents) {
        if (!a.terminalId) continue
        const known = memory.agents.get(a.terminalId)
        if (!known || known.since <= a.stateStartedAt) {
          memory.agents.set(a.terminalId, { state: a.state, since: a.stateStartedAt })
        }
      }
    } catch {
      // 상태 목록이 없어도 화면으로 판정한다.
    }
  }

  const runTick = (): Promise<void> =>
    serial(async () => {
      await refreshAgents()
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
      const r = onAgentStatus(list, memory, e as StatusEvent)
      notify(r.notices)
      if (r.changed) await persist()
    })
  )

  orca.panels.handle('schedules.list', () => list)

  orca.panels.handle('schedules.save', (draft: ScheduleDraft) =>
    serial(async () => {
      const name = draft.name.trim()
      if (!name) throw invalid('이름을 적어 주세요')
      if (!draft.terminalId) throw invalid('터미널을 골라 주세요')
      if (!draft.prompt.trim()) throw invalid('보낼 글을 적어 주세요')
      const nextRunAt = nextAfter(draft.cron, Date.now())
      if (nextRunAt === null) throw invalid('이 시각으로는 앞으로 돌지 않습니다 — 시각을 확인해 주세요')
      const old = draft.id ? list.find((s) => s.id === draft.id) : undefined
      const s: Schedule = { ...(old ?? blankSchedule(draft.id ?? newId())), ...draft, name, id: old?.id ?? draft.id ?? newId() }
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
      s.waitNote = '지금 보내기 — 터미널이 비면 보냄'
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
