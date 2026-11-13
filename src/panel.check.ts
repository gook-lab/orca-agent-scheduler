// `orca plugin check` 가 상황마다 패널을 한 번씩 그린다(worker 도 같은 가짜 host 위에서 돈다).
import { defineCheck } from 'orca/testing'

const now = Date.now()
const base = {
  workspaceId: 'w1',
  workspace: 'sonix_docs',
  agent: 'claude',
  prompt: '오늘 할 일 정리',
  enabled: true,
  pendingSince: null,
  waitNote: null,
  terminalId: null,
  sentAt: null,
  sawWorking: false,
  blocked: null,
  lastStatus: null,
  history: []
}
const results = {
  'workspace.readContext': { branch: 'main', displayName: 'sonix_docs', terminals: [] },
  'workspace.list': {
    workspaces: [
      { id: 'w1', kind: 'worktree', name: 'sonix_docs', path: '/repo/docs', branch: 'main', hostId: null },
      { id: 'w2', kind: 'folder', name: 'notes', path: '/notes', branch: null, hostId: null }
    ],
    truncated: false
  },
  'terminal.read': { lines: ['──────────────────────────────', '❯ 작업 중', '──────────────────────────────'], truncated: false },
  'statusBar.update': { ok: true }
}

export default defineCheck({
  empty: { results },
  busy: {
    results,
    storage: {
      schedules: [
        {
          ...base,
          id: 's1',
          name: '아침 리포트 정리',
          cron: '0 9 * * 1-5',
          nextRunAt: now + 3 * 3600_000,
          lastStatus: '성공',
          history: [{ at: now - 86400_000, status: '성공', summary: '걸린 시간 4분' }]
        },
        {
          ...base,
          id: 's2',
          name: 'PR 교차 검토',
          agent: 'codex',
          cron: '30 14 * * 1-5',
          nextRunAt: now + 5 * 3600_000,
          terminalId: 'term_a',
          sentAt: now - 20 * 60_000,
          blocked: '입력 칸이 보이지 않은 채 멈춤(시작 화면·선택 창) — 그 터미널을 확인해 주세요'
        },
        {
          ...base,
          id: 's3',
          name: '회의록 요약',
          workspaceId: 'w2',
          workspace: 'notes',
          agent: 'gemini',
          cron: '0 18 * * *',
          nextRunAt: now + 8 * 3600_000,
          terminalId: 'term_b',
          sentAt: now - 300_000,
          lastStatus: '보냄'
        }
      ]
    }
  }
})
