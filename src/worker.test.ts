// src/worker.ts 를 Orca 가 주는 것과 같은 orca 객체(가짜 host)로 띄운다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Schedule } from './engine'
import * as main from './worker'

const rule = '──────────────────────────────'

function host(storage: Record<string, unknown> = {}) {
  return mockHost({
    storage: storage as never,
    results: {
      'agents.list': { agents: [{ terminalId: 't1', title: '작업', agent: 'claude', state: 'done', stateStartedAt: 0 }] },
      'terminal.read': { lines: ['끝', rule, '❯ ', rule], truncated: false },
      'terminal.sendText': { accepted: true },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
}

const draft = {
  name: '아침 리포트',
  terminalId: 't1',
  terminalTitle: '작업',
  agent: 'claude',
  workspace: 'sonix_docs',
  cron: '0 9 * * 1-5',
  prompt: '오늘 할 일 정리',
  clearFirst: false,
  enabled: true
}

test('예약을 저장하면 다음 시각을 채워 storage 에 두고 패널에 알린다', async () => {
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const saved = (await worker.request('schedules.save', draft)) as Schedule
  assert.ok(saved.id)
  assert.ok(saved.nextRunAt && saved.nextRunAt > Date.now())
  const stored = h.data().storage.schedules as Schedule[]
  assert.equal(stored.length, 1)
  assert.equal(stored[0].name, '아침 리포트')
  assert.ok(worker.posts.some((p) => p.event === 'schedules.changed'))
  assert.ok(h.callsOf('statusBar.update').length > 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('틀린 예약은 이유와 함께 거절한다', async () => {
  const worker = await mountWorker(main, { host: host() })
  for (const [bad, why] of [
    [{ ...draft, name: ' ' }, /이름/],
    [{ ...draft, terminalId: '' }, /터미널/],
    [{ ...draft, prompt: '' }, /보낼 글/],
    [{ ...draft, cron: '0 9 31 2 *' }, /앞으로 돌지 않/]
  ] as const) {
    await assert.rejects(worker.request('schedules.save', bad), why)
  }
  await worker.deactivate()
})

test('끄기·고치기·지우기', async () => {
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  const off = (await worker.request('schedules.toggle', { id: s.id, enabled: false })) as Schedule
  assert.equal(off.enabled, false)
  assert.equal(off.nextRunAt, null)
  const edited = (await worker.request('schedules.save', { ...draft, id: s.id, name: '고친 이름', enabled: false })) as Schedule
  assert.equal(edited.id, s.id)
  assert.equal((h.data().storage.schedules as Schedule[]).length, 1)
  assert.equal((h.data().storage.schedules as Schedule[])[0].name, '고친 이름')
  await worker.request('schedules.delete', { id: s.id })
  assert.equal((h.data().storage.schedules as Schedule[]).length, 0)
  await assert.rejects(worker.request('schedules.toggle', { id: 'none', enabled: true }), /없는 예약/)
  await worker.deactivate()
})

test('보낸 예약은 에이전트가 일하다 멈추면 결과를 남긴다', async () => {
  const sent: Schedule = {
    ...(draft as unknown as Schedule),
    id: 's1',
    nextRunAt: null,
    pendingSince: null,
    waitNote: null,
    clearedFor: null,
    sentAt: Date.now() - 60_000,
    sawWorking: false,
    blocked: null,
    lastStatus: '보냄',
    history: []
  }
  const h = host({ schedules: [sent] })
  const worker = await mountWorker(main, { host: h })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 't1', state: 'working', receivedAt: Date.now() })
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'p',
    terminalId: 't1',
    state: 'done',
    receivedAt: Date.now(),
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: Date.now() }
  })
  const stored = h.data().storage.schedules as Schedule[]
  assert.equal(stored[0].sentAt, null)
  assert.equal(stored[0].history[0].status, '성공')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
