// src/worker.ts 를 Orca 가 주는 것과 같은 orca 객체(가짜 host)로 띄운다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliResult } from './cli'
import { blankSchedule, type Schedule } from './engine'
import * as main from './worker'

/** 가짜 Orca CLI — 받은 인자를 모으고, 띄우기는 글이 넘어간 터미널을 돌려준다. */
function fakeCli() {
  const calls: string[][] = []
  main.cli.run = async (args): Promise<CliResult> => {
    calls.push(args)
    if (args[0] === 'agent') {
      return { ok: true, result: { outcome: { kind: 'terminal', handle: 'term_new' }, prompt: { delivery: 'submit', outcome: 'handed-to-terminal' } } }
    }
    return { ok: true, result: { terminals: [{ handle: 'term_new' }, { handle: 't1' }] } }
  }
  return calls
}

const rule = '──────────────────────────────'

function host(storage: Record<string, unknown> = {}) {
  return mockHost({
    storage: storage as never,
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'sonix_docs', path: '/repo/docs', branch: 'main', hostId: null },
          { id: 'w2', kind: 'folder', name: 'toy', path: '/toy', branch: null, hostId: null }
        ],
        truncated: false
      },
      'terminal.read': { lines: ['끝', rule, '❯ ', rule], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
}

const draft = {
  name: '아침 리포트',
  workspaceId: 'w1',
  workspace: 'sonix_docs',
  agent: 'claude',
  cron: '0 9 * * 1-5',
  prompt: '오늘 할 일 정리',
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
    [{ ...draft, workspaceId: '' }, /워크스페이스/],
    [{ ...draft, agent: 'aider' }, /에이전트/],
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

test('워크스페이스 목록을 패널에 넘긴다', async () => {
  const worker = await mountWorker(main, { host: host() })
  const list = (await worker.request('workspaces.list')) as { id: string; name: string }[]
  assert.deepEqual(
    list.map((w) => [w.id, w.name]),
    [
      ['w1', 'sonix_docs'],
      ['w2', 'toy']
    ]
  )
  await worker.deactivate()
})

test('지금 보내기 — Orca CLI 로 고른 워크스페이스에 에이전트를 띄우고 그 터미널을 기억한다', async () => {
  const calls = fakeCli()
  const h = host()
  const worker = await mountWorker(main, { host: h })
  const s = (await worker.request('schedules.save', draft)) as Schedule
  await worker.request('schedules.runNow', { id: s.id })
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(
    calls.filter((c) => c[0] === 'agent'),
    [['agent', 'launch', '--agent', 'claude', '--surface', 'terminal', '--worktree', 'w1', '--prompt', '오늘 할 일 정리']]
  )
  const stored = (h.data().storage.schedules as Schedule[])[0]
  assert.equal(stored.terminalId, 'term_new')
  assert.ok(stored.sentAt)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  main.cli.run = null
})

test('띄운 예약은 에이전트가 일하다 멈추면 결과를 남긴다', async () => {
  const sent: Schedule = { ...blankSchedule('s1'), ...draft, terminalId: 't1', sentAt: Date.now() - 60_000, delivered: true, lastStatus: '보냄' }
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

test('글을 아직 확인 못 한 회차도 상태 알림 때 화면에서 글을 찾으면 그 알림으로 끝낸다', async () => {
  const sent: Schedule = { ...blankSchedule('s1'), ...draft, terminalId: 't1', sentAt: Date.now() - 5_000, lastStatus: '보냄' }
  const h = mockHost({
    storage: { schedules: [sent] } as never,
    results: {
      'terminal.read': { lines: ['Claude Code', rule, '❯\u00a0Try "fix lint errors"', rule], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host: h })
  // 켤 때 도는 첫 확인은 글이 아직 없는 화면을 본다 — 그 뒤 글이 들어가 짧게 끝난다(다음 확인은 30초 뒤)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(h.callsOf('terminal.read').length, 1)
  assert.equal((h.data().storage.schedules as Schedule[])[0].delivered, false)
  h.respond('terminal.read', { lines: ['❯ 오늘 할 일 정리', '⏺ 정리했습니다'], truncated: false })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 't1', state: 'working', receivedAt: Date.now() })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: Date.now() })
  const stored = h.data().storage.schedules as Schedule[]
  assert.equal(stored[0].delivered, true)
  assert.equal(stored[0].sentAt, null)
  assert.equal(stored[0].history[0].status, '끝남')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('질문 창에서 멈춘 회차는 done 알림이 와도 끝내지 않고 확인 필요로 남긴다', async () => {
  const sent: Schedule = { ...blankSchedule('s1'), ...draft, terminalId: 't1', sentAt: Date.now() - 60_000, delivered: true, sawWorking: true, lastStatus: '보냄' }
  const h = mockHost({
    storage: { schedules: [sent] } as never,
    results: {
      'terminal.read': { lines: ['❯ 오늘 할 일 정리', '  1. 예', '  2. 아니오', 'Enter to select · ↑/↓ to navigate · Esc to cancel'], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host: h })
  await new Promise((r) => setTimeout(r, 50))
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: Date.now() })
  const stored = h.data().storage.schedules as Schedule[]
  assert.ok(stored[0].sentAt, '아직 끝나지 않음')
  assert.equal(stored[0].history.length, 0)
  assert.match(stored[0].blocked ?? '', /권한·질문 창/)
  assert.equal(h.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
