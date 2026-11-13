import { assert, test } from 'orca/testing'
import { blankSchedule, type Io, limits, newMemory, onAgentStatus, type Schedule, tick } from './engine'

const rule = '──────────────────────────────'
const idle = ['끝', rule, '❯ ', rule]

function fakeIo(screens: Record<string, string[] | null | 'error'>) {
  const sent: [string, string][] = []
  const io: Io = {
    async read(id) {
      const s = screens[id]
      if (s === 'error') throw new Error('busy')
      return s === undefined ? null : s
    },
    async send(id, text) {
      sent.push([id, text])
      return true
    }
  }
  return { io, sent, screens }
}

function sched(over: Partial<Schedule> = {}): Schedule {
  return { ...blankSchedule('s1'), name: '아침', terminalId: 't1', terminalTitle: '작업', agent: 'claude', cron: '0 9 * * *', prompt: '오늘 할 일', ...over }
}

const nine = new Date(2026, 10, 13, 9, 0).getTime()
const min = 60_000

test('시각이 되면 대기에 올리고, 화면이 1분 조용하면 보낸다', async () => {
  const s = sched({ nextRunAt: nine })
  const memory = newMemory()
  const f = fakeIo({ t1: idle })
  await tick([s], f.io, memory, nine + 10_000)
  assert.equal(s.pendingSince, nine)
  assert.equal(s.nextRunAt, new Date(2026, 10, 14, 9, 0).getTime())
  assert.equal(f.sent.length, 0, '처음 본 화면은 조용한지 모름')
  assert.match(s.waitNote ?? '', /화면이 1분/)
  await tick([s], f.io, memory, nine + 10_000 + limits.quietMs)
  assert.deepEqual(f.sent, [['t1', '오늘 할 일']])
  assert.equal(s.sentAt, nine + 10_000 + limits.quietMs)
  assert.equal(s.pendingSince, null)
  assert.equal(s.lastStatus, '보냄')
})

test('일하는 중·쓰던 글이 있으면 기다리고, 60분 넘으면 건너뛴다', async () => {
  const s = sched({ pendingSince: nine })
  const memory = newMemory()
  memory.screens.set('t1', { hash: 'x', changedAt: 0 })
  memory.agents.set('t1', { state: 'working', since: 0 })
  const f = fakeIo({ t1: [rule, '❯ 쓰는 중', rule] })
  await tick([s], f.io, memory, nine + min)
  assert.equal(s.waitNote, '에이전트가 작업 중')
  memory.agents.set('t1', { state: 'done', since: 0 })
  await tick([s], f.io, memory, nine + 1.5 * min)
  assert.equal(s.waitNote, '화면이 1분 안에 움직임(작업 중이거나 입력 중)', '첫 확인 때 화면이 바뀐 것으로 봄')
  await tick([s], f.io, memory, nine + 3 * min)
  assert.equal(s.waitNote, '입력 칸에 쓰던 글이 있음')
  await tick([s], f.io, memory, nine + limits.maxWaitMs)
  assert.equal(s.pendingSince, null)
  assert.equal(s.history[0].status, '건너뜀')
  assert.equal(f.sent.length, 0)
})

test('터미널이 없으면 건너뛰고, 잠깐 못 읽으면 기다린다', async () => {
  const gone = sched({ pendingSince: nine })
  await tick([gone], fakeIo({}).io, newMemory(), nine + min)
  assert.equal(gone.history[0].status, '건너뜀')
  assert.match(gone.history[0].summary ?? '', /찾을 수 없음/)
  const busy = sched({ pendingSince: nine })
  await tick([busy], fakeIo({ t1: 'error' }).io, newMemory(), nine + min)
  assert.equal(busy.history.length, 0)
  assert.match(busy.waitNote ?? '', /읽지 못함/)
})

test('권한 창이 떠 있으면 그 이유로 기다린다', async () => {
  const s = sched({ pendingSince: nine })
  const memory = newMemory()
  memory.screens.set('t1', { hash: ['Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n'), changedAt: 0 })
  await tick([s], fakeIo({ t1: ['Do you want to proceed?', '❯ 1. Yes', '  2. No'] }).io, memory, nine + min)
  assert.equal(s.waitNote, '권한 확인 창이 떠 있음')
})

test('새 대화 — /clear 를 보내고 다음 확인 때 본문을 보낸다', async () => {
  const s = sched({ pendingSince: nine, clearFirst: true })
  const memory = newMemory()
  memory.screens.set('t1', { hash: idle.join('\n'), changedAt: 0 })
  const f = fakeIo({ t1: idle })
  await tick([s], f.io, memory, nine + min)
  assert.deepEqual(f.sent, [['t1', '/clear']])
  await tick([s], f.io, memory, nine + 1.5 * min)
  assert.equal(f.sent.length, 1, '/clear 뒤 1분은 기다림')
  await tick([s], f.io, memory, nine + 3 * min)
  assert.deepEqual(f.sent[1], ['t1', '오늘 할 일'])
})

test('같은 터미널의 두 예약은 한 번에 하나만', async () => {
  const a = sched({ id: 'a', pendingSince: nine })
  const b = sched({ id: 'b', pendingSince: nine })
  const memory = newMemory()
  memory.screens.set('t1', { hash: idle.join('\n'), changedAt: 0 })
  const f = fakeIo({ t1: idle })
  await tick([a, b], f.io, memory, nine + min)
  assert.equal(f.sent.length, 1)
  assert.match(b.waitNote ?? '', /같은 터미널/)
})

test('상태 알림 — 일하다 멈추면 성공·실패로 기록, 권한 창이면 알린다', () => {
  const s = sched({ sentAt: nine })
  const memory = newMemory()
  onAgentStatus([s], memory, { terminalId: 't1', state: 'done', receivedAt: nine + 1000 })
  assert.equal(s.sentAt, nine, '일을 시작하기 전의 done 은 무시')
  onAgentStatus([s], memory, { terminalId: 't1', state: 'working', receivedAt: nine + 2000 })
  const blocked = onAgentStatus([s], memory, { terminalId: 't1', state: 'blocked', receivedAt: nine + 3000 })
  assert.ok(s.blocked)
  assert.equal(blocked.notices.length, 1)
  onAgentStatus([s], memory, { terminalId: 't1', state: 'working', receivedAt: nine + 4000 })
  assert.equal(s.blocked, null)
  onAgentStatus([s], memory, {
    terminalId: 't1',
    state: 'done',
    receivedAt: nine + 5 * min,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: nine + 5 * min }
  })
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, '성공')
  assert.equal(s.history[0].summary, '걸린 시간 5분')
  const other = sched({ sentAt: nine, sawWorking: true })
  onAgentStatus([other], memory, { terminalId: 't1', state: 'waiting', receivedAt: nine + min })
  assert.equal(other.history[0].status, '끝남(입력 대기)')
})

test('상태 알림이 없으면 화면이 3분 조용하고 입력 칸이 비었을 때 끝난 것으로 본다', async () => {
  const s = sched({ sentAt: nine })
  const memory = newMemory()
  const f = fakeIo({ t1: idle })
  await tick([s], f.io, memory, nine + min)
  assert.notEqual(s.sentAt, null)
  await tick([s], f.io, memory, nine + min + limits.finishedQuietMs)
  assert.equal(s.sentAt, null)
  assert.equal(s.history[0].status, '끝남')
})

test('6시간 넘게 안 끝나면 결과 없음', async () => {
  const s = sched({ sentAt: nine, sawWorking: true })
  await tick([s], fakeIo({ t1: idle }).io, newMemory(), nine + limits.resultTimeoutMs)
  assert.equal(s.history[0].status, '결과 없음')
})

test('꺼 둔 예약은 대기에 올리지 않는다', async () => {
  const s = sched({ enabled: false, nextRunAt: nine })
  await tick([s], fakeIo({ t1: idle }).io, newMemory(), nine + min)
  assert.equal(s.pendingSince, null)
  assert.equal(s.nextRunAt, null)
})
