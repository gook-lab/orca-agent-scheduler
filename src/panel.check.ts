// `orca plugin check` draws the panel once per situation (the worker runs on the same fake host).
import { defineCheck } from 'orca/testing'
import type { Schedule } from './engine'

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
  report: false,
  once: false,
  precheck: '',
  pendingSince: null,
  waitNote: null,
  clearedFor: null,
  sentAt: null,
  lateMs: null,
  sawWorking: false,
  blocked: null,
  lastStatus: null,
  history: []
}
const results = {
  'workspace.list': {
    workspaces: [
      { id: 'acme_notes', kind: 'worktree', name: 'acme_notes', path: '/repo/docs', branch: 'main', hostId: null },
      { id: 'notes', kind: 'folder', name: 'notes', path: '/notes', branch: null, hostId: null }
    ],
    truncated: false
  },
  'terminal.read': { lines: ['──────────────────────────────', '❯ working', '──────────────────────────────'], truncated: false },
  'statusBar.update': { ok: true }
}

const schedules: Schedule[] = [
  {
    ...base,
    id: 's1',
    name: 'Morning report',
    terminal: terminal('h1', 'Morning', 'claude', 'acme_notes'),
    cron: '0 9 * * 1-5',
    nextRunAt: now + 3 * 3600_000,
    lastStatus: 'done',
    history: [{ at: now - 86400_000, status: 'done', tookMs: 4 * 60_000 }]
  },
  {
    ...base,
    id: 's2',
    name: 'PR review',
    terminal: terminal('h2', 'Review', 'codex', 'acme_notes'),
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
    terminal: terminal('h1', 'Morning', 'claude', 'acme_notes'),
    cron: '',
    nextRunAt: null,
    lastStatus: 'done',
    history: [{ at: now - 2 * 3600_000, status: 'done', tookMs: 2 * 60_000 }]
  }
]

// The usual day: every terminal open, one run going, one waiting its turn. The worker here has no Orca
// CLI, so its answers are given instead; `busy` keeps the worker's own (the no-CLI warnings).
const open = schedules.map((s): Schedule =>
  s.id === 's2' ? { ...s, blocked: null } : s.id === 's3' ? { ...s, waitNote: { code: 'busy' } } : s
)
// The same day after the computer slept through 09:00: that run went out late, and says so.
const caughtUp = open.map((s): Schedule =>
  s.id === 's1' ? { ...s, history: [{ at: now - 30 * 60_000, status: 'done', tookMs: 4 * 60_000, lateMs: 192 * 60_000 }] } : s
)
// A run that was asked for a result: what the agent wrote sits under its record, with the link.
const withResult = open.map((s): Schedule =>
  s.id === 's1'
    ? {
        ...s,
        report: true,
        lastStatus: 'success',
        history: [
          { at: now - 30 * 60_000, status: 'success', tookMs: 4 * 60_000, summary: '3 PRs need review, 1 has a failing check', link: 'https://github.com/acme/notes/pull/128' }
        ]
      }
    : s
)
// What a person has to deal with: a dialog in the way of a due run, a send asked for a moment ago, and a
// schedule whose terminal was closed.
const stuck = schedules
  .filter((s) => !s.once)
  .map((s): Schedule =>
    s.id === 's1'
      ? { ...s, pendingSince: now - 5 * 60_000, waitNote: { code: 'dialog' } }
      : s.id === 's2'
        ? { ...s, sentAt: null, lastStatus: null, blocked: null, pendingSince: now }
        : { ...s, pendingSince: null, waitNote: null }
  )
// Two schedules a bot wrote into the inbox folder: one on the terminal its workspace and agent named, one
// for a workspace where that agent is not running yet.
const fromInbox: Schedule[] = [
  { ...open[0], history: [], lastStatus: null },
  { ...base, id: 'inbox-review', name: 'PR review', terminal: terminal('h1', 'Morning', 'claude', 'acme_notes'), cron: '0 10 * * 1-5', report: true, nextRunAt: now + 4 * 3600_000, source: { id: 'review', by: 'Orca bot' } },
  {
    ...base,
    id: 'inbox-notes',
    name: 'Release notes',
    terminal: { handle: '', title: '', agent: 'codex', workspaceId: 'notes', workspace: 'notes', tabId: '', leafId: '' },
    cron: '0 18 * * 5',
    nextRunAt: now + 8 * 3600_000,
    source: { id: 'notes', by: 'Orca bot' }
  }
]
const terminals = schedules.slice(0, 3).map((s) => s.terminal)
const answered = (list: Schedule[], openNow = terminals) => ({
  'schedules.list': () => list,
  'terminals.list': () => openNow,
  'runner.status': () => ({ lastTickAt: now, log: [], cli: true })
})

export default defineCheck({
  first: { results },
  empty: { results, storage: { onboarded: true } },
  open: { results, storage: { onboarded: true }, requests: answered(open) },
  late: { results, storage: { onboarded: true }, requests: answered(caughtUp) },
  result: { results, storage: { onboarded: true }, requests: answered(withResult) },
  stuck: { results, storage: { onboarded: true }, requests: answered(stuck, terminals.slice(0, 2)) },
  inbox: { results, storage: { onboarded: true }, requests: answered(fromInbox) },
  busy: { results, storage: { onboarded: true, schedules } },
  korean: { results, storage: { onboarded: true, langPref: 'ko' }, requests: answered(caughtUp) }
})
