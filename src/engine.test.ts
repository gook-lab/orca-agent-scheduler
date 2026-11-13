import { assert, test } from 'orca/testing'
import { blankSchedule, inspectOnEvent, type Io, limits, newMemory, onAgentStatus, type Schedule, tick } from './engine'

const rule = '──────────────────────────────'
const idle = ['❯ 오늘 할 일', '⏺ 끝', rule, '❯ ', rule]
/** 에이전트만 뜨고 글은 안 들어간 화면. */
const fresh = ['Claude Code', rule, '❯\u00a0Try "fix lint errors"', rule]

function fakeIo(screens: Record<string, string[] | null | 'error'> = {}, launchError?: string, alive: Set<string> | null = null) {
  const launched: [string, string, string][] = []
  const io: Io = {
    async read(id) {
      const s = screens[id]
      if (s === 'error') throw new Error('busy')
      return s === undefined ? null : s
    },
    async launch(workspaceId, agent, prompt) {
      if (launchError) return { error: launchError }
      launched.push([workspaceId, agent, prompt])
      return { terminalId: `t${launched.length}` }
    },
    async alive() {
      return alive
    }
  }
  return { io, launched, screens }
}

function sched(over: Partial<Schedule> = {}): Schedule {
  return { ...blankSchedule('s1'), name: '아침', workspaceId: 'w1', workspace: 'docs', agent: 'claude', cron: '0 9 * * *', prompt: '오늘 할 일', ...over }
}

const nine = new Date(2026, 10, 13, 9, 0).getTime()
const min = 60_000

test('시각이 되면 고른 워크스페이스에 새 에이전트를 띄워 글을 넣는다', async () => {
  const s = sched({ nextRunAt: nine })
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine + 10_000)
  assert.deepEqual(f.launched, [['w1', 'claude', '오늘 할 일']])
  assert.equal(s.terminalId, 't1')
  assert.equal(s.sentAt, nine + 10_000)
  assert.equal(s.pendingSince, null)
  assert.equal(s.lastStatus, '보냄')
  assert.equal(s.nextRunAt, new Date(2026, 10, 14, 9, 0).getTime())
})

test('띄우지 못하면 실패로 남기고 알린다', async () => {
  const s = sched({ pendingSince: nine })
  const r = await tick([s], fakeIo({}, 'workspace not found').io, newMemory(), nine)
  assert.equal(s.history[0].status, '실패')
  assert.match(s.history[0].summary ?? '', /workspace not found/)
  assert.equal(s.sentAt, null)
  assert.equal(s.pendingSince, null)
  assert.equal(r.notices.length, 1)
})

test('지난 회차가 아직 돌면 기다렸다가, 60분 넘으면 이번 회차를 건너뛴다', async () => {
  const s = sched({ sentAt: nine - 10 * min, terminalId: 't9', delivered: true, sawWorking: true, nextRunAt: nine })
  const f = fakeIo({ t9: ['작업 중 ⠋'] })
  await tick([s], f.io, newMemory(), nine)
  assert.equal(f.launched.length, 0)
  assert.match(s.waitNote ?? '', /지난 회차/)
  await tick([s], f.io, newMemory(), nine + limits.maxWaitMs)
  assert.equal(s.history[0].status, '건너뜀')
  assert.equal(s.pendingSince, null)
  assert.equal(f.launched.length, 0)
})

test('지난 회차가 끝나면 기다리던 회차를 띄운다', async () => {
  const s = sched({ sentAt: nine - 10 * min, terminalId: 't9', delivered: true, sawWorking: true, pendingSince: nine })
  onAgentStatus([s], { terminalId: 't9', state: 'done', receivedAt: nine + min })
  assert.equal(s.history[0].status, '끝남')
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine + 2 * min)
  assert.equal(f.launched.length, 1)
  assert.equal(s.terminalId, 't1')
})

test('상태 알림 — 일하다 멈추면 성공·실패로 기록, 권한 창이면 알린다', () => {
  const s = sched({ sentAt: nine, terminalId: 't1', delivered: true })
  onAgentStatus([s], { terminalId: 't1', state: 'done', receivedAt: nine + 1000 })
  assert.equal(s.sentAt, nine, '일을 시작하기 전의 done 은 무시')
  onAgentStatus([s], { terminalId: 't2', state: 'working', receivedAt: nine + 1500 })
  assert.equal(s.sawWorking, false, '다른 터미널 알림은 무시')
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 2000 })
  const blocked = onAgentStatus([s], { terminalId: 't1', state: 'blocked', receivedAt: nine + 3000 })
  assert.ok(s.blocked)
  assert.equal(blocked.notices.length, 1)
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 4000 })
  assert.equal(s.blocked, null)
  onAgentStatus([s], {
    terminalId: 't1',
    state: 'done',
    receivedAt: nine + 5 * min,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: nine + 5 * min }
  })
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, '성공')
  assert.equal(s.history[0].summary, '걸린 시간 5분')
  const other = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
  const waiting = onAgentStatus([other], { terminalId: 't1', state: 'waiting', receivedAt: nine + min })
  assert.equal(other.history[0].status, '끝남(입력 대기)')
  assert.equal(waiting.notices.length, 1, '질문에 답을 기다리면 알린다')
  const done = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
  assert.equal(onAgentStatus([done], { terminalId: 't1', state: 'done', receivedAt: nine + min }).notices.length, 0, '그냥 끝나면 알리지 않는다')
})

test('상태 알림이 없으면 화면이 3분 조용하고 입력 칸이 비었을 때 끝난 것으로 본다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  const memory = newMemory()
  const f = fakeIo({ t1: idle })
  await tick([s], f.io, memory, nine + min)
  assert.notEqual(s.sentAt, null, '처음 본 화면은 조용한지 모름')
  await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, '끝남')
  assert.match(s.history[0].summary ?? '', /화면 기준/)
})

test('일을 시작했다는 알림을 받았어도 끝 알림을 놓치면 화면으로 끝낸다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
  const memory = newMemory()
  const f = fakeIo({ t1: idle })
  await tick([s], f.io, memory, nine + min)
  await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.equal(s.history[0].status, '끝남')
})

test('입력 칸이 안 보인 채 화면이 멈추면 확인해 달라고 한 번 알리고, 화면이 움직이면 거둔다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1', agent: 'codex' })
  const memory = newMemory()
  const dialog = ['Update available', '› 1. Update now', '  2. Skip']
  const f = fakeIo({ t1: dialog })
  await tick([s], f.io, memory, nine + min)
  const r = await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.match(s.blocked ?? '', /입력 칸이 보이지 않은 채/)
  assert.equal(r.notices.length, 1)
  const again = await tick([s], f.io, memory, nine + 2 * min + limits.finishedQuietMs)
  assert.equal(again.notices.length, 0, '같은 멈춤은 다시 알리지 않음')
  assert.equal(s.sentAt, nine, '멈춤은 끝이 아님')
  f.screens.t1 = ['작업 중', '› ']
  await tick([s], f.io, memory, nine + 3 * min + limits.finishedQuietMs)
  assert.equal(s.blocked, null)
})

test('권한 창에서 멈추면 그 이유로 알린다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  const memory = newMemory()
  const f = fakeIo({ t1: ['Do you want to proceed?', '❯ 1. Yes', '  2. No'] })
  await tick([s], f.io, memory, nine + min)
  await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.match(s.blocked ?? '', /권한·질문 창/)
})

test('띄운 터미널이 닫히면 중단으로 남기고, 잠깐 못 읽으면 다음에 다시 본다', async () => {
  // 플러그인의 화면 읽기는 닫힌 터미널에도 빈 화면을 돌려줄 수 있어 살아 있는 터미널 목록으로 판정한다.
  const closed = sched({ sentAt: nine, terminalId: 't1' })
  await tick([closed], fakeIo({ t1: [] }, undefined, new Set(['t2'])).io, newMemory(), nine + min)
  assert.equal(closed.history[0].status, '중단')
  assert.match(closed.history[0].summary ?? '', /닫혀/)
  const busy = sched({ sentAt: nine, terminalId: 't1' })
  await tick([busy], fakeIo({ t1: 'error' }).io, newMemory(), nine + min)
  assert.equal(busy.history.length, 0)
  assert.equal(busy.sentAt, nine)
})

test('6시간 넘게 안 끝나면 결과 없음', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
  await tick([s], fakeIo({ t1: idle }).io, newMemory(), nine + limits.resultTimeoutMs)
  assert.equal(s.history[0].status, '결과 없음')
  assert.equal(s.sentAt, null)
})

test('꺼 둔 예약은 대기에 올리지 않는다', async () => {
  const s = sched({ enabled: false, nextRunAt: nine })
  const f = fakeIo()
  await tick([s], f.io, newMemory(), nine + min)
  assert.equal(s.pendingSince, null)
  assert.equal(s.nextRunAt, null)
  assert.equal(f.launched.length, 0)
})

test('글이 화면에 보이기 전의 상태 알림은 시작 과정으로 보고 무시한다', () => {
  const s = sched({ sentAt: nine, terminalId: 't1', agent: 'codex' })
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 1000 })
  onAgentStatus([s], { terminalId: 't1', state: 'done', receivedAt: nine + 2000 })
  assert.equal(s.sentAt, nine)
  assert.equal(s.history.length, 0)
})

test('글이 화면에 보이면 들어간 것으로 기록하고, 그 뒤 상태 알림으로 끝낸다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  await tick([s], fakeIo({ t1: ['❯ 오늘 할 일', '⠋ 작업 중'] }).io, newMemory(), nine + 30_000)
  assert.equal(s.delivered, true)
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 40_000 })
  onAgentStatus([s], { terminalId: 't1', state: 'done', receivedAt: nine + 2 * min, mainAgent: { state: 'done', outcome: 'success', stateStartedAt: nine } })
  assert.equal(s.history[0].status, '성공')
})

test('확인 전에 끝나는 짧은 일 — 알림이 오면 그 자리에서 화면을 읽어 글을 확인하고 알림으로 끝낸다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  const f = fakeIo({ t1: fresh })
  // 띄운 직후 — 글이 아직 화면에 없으니 시작 과정 알림은 그대로 버린다(Codex 의 시작 working → done)
  assert.equal((await inspectOnEvent([s], { terminalId: 't1', state: 'working', receivedAt: nine + 1000 }, f.io)).changed, false)
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 1000 })
  assert.equal((await inspectOnEvent([s], { terminalId: 't1', state: 'done', receivedAt: nine + 2000 }, f.io)).changed, false)
  onAgentStatus([s], { terminalId: 't1', state: 'done', receivedAt: nine + 2000 })
  assert.equal(s.history.length, 0)
  // 글이 들어가 일을 시작 — 30초 확인 전이어도 알림 때 화면으로 확인한다
  f.screens.t1 = ['❯ 오늘 할 일', '⠋ 작업 중']
  assert.equal((await inspectOnEvent([s], { terminalId: 't1', state: 'working', receivedAt: nine + 5000 }, f.io)).changed, true)
  onAgentStatus([s], { terminalId: 't1', state: 'working', receivedAt: nine + 5000 })
  onAgentStatus([s], { terminalId: 't1', state: 'done', receivedAt: nine + 9000 })
  assert.equal(s.history[0].status, '끝남')
  assert.equal(s.sentAt, null)
  // 다른 터미널·못 읽는 화면은 건드리지 않는다
  const other = sched({ id: 's2', sentAt: nine, terminalId: 't2' })
  assert.equal((await inspectOnEvent([other], { terminalId: 't2', state: 'working', receivedAt: nine }, fakeIo({ t2: 'error' }).io)).changed, false)
  assert.equal((await inspectOnEvent([other], { terminalId: 't3', state: 'working', receivedAt: nine }, fakeIo({ t2: ['❯ 오늘 할 일'] }).io)).changed, false)
  assert.equal(other.delivered, false)
})

test('멈춤 알림 때 화면에 권한·질문 창이 떠 있으면 끝내지 않고 사람을 기다린다고 알린다', async () => {
  // Claude Code 질문 창 실화면(2026-11-13) — Orca 는 이때 waiting 도, done 도 낸다
  const question = ['❯ 오늘 할 일', '  1. 예', '  2. 아니오', rule, '  3. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel']
  for (const state of ['done', 'waiting'] as const) {
    const s = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
    const f = fakeIo({ t1: question })
    const seen = await inspectOnEvent([s], { terminalId: 't1', state, receivedAt: nine + min }, f.io)
    assert.equal(seen.hold, true, state)
    assert.equal(seen.notices.length, 1)
    assert.match(s.blocked ?? '', /권한·질문 창/)
    assert.equal((await inspectOnEvent([s], { terminalId: 't1', state, receivedAt: nine + 2 * min }, f.io)).notices.length, 0, '두 번 알리지 않는다')
    assert.equal(s.sentAt, nine)
    assert.equal(s.history.length, 0)
  }
  // 일하는 중 알림은 화면을 읽지 않고, 그냥 끝난 화면이면 hold 가 아니다
  const s = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
  let reads = 0
  const counting: Io = { ...fakeIo().io, read: async () => (reads++, question) }
  assert.equal((await inspectOnEvent([s], { terminalId: 't1', state: 'working', receivedAt: nine }, counting)).hold, false)
  assert.equal(reads, 0, '글을 확인한 뒤의 working 알림마다 화면을 읽지 않는다')
  assert.equal((await inspectOnEvent([s], { terminalId: 't1', state: 'done', receivedAt: nine }, fakeIo({ t1: idle }).io)).hold, false)
})

test('질문 창은 첫 멈춤 알림보다 늦게 그려진다 — 잠깐 기다렸다 읽어야 끝으로 잘못 남기지 않는다', async () => {
  const question = ['  1. 예', '  2. 아니오', 'Enter to select · ↑/↓ to navigate · Esc to cancel']
  const run = async (settleMs: number) => {
    const s = sched({ sentAt: nine, terminalId: 't1', delivered: true, sawWorking: true })
    const f = fakeIo({ t1: idle })
    setTimeout(() => (f.screens.t1 = question), 10) // 실측: 첫 waiting 0.16초 뒤에 그려짐
    return inspectOnEvent([s], { terminalId: 't1', state: 'waiting', receivedAt: nine }, f.io, settleMs)
  }
  assert.equal((await run(0)).hold, false, '바로 읽으면 빈 입력 칸만 보인다')
  assert.equal((await run(60)).hold, true)
})

test('에이전트만 뜨고 글이 안 들어간 채 조용하면 「끝남」이 아니라 실패로 남긴다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  const memory = newMemory()
  const f = fakeIo({ t1: fresh })
  await tick([s], f.io, memory, nine + min)
  const r = await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.equal(s.history[0].status, '실패')
  assert.match(s.history[0].summary ?? '', /글이 화면에 보이지 않음/)
  assert.equal(s.sentAt, null)
  assert.equal(r.notices.length, 1)
})

test('입력 칸에 글이 남은 채 멈추면 보내지지 않았다고 알린다', async () => {
  const s = sched({ sentAt: nine, terminalId: 't1' })
  const memory = newMemory()
  const f = fakeIo({ t1: ['Claude Code', rule, '❯ 오늘 할 일', rule] })
  await tick([s], f.io, memory, nine + min)
  await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.match(s.blocked ?? '', /입력 칸에 글이 남은 채/)
  assert.equal(s.sentAt, nine)
})
