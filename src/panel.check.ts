// `orca plugin check` 가 상황마다 패널을 한 번씩 그린다(worker 도 같은 가짜 host 위에서 돈다).
import { defineCheck } from 'orca/testing'

const now = Date.now()
const base = {
  terminalTitle: '리포트 정리',
  agent: 'claude',
  workspace: 'sonix_docs',
  prompt: '오늘 할 일 정리',
  clearFirst: false,
  enabled: true,
  pendingSince: null,
  waitNote: null,
  clearedFor: null,
  sentAt: null,
  sawWorking: false,
  blocked: null,
  lastStatus: null,
  history: []
}
const agents = {
  agents: [
    { terminalId: 't1', title: '리포트 정리', agent: 'claude', state: 'done', stateStartedAt: 0 },
    { terminalId: 't2', title: '교차 검토', agent: 'codex', state: 'working', stateStartedAt: 0 }
  ]
}
const results = {
  'agents.list': agents,
  'workspace.readContext': { branch: 'main', displayName: 'sonix_docs', terminals: [] },
  'terminal.read': { lines: ['──────────────────────────────', '❯ ', '──────────────────────────────'], truncated: false },
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
          terminalId: 't1',
          cron: '0 9 * * 1-5',
          nextRunAt: now + 3 * 3600_000,
          lastStatus: '성공',
          history: [{ at: now - 86400_000, status: '성공', summary: '걸린 시간 4분' }]
        },
        {
          ...base,
          id: 's2',
          name: 'PR 교차 검토',
          terminalId: 't2',
          terminalTitle: '교차 검토',
          agent: 'codex',
          cron: '30 14 * * 1-5',
          nextRunAt: now + 5 * 3600_000,
          pendingSince: now - 120_000,
          waitNote: '에이전트가 작업 중'
        },
        {
          ...base,
          id: 's3',
          name: '회의록 요약',
          terminalId: 't9',
          terminalTitle: '문서 요약',
          agent: 'gemini',
          workspace: 'notes',
          cron: '0 18 * * *',
          nextRunAt: now + 8 * 3600_000,
          sentAt: now - 300_000,
          lastStatus: '보냄'
        }
      ]
    }
  }
})
