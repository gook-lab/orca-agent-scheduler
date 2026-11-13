// `orca plugin check` draws the panel once per situation (the worker runs on the same fake host).
import { defineCheck } from 'orca/testing'

const now = Date.now()
const terminal = (handle: string, title: string, agent: string, workspace: string) => ({
  handle,
  title,
  agent,
  workspaceId: workspace,
  workspace,
  tabId: `tab-${handle}`,
  leafId: `leaf-${handle}`
})
const base = {
  prompt: 'Plan the day',
  enabled: true,
  clearFirst: false,
  once: false,
  pendingSince: null,
  waitNote: null,
  clearedFor: null,
  sentAt: null,
  sawWorking: false,
  blocked: null,
  lastStatus: null,
  history: []
}
const results = {
  'workspace.list': {
    workspaces: [
      { id: 'sonix_docs', kind: 'worktree', name: 'sonix_docs', path: '/repo/docs', branch: 'main', hostId: null },
      { id: 'notes', kind: 'folder', name: 'notes', path: '/notes', branch: null, hostId: null }
    ],
    truncated: false
  },
  'terminal.read': { lines: ['──────────────────────────────', '❯ working', '──────────────────────────────'], truncated: false },
  'statusBar.update': { ok: true }
}

const schedules = [
  {
    ...base,
    id: 's1',
    name: 'Morning report',
    terminal: terminal('h1', 'Morning', 'claude', 'sonix_docs'),
    cron: '0 9 * * 1-5',
    nextRunAt: now + 3 * 3600_000,
    lastStatus: 'done',
    history: [{ at: now - 86400_000, status: 'done', tookMs: 4 * 60_000 }]
  },
  {
    ...base,
    id: 's2',
    name: 'PR review',
    terminal: terminal('h2', 'Review', 'codex', 'sonix_docs'),
    cron: '*/30 9-17 * * 1-5; 0 18 * * 1-5',
    nextRunAt: now + 20 * 60_000,
    sentAt: now - 20 * 60_000,
    lastStatus: 'sent',
    blocked: { code: 'stuckNoPrompt' }
  },
  {
    ...base,
    id: 's3',
    name: 'Release notes',
    terminal: terminal('h3', 'Notes', 'gemini', 'notes'),
    cron: '0 18 20,25 12 * 2026',
    clearFirst: true,
    nextRunAt: now + 8 * 3600_000,
    pendingSince: now - 60_000,
    waitNote: { code: 'missing' }
  },
  {
    ...base,
    id: 'o1',
    once: true,
    name: 'Summarise the open PRs',
    terminal: terminal('h1', 'Morning', 'claude', 'sonix_docs'),
    cron: '',
    nextRunAt: null,
    lastStatus: 'done',
    history: [{ at: now - 2 * 3600_000, status: 'done', tookMs: 2 * 60_000 }]
  }
]

export default defineCheck({
  empty: { results },
  busy: { results, storage: { schedules } },
  korean: { results, storage: { schedules, langPref: 'ko' } }
})
