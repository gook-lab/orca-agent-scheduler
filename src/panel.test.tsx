// `orca plugin test .` 가 Orca 와 같은 런타임·검사로 돌린다.
import { assert, mockHost, mount, test } from 'orca/testing'
import { blankSchedule, type Schedule } from './engine'
import type { ScheduleDraft, WorkspaceOption } from './protocol'
import * as panel from './panel'

const workspaces: WorkspaceOption[] = [
  { id: 'w1', kind: 'worktree', name: 'sonix_docs', path: '/repo/docs', branch: 'main' },
  { id: 'w2', kind: 'folder', name: 'toy', path: '/toy', branch: null }
]

function host(saved: ScheduleDraft[], list: Schedule[] = []) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'sonix_docs', terminals: [] }
    },
    requests: {
      'schedules.list': () => list,
      'workspaces.list': () => workspaces,
      'schedules.save': (d) => {
        saved.push(d)
        return { ...blankSchedule('s1'), ...(d as object) } as never
      }
    }
  })
}

test('예약이 없으면 안내를 보이고, 새 예약을 만든다', async () => {
  const saved: ScheduleDraft[] = []
  const view = await mount(panel, { host: host(saved) })
  assert.ok(view.summary().some((l) => l.includes('예약이 없습니다')))
  await view.toggle({ label: '새 예약' })
  assert.equal(view.find({ label: '워크스페이스' })?.props.value, 'w1', '지금 보고 있는 워크스페이스가 기본값')
  await view.type({ label: '이름' }, '아침 리포트')
  await view.select({ label: '워크스페이스' }, 'w2')
  await view.select({ label: '에이전트' }, 'codex')
  await view.select({ label: '요일' }, 'weekdays')
  await view.type({ label: '시각' }, '09:00, 18:00', { replace: true })
  assert.ok(view.find({ text: '평일 09:00 · 18:00' }))
  await view.type({ label: '보낼 글' }, '오늘 할 일')
  await view.press({ text: '예약 만들기' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].cron, '0 9,18 * * 1-5')
  assert.equal(saved[0].agent, 'codex')
  assert.equal(saved[0].workspaceId, 'w2')
  assert.equal(saved[0].workspace, 'toy')
  assert.equal('id' in saved[0], false, '새 예약은 id 칸을 보내지 않음')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('틀린 시각은 저장을 막는다', async () => {
  const view = await mount(panel, { host: host([]) })
  await view.toggle({ label: '새 예약' })
  await view.type({ label: '시각' }, '25:00', { replace: true })
  assert.ok(view.find({ text: /쉼표로 나눠/ }))
  assert.equal(view.find({ text: '예약 만들기' })?.props.disabled, true)
  await view.unmount()
})

test('worker 가 고친 목록을 따라 그린다', async () => {
  const view = await mount(panel, { host: host([]) })
  const s: Schedule = {
    ...blankSchedule('s1'),
    name: '아침 리포트',
    workspaceId: 'w1',
    workspace: 'sonix_docs',
    nextRunAt: Date.now() + 3600_000,
    pendingSince: Date.now(),
    waitNote: '지난 회차가 아직 실행 중 — 끝나면 띄움',
    lastStatus: '성공',
    history: [{ at: Date.now() - 86400_000, status: '성공', summary: '걸린 시간 3분' }]
  }
  await view.post('schedules.changed', { schedules: [s] })
  assert.ok(JSON.stringify(view.tree()).includes('아침 리포트'))
  assert.ok(view.summary().some((l) => l.includes('지난 회차가 아직 실행 중')))
  assert.ok(view.find({ text: '성공' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('없어진 워크스페이스에 걸린 예약은 다시 고르라고 알린다', async () => {
  const view = await mount(panel, { host: host([]) })
  const s: Schedule = { ...blankSchedule('s2'), name: '지운 작업', workspaceId: 'w-gone', workspace: 'old', prompt: 'x' }
  await view.post('schedules.changed', { schedules: [s] })
  assert.ok(view.summary().some((l) => l.includes('워크스페이스가 없어졌습니다')))
  await view.unmount()
})
