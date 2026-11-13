// 예약 실행기 — 시각이 된 예약을 대기에 올리고, 받는 터미널이 비었을 때 보낸다.
// 화면 읽기·보내기는 Io 로 받아 시험에서 가짜로 바꿔 끼운다.
import { describe, nextRun, parseCron } from './cron'
import { agentKind, permissionPrompt, promptState } from './screen'

export type RunRecord = { at: number; status: string; summary?: string }

export type Schedule = {
  id: string
  name: string
  terminalId: string
  /** 고를 때의 터미널 제목(바뀔 수 있어 화면에는 지금 제목을 따로 쓴다). */
  terminalTitle: string
  /** 고를 때 그 터미널에 떠 있던 에이전트(claude·codex·gemini). */
  agent: string | null
  /** 고를 때의 워크스페이스 이름. */
  workspace: string
  cron: string
  prompt: string
  /** 보내기 전에 /clear 로 대화를 비운다. */
  clearFirst: boolean
  enabled: boolean
  nextRunAt: number | null
  /** 시각이 되어 보낼 차례를 기다리는 중(그 시각). */
  pendingSince: number | null
  waitNote: string | null
  clearedFor: number | null
  /** 보내고 에이전트가 끝나기를 기다리는 중(보낸 시각). */
  sentAt: number | null
  sawWorking: boolean
  blocked: string | null
  lastStatus: string | null
  history: RunRecord[]
}

export type AgentStatus = 'working' | 'blocked' | 'waiting' | 'done'
export type AgentState = { state: AgentStatus; since: number; outcome?: string }

export type Io = {
  /** 화면 끝 줄들. 터미널이 없으면 null. 잠깐 못 읽으면(바쁨·시간 초과) 던진다. */
  read(terminalId: string): Promise<string[] | null>
  send(terminalId: string, text: string): Promise<boolean>
}

export type Memory = {
  agents: Map<string, AgentState>
  screens: Map<string, { hash: string; changedAt: number }>
}

export const newMemory = (): Memory => ({ agents: new Map(), screens: new Map() })

export const limits = {
  /** 화면이 이만큼 움직이지 않아야 보낸다. */
  quietMs: 60_000,
  /** 이만큼 기다려도 못 보내면 건너뛴다. */
  maxWaitMs: 60 * 60_000,
  /** 보낸 뒤 이만큼 끝나지 않으면 「결과 없음」. */
  resultTimeoutMs: 6 * 3600_000,
  /** 상태 알림이 없을 때 — 보낸 뒤 화면이 이만큼 조용하고 입력 칸이 비면 끝난 것으로 본다. */
  finishedQuietMs: 3 * 60_000,
  historyMax: 30
}

export function blankSchedule(id: string): Schedule {
  return {
    id,
    name: '',
    terminalId: '',
    terminalTitle: '',
    agent: null,
    workspace: '',
    cron: '0 9 * * 1-5',
    prompt: '',
    clearFirst: false,
    enabled: true,
    nextRunAt: null,
    pendingSince: null,
    waitNote: null,
    clearedFor: null,
    sentAt: null,
    sawWorking: false,
    blocked: null,
    lastStatus: null,
    history: []
  }
}

export function nextAfter(cron: string, now: number): number | null {
  const rules = parseCron(cron)
  return rules ? (nextRun(rules, new Date(now))?.getTime() ?? null) : null
}

function record(s: Schedule, r: RunRecord): void {
  s.history = [r, ...s.history].slice(0, limits.historyMax)
  s.lastStatus = r.status
}

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}

export type TickResult = { log: string[]; notices: string[] }

/** 30초마다 한 번. 예약 목록을 고쳐 쓰고 남길 기록·알림을 돌려준다. */
export async function tick(list: Schedule[], io: Io, memory: Memory, now: number): Promise<TickResult> {
  const log: string[] = []
  const notices: string[] = []
  // undefined = 이번에는 못 읽음(다음 확인 때 다시).
  const screens = new Map<string, string[] | null | undefined>()
  const screen = async (id: string): Promise<string[] | null | undefined> => {
    if (!screens.has(id)) {
      let lines: string[] | null | undefined
      try {
        lines = await io.read(id)
      } catch {
        lines = undefined
      }
      screens.set(id, lines)
      if (lines) {
        const hash = lines.slice(-40).join('\n')
        const seen = memory.screens.get(id)
        if (!seen || seen.hash !== hash) memory.screens.set(id, { hash, changedAt: now })
      }
    }
    return screens.get(id)
  }

  // 1. 시각이 된 예약을 대기에 올린다.
  for (const s of list) {
    if (!s.enabled) {
      s.nextRunAt = null
      continue
    }
    if (s.nextRunAt === null) s.nextRunAt = nextAfter(s.cron, now)
    if (s.nextRunAt !== null && s.nextRunAt <= now) {
      if (s.pendingSince === null) s.pendingSince = s.nextRunAt
      s.nextRunAt = nextAfter(s.cron, now)
    }
  }

  const used = new Set<string>()
  for (const s of list) {
    // 2. 보낸 뒤 — 끝나기를 기다린다. 끝은 대개 에이전트 상태 알림(onAgentStatus)으로 온다.
    if (s.sentAt !== null) {
      if (now - s.sentAt >= limits.resultTimeoutMs) {
        record(s, { at: now, status: '결과 없음', summary: `${minutes(limits.resultTimeoutMs)} 안에 끝나지 않음` })
        s.sentAt = null
        notices.push(`${s.name}: 결과 없음`)
        continue
      }
      if (!s.sawWorking) {
        // 일을 시작했다는 상태 알림이 오지 않았다 — 화면으로 본다.
        const lines = await screen(s.terminalId)
        const quietSince = memory.screens.get(s.terminalId)?.changedAt ?? now
        if (lines && now - s.sentAt >= limits.finishedQuietMs && now - quietSince >= limits.finishedQuietMs
            && promptState(lines, agentKind(s.agent) ?? 'claude') === 'empty') {
          finish(s, now, '끝남', '화면 기준(상태 알림 없음)')
          log.push(`${s.name}: 끝남(화면 기준)`)
        }
      }
      if (s.pendingSince !== null) s.waitNote = '이전 실행이 아직 끝나지 않음'
      continue
    }

    // 3. 대기 중 — 터미널이 비면 보낸다.
    if (s.pendingSince === null) continue
    const waited = now - s.pendingSince
    const waitOrGiveUp = (why: string): void => {
      if (waited >= limits.maxWaitMs) {
        record(s, { at: now, status: '건너뜀', summary: `${minutes(limits.maxWaitMs)} 동안 ${why}` })
        s.pendingSince = null
        s.waitNote = null
        notices.push(`${s.name}: 건너뜀 — ${why}`)
        log.push(`${s.name}: 건너뜀 — ${why}`)
      } else {
        s.waitNote = why
      }
    }

    if (used.has(s.terminalId)) {
      s.waitNote = '같은 터미널에 다른 예약을 막 보내 다음 확인 때 보냄'
      continue
    }
    const lines = await screen(s.terminalId)
    if (lines === undefined) { waitOrGiveUp('터미널 화면을 읽지 못함(잠시 뒤 다시)'); continue }
    if (lines === null) {
      record(s, { at: now, status: '건너뜀', summary: `터미널(${s.terminalTitle})을 찾을 수 없음 — 편집에서 다시 고르세요` })
      s.pendingSince = null
      s.waitNote = null
      notices.push(`${s.name}: 터미널 없음`)
      continue
    }
    const state = memory.agents.get(s.terminalId)?.state
    if (state === 'working') { waitOrGiveUp('에이전트가 작업 중'); continue }
    if (state === 'blocked') { waitOrGiveUp('권한·질문 창이 떠 있음'); continue }
    const changedAt = memory.screens.get(s.terminalId)?.changedAt ?? now
    if (now - changedAt < limits.quietMs) { waitOrGiveUp('화면이 1분 안에 움직임(작업 중이거나 입력 중)'); continue }
    const prompt = promptState(lines, agentKind(s.agent) ?? 'claude')
    if (prompt === 'typing') { waitOrGiveUp('입력 칸에 쓰던 글이 있음'); continue }
    if (prompt === 'unknown') {
      waitOrGiveUp(permissionPrompt(lines) ? '권한 확인 창이 떠 있음' : '입력 칸이 보이지 않음(질문·선택 창이 떠 있을 수 있음)')
      continue
    }

    used.add(s.terminalId)
    if (s.clearFirst && s.clearedFor !== s.pendingSince) {
      if (await io.send(s.terminalId, '/clear')) {
        s.clearedFor = s.pendingSince
        s.waitNote = '대화를 비웠음(/clear) — 화면이 조용해지면 보냄'
        memory.screens.set(s.terminalId, { hash: '', changedAt: now })
        log.push(`${s.name}: 대화 비움(/clear)`)
      } else {
        record(s, { at: now, status: '실패', summary: '대화 비우기(/clear) 실패' })
        s.pendingSince = null
        notices.push(`${s.name}: /clear 실패`)
      }
      continue
    }
    if (await io.send(s.terminalId, s.prompt)) {
      s.sentAt = now
      s.sawWorking = false
      s.blocked = null
      s.lastStatus = '보냄'
      s.pendingSince = null
      s.waitNote = null
      log.push(`${s.name}: 보냄 → ${s.terminalTitle}`)
    } else {
      record(s, { at: now, status: '실패', summary: '보내기 실패(터미널이 글을 받지 않음)' })
      s.pendingSince = null
      s.waitNote = null
      notices.push(`${s.name}: 보내기 실패`)
    }
  }
  return { log, notices }
}

function finish(s: Schedule, now: number, status: string, note?: string): void {
  const took = s.sentAt === null ? '' : `걸린 시간 ${minutes(now - s.sentAt)}`
  record(s, { at: now, status, summary: [took, note].filter(Boolean).join(' · ') })
  s.sentAt = null
  s.sawWorking = false
  s.blocked = null
}

const outcomeStatus: Record<string, string> = {
  success: '성공',
  failure: '실패',
  cancellation: '중단',
  interruption: '중단',
  superseded: '중단'
}

export type StatusEvent = {
  terminalId?: string
  state: AgentStatus
  receivedAt: number
  mainAgent?: { state: AgentStatus; outcome?: string; stateStartedAt: number }
}

/** 에이전트 상태 알림 — 보낸 예약이 일을 시작했다가 멈추면 끝난 것으로 기록한다. 바뀐 예약 이름을 돌려준다. */
export function onAgentStatus(list: Schedule[], memory: Memory, e: StatusEvent): { changed: boolean; notices: string[] } {
  const notices: string[] = []
  if (!e.terminalId) return { changed: false, notices }
  memory.agents.set(e.terminalId, { state: e.state, since: e.receivedAt, outcome: e.mainAgent?.outcome })
  let changed = false
  for (const s of list) {
    if (s.terminalId !== e.terminalId || s.sentAt === null) continue
    if (e.state === 'working') {
      if (!s.sawWorking || s.blocked) changed = true
      s.sawWorking = true
      s.blocked = null
    } else if (e.state === 'blocked') {
      if (!s.blocked) {
        s.blocked = '권한·질문 창에서 멈춤 — 그 터미널을 확인해 주세요'
        notices.push(`${s.name}: 권한·질문 창에서 멈춤`)
        changed = true
      }
    } else if (s.sawWorking) {
      const outcome = e.mainAgent?.outcome
      const status = (outcome && outcomeStatus[outcome]) ?? (e.state === 'waiting' ? '끝남(입력 대기)' : '끝남')
      finish(s, e.receivedAt, status)
      if (status === '실패' || status === '중단') notices.push(`${s.name}: ${status}`)
      changed = true
    }
  }
  return { changed, notices }
}

export function summaryOf(s: Schedule): string {
  return describe(s.cron)
}
