// 예약 실행기 — 시각이 되면 고른 워크스페이스에 새 에이전트를 띄워 글을 보내고, 끝나기를 지켜본다.
// 기존 터미널에 타이핑(terminal.sendText)은 Orca 가 화면에 열린 워크스페이스에만 허용해(1.4.255 실측:
// "terminal is outside the active worktree") 자리를 비운 사이 도는 예약에 쓸 수 없다. 그래서 회차마다 새 터미널을
// 띄운다. 화면 읽기·띄우기·살아 있는 터미널 목록은 Io 로 받아 시험에서 가짜로 바꿔 끼운다.
import { nextRun, parseCron } from './cron'
import { agentKind, permissionPrompt, promptState, promptVisible } from './screen'

export type RunRecord = { at: number; status: string; summary?: string }

export type Schedule = {
  id: string
  name: string
  /** 띄울 워크스페이스(workspace.list 의 id). */
  workspaceId: string
  /** 고를 때의 워크스페이스 이름(화면 표시용). */
  workspace: string
  /** 띄울 에이전트(claude·codex·gemini). */
  agent: string
  cron: string
  prompt: string
  enabled: boolean
  nextRunAt: number | null
  /** 시각이 되어 띄울 차례를 기다리는 중(그 시각). 지난 회차가 아직 돌고 있을 때만 기다린다. */
  pendingSince: number | null
  waitNote: string | null
  /** 이번 회차에 띄운 터미널. */
  terminalId: string | null
  /** 띄우고 에이전트가 끝나기를 기다리는 중(띄운 시각). */
  sentAt: number | null
  /** 보낸 글이 화면에 보였다 — 이것을 본 뒤에만 상태 알림·조용한 화면을 「끝」으로 받는다. */
  delivered: boolean
  sawWorking: boolean
  blocked: string | null
  lastStatus: string | null
  history: RunRecord[]
}

export type AgentStatus = 'working' | 'blocked' | 'waiting' | 'done'

export type Io = {
  /** 화면 끝 줄들. 터미널이 없으면 null. 잠깐 못 읽으면(바쁨·시간 초과·권한 확인 중) 던진다. */
  read(terminalId: string): Promise<string[] | null>
  /** 새 에이전트를 띄우고 글을 넣는다. 못 띄우면 이유. */
  launch(workspaceId: string, agent: string, prompt: string): Promise<{ terminalId: string } | { error: string }>
  /** 살아 있는 터미널. 모르면 null. */
  alive(): Promise<Set<string> | null>
}

export type Memory = {
  screens: Map<string, { hash: string; changedAt: number }>
}

export const newMemory = (): Memory => ({ screens: new Map() })

export const limits = {
  /** 지난 회차가 이만큼 지나도 안 끝나면 이번 회차를 건너뛴다. */
  maxWaitMs: 60 * 60_000,
  /** 띄운 뒤 이만큼 끝나지 않으면 「결과 없음」. */
  resultTimeoutMs: 6 * 3600_000,
  /** 화면이 이만큼 조용하면 — 입력 칸이 비었으면 끝, 입력 칸이 안 보이면 멈춘 것으로 본다. */
  finishedQuietMs: 3 * 60_000,
  historyMax: 30
}

export function blankSchedule(id: string): Schedule {
  return {
    id,
    name: '',
    workspaceId: '',
    workspace: '',
    agent: 'claude',
    cron: '0 9 * * 1-5',
    prompt: '',
    enabled: true,
    nextRunAt: null,
    pendingSince: null,
    waitNote: null,
    terminalId: null,
    sentAt: null,
    delivered: false,
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
  const alive = list.some((s) => s.sentAt !== null) ? await io.alive() : null

  for (const s of list) {
    // 1. 시각이 된 예약을 대기에 올린다.
    if (!s.enabled) {
      s.nextRunAt = null
    } else {
      if (s.nextRunAt === null) s.nextRunAt = nextAfter(s.cron, now)
      if (s.nextRunAt !== null && s.nextRunAt <= now) {
        if (s.pendingSince === null) s.pendingSince = s.nextRunAt
        s.nextRunAt = nextAfter(s.cron, now)
      }
    }

    // 2. 띄운 회차 — 끝나기를 기다린다. 끝은 대개 에이전트 상태 알림(onAgentStatus)으로 오고, 안 오면 화면으로 본다.
    if (s.sentAt !== null) await watch(s, io, memory, alive, now, log, notices)

    // 3. 대기 중 — 지난 회차가 끝났으면 띄운다.
    if (s.pendingSince === null) continue
    const waited = now - s.pendingSince
    if (s.sentAt !== null) {
      if (waited < limits.maxWaitMs) {
        s.waitNote = '지난 회차가 아직 실행 중 — 끝나면 띄움'
      } else {
        const why = `지난 회차가 ${minutes(limits.maxWaitMs)} 넘게 실행 중`
        record(s, { at: now, status: '건너뜀', summary: why })
        s.pendingSince = null
        s.waitNote = null
        notices.push(`${s.name}: 건너뜀 — ${why}`)
        log.push(`${s.name}: 건너뜀 — ${why}`)
      }
      continue
    }
    const r = await io.launch(s.workspaceId, s.agent, s.prompt)
    s.pendingSince = null
    s.waitNote = null
    if ('terminalId' in r) {
      s.terminalId = r.terminalId
      s.sentAt = now
      s.delivered = false
      s.sawWorking = false
      s.blocked = null
      s.lastStatus = '보냄'
      memory.screens.delete(r.terminalId)
      log.push(`${s.name}: 띄움 → ${s.workspace} ${r.terminalId}`)
    } else {
      record(s, { at: now, status: '실패', summary: `에이전트를 띄우지 못함 — ${r.error}` })
      notices.push(`${s.name}: 에이전트를 띄우지 못함`)
      log.push(`${s.name}: 띄우기 실패 — ${r.error}`)
    }
  }
  return { log, notices }
}

const personNote = '권한·질문 창에서 멈춤 — 그 터미널을 확인해 주세요'

async function watch(
  s: Schedule,
  io: Io,
  memory: Memory,
  alive: Set<string> | null,
  now: number,
  log: string[],
  notices: string[]
): Promise<void> {
  if (s.sentAt === null || s.terminalId === null) return
  if (now - s.sentAt >= limits.resultTimeoutMs) {
    finish(s, now, '결과 없음', `${minutes(limits.resultTimeoutMs)} 안에 끝나지 않음`)
    notices.push(`${s.name}: 결과 없음`)
    return
  }
  // 플러그인의 화면 읽기는 닫힌 터미널에도 오류를 내지 않아(1.4.255 실측) 살아 있는 터미널 목록으로 먼저 본다.
  let lines: string[] | null = null
  if (!alive || alive.has(s.terminalId)) {
    try {
      lines = await io.read(s.terminalId)
    } catch {
      return // 다음 확인 때 다시
    }
  }
  if (lines === null) {
    finish(s, now, '중단', '띄운 터미널이 닫혀 결과를 모름')
    log.push(`${s.name}: 띄운 터미널이 닫힘`)
    return
  }
  if (!s.delivered && promptVisible(lines, s.prompt)) s.delivered = true
  const hash = lines.slice(-40).join('\n')
  const seen = memory.screens.get(s.terminalId)
  if (!seen || seen.hash !== hash) {
    memory.screens.set(s.terminalId, { hash, changedAt: now })
    // 화면이 다시 움직이면 멈춤 표시를 거둔다(권한 창에 답했거나 시작 화면을 넘겼다).
    if (seen) s.blocked = null
  }
  const quiet = now - (memory.screens.get(s.terminalId)?.changedAt ?? now) >= limits.finishedQuietMs
  if (!quiet) return
  const prompt = promptState(lines, agentKind(s.agent) ?? 'claude')
  if (prompt === 'empty') {
    if (!s.delivered) {
      // 에이전트만 뜨고 글은 들어가지 않았다 — 조용한 빈 입력 칸을 「끝」으로 보면 거짓 성공이 된다.
      finish(s, now, '실패', '보낸 글이 화면에 보이지 않음 — 에이전트만 뜸')
      notices.push(`${s.name}: 글이 들어가지 않음`)
      log.push(`${s.name}: 실패 — 글이 들어가지 않음`)
      return
    }
    // 상태 알림을 놓쳤다 — 글이 들어간 뒤 화면이 조용하고 입력 칸이 비었으면 끝.
    finish(s, now, '끝남', '화면 기준')
    log.push(`${s.name}: 끝남(화면 기준)`)
  } else if (!s.blocked) {
    s.blocked =
      prompt === 'typing'
        ? '입력 칸에 글이 남은 채 멈춤(보내지지 않음) — 그 터미널을 확인해 주세요'
        : permissionPrompt(lines)
          ? personNote
          : '입력 칸이 보이지 않은 채 멈춤(시작 화면·선택 창) — 그 터미널을 확인해 주세요'
    notices.push(`${s.name}: ${s.blocked}`)
  }
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

/** 에이전트 상태 알림 — 띄운 에이전트가 일을 시작했다가 멈추면 끝난 것으로 기록한다. */
/** 상태 알림이 오면 onAgentStatus 앞에서 그 터미널 화면을 한 번 읽는다(30초 확인을 기다리지 않는다).
 *  - 글을 아직 확인 못 했으면 화면에서 찾는다 — 짧은 일은 확인 전에 끝나 알림을 다 버리고 화면 기준(3분)으로만 끝났다.
 *  - 멈춤 알림(done·waiting)인데 화면에 권한·질문 창이 떠 있으면 끝이 아니라 사람을 기다리는 것이다. Claude Code
 *    질문 창에 Orca 는 waiting 을 낼 때도, done 을 낼 때도 있고, 첫 알림은 창이 그려지기 조금 전에 온다(1.4.255 실측
 *    0.16초) — 멈춤 알림이면 settleMs 만큼 기다렸다 읽는다. hold 면 그 알림으로 끝내지 않는다. */
export async function inspectOnEvent(
  list: Schedule[],
  e: StatusEvent,
  io: Io,
  settleMs = 0
): Promise<{ changed: boolean; notices: string[]; hold: boolean }> {
  const out = { changed: false, notices: [] as string[], hold: false }
  const stops = e.state === 'done' || e.state === 'waiting'
  if (stops && settleMs > 0 && list.some((s) => s.terminalId === e.terminalId && s.sentAt !== null)) {
    await new Promise((r) => setTimeout(r, settleMs))
  }
  for (const s of list) {
    if (!e.terminalId || s.terminalId !== e.terminalId || s.sentAt === null) continue
    if (s.delivered && !stops) continue
    let lines: string[] | null
    try {
      lines = await io.read(s.terminalId)
    } catch {
      continue // 못 읽으면 다음 확인 때 본다
    }
    if (!lines) continue
    if (!s.delivered && promptVisible(lines, s.prompt)) {
      s.delivered = true
      out.changed = true
    }
    if (s.delivered && stops && permissionPrompt(lines)) {
      out.hold = true
      if (!s.blocked) {
        s.blocked = personNote
        out.notices.push(`${s.name}: ${personNote}`)
        out.changed = true
      }
    }
  }
  return out
}

export function onAgentStatus(list: Schedule[], e: StatusEvent): { changed: boolean; notices: string[] } {
  const notices: string[] = []
  if (!e.terminalId) return { changed: false, notices }
  let changed = false
  for (const s of list) {
    // 글이 화면에 보이기 전의 알림은 시작 과정이다 — Codex 는 뜨면서 working → done 을 한 번 낸다(1.4.255 실측).
    if (s.terminalId !== e.terminalId || s.sentAt === null || !s.delivered) continue
    if (e.state === 'working') {
      if (!s.sawWorking || s.blocked) changed = true
      s.sawWorking = true
      s.blocked = null
    } else if (e.state === 'blocked') {
      if (!s.blocked) {
        s.blocked = personNote
        notices.push(`${s.name}: 권한·질문 창에서 멈춤`)
        changed = true
      }
    } else if (s.sawWorking) {
      const outcome = e.mainAgent?.outcome
      const status = (outcome && outcomeStatus[outcome]) ?? (e.state === 'waiting' ? '끝남(입력 대기)' : '끝남')
      finish(s, e.receivedAt, status)
      // 입력 대기 — 질문 창에 답을 기다리며 멈췄다. 할 일을 마친 게 아니니 사람이 볼 수 있게 알린다.
      if (status === '끝남(입력 대기)') notices.push(`${s.name}: 질문·확인을 기다리며 멈춤 — 그 터미널을 확인해 주세요`)
      else if (status === '실패' || status === '중단') notices.push(`${s.name}: ${status}`)
      changed = true
    }
  }
  return { changed, notices }
}
