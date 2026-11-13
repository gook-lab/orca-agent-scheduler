// `orca plugin test .` 가 Orca 와 같은 런타임·검사로 돌린다.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { Schedule } from './engine'
import type { ScheduleDraft } from './protocol'
import * as panel from './panel'

const agents = {
  agents: [
    { terminalId: 't1', title: '리포트 정리', agent: 'claude', state: 'done', stateStartedAt: 0 },
    { terminalId: 't2', title: '교차 검토', agent: 'codex', state: 'working', stateStartedAt: 0 },
    { terminalId: 't3', title: 'zsh', agent: null, state: 'done', stateStartedAt: 0 }
  ]
}

function host(saved: ScheduleDraft[], list: Schedule[] = []) {
  return mockHost({
    results: {
      'agents.list': agents,
      'workspace.readContext': { branch: 'main', displayName: 'sonix_docs', terminals: [] }
    },
    requests: {
      'schedules.list': () => list,
      'schedules.save': (d) => {
        saved.push(d)
        return { ...(d as object), id: 's1' } as never
      }
    }
  })
}

test('예약이 없으면 안내를 보이고, 새 예약을 만든다', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host(saved) })
  assert.ok(view.summary().some((l) => l.includes('예약이 없습니다')))
  await view.toggle({ label: '새 예약' })
  await view.type({ label: '이름' }, '아침 리포트')
  await view.select({ label: '터미널' }, 't2')
  await view.select({ label: '요일' }, 'weekdays')
  await view.type({ label: '시각' }, '09:00, 18:00', { replace: true })
  assert.ok(view.find({ text: '평일 09:00 · 18:00' }))
  await view.type({ label: '보낼 글' }, '오늘 할 일')
  await view.press({ text: '예약 만들기' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].cron, '0 9,18 * * 1-5')
  assert.equal(saved[0].agent, 'codex')
  assert.equal(saved[0].terminalTitle, '교차 검토')
  assert.equal(saved[0].workspace, 'sonix_docs')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('셸 터미널은 고를 목록에 없고, 틀린 시각은 저장을 막는다', async () => {
  const view = await mount(panel, { host: host([]) })
  await view.toggle({ label: '새 예약' })
  const select = view.find({ label: '터미널' })
  assert.ok(select)
  assert.ok(!JSON.stringify(view.tree()).includes('zsh'))
  await view.type({ label: '시각' }, '25:00', { replace: true })
  assert.ok(view.find({ text: /쉼표로 나눠/ }))
  assert.equal(view.find({ text: '예약 만들기' })?.props.disabled, true)
  await view.unmount()
})

test('worker 가 고친 목록을 따라 그린다', async () => {
  const view = await mount(panel, { host: host([]) })
  const s = {
    id: 's1',
    name: '아침 리포트',
    terminalId: 't1',
    terminalTitle: '리포트 정리',
    agent: 'claude',
    workspace: 'sonix_docs',
    cron: '0 9 * * 1-5',
    prompt: 'x',
    clearFirst: false,
    enabled: true,
    nextRunAt: Date.now() + 3600_000,
    pendingSince: Date.now(),
    waitNote: '에이전트가 작업 중',
    clearedFor: null,
    sentAt: null,
    sawWorking: false,
    blocked: null,
    lastStatus: '성공',
    history: [{ at: Date.now() - 86400_000, status: '성공', summary: '걸린 시간 3분' }]
  } satisfies Schedule
  await view.post('schedules.changed', { schedules: [s] })
  assert.ok(JSON.stringify(view.tree()).includes('아침 리포트'))
  assert.ok(view.summary().some((l) => l.includes('에이전트가 작업 중')))
  assert.ok(view.find({ text: '성공' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
