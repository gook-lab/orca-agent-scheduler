import { assert, test } from 'orca/testing'
import { blankSchedule, type LiveTerminal, type Schedule } from './engine'
import { type Entry, entriesFrom, inboxId, type Item, type Places, type Seen, seenFrom, sync, terminalFor, unbound } from './inbox'

const now = new Date(2026, 10, 27, 8, 0).getTime()

/** What a writer puts in a file. */
const written = {
  id: 'orca-bot:auto_7f3a',
  source: 'Orca bot',
  name: 'Morning PR review',
  cron: '0 9 * * 1-5',
  prompt: 'Review the pull requests waiting for me.',
  target: { workspace: '/Users/me/code/app', agent: 'claude' }
}
/** The same, as it is read. */
const item: Item = { ...written, target: { ...written.target, title: '' }, newConversation: false, askResult: true, enabled: true }

const live = (handle: string, agent: string | null, workspaceId: string, title = handle): LiveTerminal => ({
  handle,
  title,
  agent,
  workspaceId,
  tabId: `tab-${handle}`,
  leafId: `leaf-${handle}`,
  lastOutputAt: null
})
const places = (terminals: LiveTerminal[] | null): Places => ({
  workspaces: [
    { id: 'repo::/Users/me/code/app', name: 'app', path: '/Users/me/code/app' },
    { id: 'repo::/Users/me/code/app/wt/fix', name: 'fix', path: '/Users/me/code/app/wt/fix' },
    { id: 'folder-1', name: 'notes', path: '/Users/me/notes/' }
  ],
  terminals,
  home: '/Users/me'
})
const one = places([live('h1', 'claude', 'repo::/Users/me/code/app', 'review'), live('h2', 'codex', 'repo::/Users/me/code/app'), live('h3', null, 'repo::/Users/me/code/app')])
const file = (name: string, value: unknown): { file: string; text: string | null } => ({ file: name, text: JSON.stringify(value) })
const run = (list: Schedule[], seen: Seen, entries: Entry[], at: Places = one) => sync(list, seen, entries, async () => at, now)
const entries = (...values: unknown[]): Entry[] => entriesFrom(values.map((v, i) => file(`${i}.json`, v)), now)

test('an inbox file is read field by field — result line and on by default, a new conversation only when asked', () => {
  assert.deepEqual(entriesFrom([file('a.json', written)], now), [{ file: 'a.json', item }])
  const [e] = entries({ ...written, name: '  Tidy  ', newConversation: true, askResult: false, enabled: false, target: { workspace: '~/code/app/', agent: 'Codex', title: ' review ' }, precheck: 'rm -rf ~' })
  assert.deepEqual('item' in e && e.item, {
    ...item,
    name: 'Tidy',
    newConversation: true,
    askResult: false,
    enabled: false,
    target: { workspace: '~/code/app', agent: 'codex', title: 'review' }
  })
  assert.ok('item' in e && !('precheck' in e.item), 'a command is not taken from a file — it is typed in the panel')
})

test('a file that cannot be used says which part is wrong, and does not stop the others', () => {
  const bad: [unknown, string][] = [
    [{ ...written, id: '' }, 'id'],
    [{ ...written, id: 'x'.repeat(201) }, 'id'],
    [[written], 'id'],
    [{ ...written, name: ' ' }, 'name'],
    [{ ...written, cron: 'whenever' }, 'cron'],
    [{ ...written, cron: '0 9 1 1 * 2020' }, 'never'],
    [{ ...written, prompt: '' }, 'prompt'],
    [{ ...written, target: { agent: 'claude' } }, 'workspace'],
    [{ ...written, target: { workspace: '/x', agent: 'aider' } }, 'agent'],
    [{ ...written, target: 'claude' }, 'workspace']
  ]
  for (const [value, code] of bad) assert.deepEqual(entriesFrom([file('a.json', value)], now), [{ file: 'a.json', problem: code }])
  assert.deepEqual(
    entriesFrom([{ file: 'b.json', text: '{ half a fi' }, { file: 'c.json', text: null }, file('a.json', written), file('d.json', { ...written, name: 'Twice' }), file('e.json', { id: 'gone', deleted: true })], now),
    [{ file: 'a.json', item }, { file: 'b.json', problem: 'json' }, { file: 'c.json', problem: 'unreadable' }, { file: 'd.json', problem: 'duplicate' }, { file: 'e.json', remove: 'gone' }],
    'in file-name order; the first file with an id counts'
  )
})

test('a target is the one terminal in that workspace running that agent', () => {
  const t = terminalFor(item.target, one)
  assert.deepEqual(t, { handle: 'h1', title: 'review', agent: 'claude', workspaceId: 'repo::/Users/me/code/app', workspace: 'app', tabId: 'tab-h1', leafId: 'leaf-h1' })
  assert.equal(terminalFor({ ...item.target, agent: 'codex' }, one).handle, 'h2')
  assert.equal(terminalFor({ ...item.target, workspace: '~/code/app' }, one).handle, 'h1', '~ is the home folder')
  assert.equal(terminalFor({ ...item.target, workspace: 'repo::/Users/me/code/app' }, one).handle, 'h1', 'or the workspace by its Orca id')
  assert.equal(terminalFor({ ...item.target, workspace: '/Users/me/code/app/packages/web' }, one).handle, 'h1', 'a folder inside the workspace')
})

test('no terminal, or more than one, and nothing is picked — the reference says where it would go', () => {
  const none = terminalFor({ ...item.target, agent: 'gemini' }, one)
  assert.ok(unbound(none))
  assert.deepEqual([none.agent, none.workspace, none.workspaceId], ['gemini', 'app', 'repo::/Users/me/code/app'])
  const two = places([live('h1', 'claude', 'repo::/Users/me/code/app', 'review'), live('h4', 'claude', 'repo::/Users/me/code/app', 'build')])
  assert.ok(unbound(terminalFor(item.target, two)), 'between two it does not guess')
  assert.equal(terminalFor({ ...item.target, title: 'Build' }, two).handle, 'h4', 'a title narrows it')
  assert.ok(unbound(terminalFor({ ...item.target, title: 'deploy' }, two)), 'a title no terminal has matches none')
  assert.ok(unbound(terminalFor(item.target, places(null))), 'the terminal list could not be read')
  const deep = places([live('h5', 'claude', 'repo::/Users/me/code/app/wt/fix'), live('h1', 'claude', 'repo::/Users/me/code/app')])
  assert.equal(terminalFor({ ...item.target, workspace: '/Users/me/code/app/wt/fix/src' }, deep).handle, 'h5', 'the deepest workspace that holds the folder')
  assert.equal(terminalFor({ ...item.target, workspace: '/Users/me/notes' }, places([live('h6', 'claude', 'folder-1')])).handle, 'h6', 'a trailing slash does not matter')
  const stray = terminalFor({ ...item.target, workspace: '/Users/me/elsewhere/proj' }, one)
  assert.deepEqual([unbound(stray), stray.workspace, stray.workspaceId], [true, 'proj', ''], 'a folder no workspace holds is named by its last part')
})

test('a new item adds a schedule on its terminal, marked with where it came from', async () => {
  const r = await run([], {}, entries(written))
  assert.equal(r.list.length, 1)
  const [s] = r.list
  assert.deepEqual(
    { ...s, nextRunAt: null },
    { ...blankSchedule(inboxId(written.id)), name: written.name, cron: written.cron, prompt: written.prompt, report: true, terminal: terminalFor(item.target, one), source: { id: written.id, by: 'Orca bot' } }
  )
  assert.equal(s.nextRunAt, new Date(2026, 10, 27, 9, 0).getTime())
  assert.deepEqual(r.added, [s])
  assert.deepEqual(r.seen, { [written.id]: { item } })
  assert.match(r.log[0], /Morning PR review: added by Orca bot \(0\.json\) → review/)
})

test('the same file again changes nothing — what a person edited or deleted in the panel stands', async () => {
  const first = await run([], {}, entries(written))
  const [s] = first.list
  s.name = 'Renamed here'
  s.enabled = false
  const again = await run(first.list, first.seen, entries(written))
  assert.equal(again.list, first.list)
  assert.deepEqual([again.list[0].name, again.list[0].enabled, again.log, again.added], ['Renamed here', false, [], []])
  // Deleted in the panel: the file is still there, and still says what it said.
  const deleted = await run([], first.seen, entries(written))
  assert.deepEqual([deleted.list, deleted.added], [[], []])
  assert.deepEqual(deleted.seen, first.seen, 'remembered while the file is there')
})

test('a changed file replaces only the fields it changed — the others keep a person\'s edit', async () => {
  const first = await run([], {}, entries(written))
  const [s] = first.list
  s.name = 'Renamed here'
  s.prompt = 'Edited here'
  s.report = false
  s.history = [{ at: now - 1000, status: 'success' }]
  const r = await run(first.list, first.seen, entries({ ...written, cron: '30 10 * * *', prompt: 'Review, then summarise.', source: 'Orca bot v2' }))
  assert.deepEqual(
    [s.name, s.prompt, s.cron, s.report, s.nextRunAt, s.source, s.history.length],
    ['Renamed here', 'Review, then summarise.', '30 10 * * *', false, new Date(2026, 10, 27, 10, 30).getTime(), { id: written.id, by: 'Orca bot v2' }, 1]
  )
  assert.deepEqual([r.added, r.list.length], [[], 1])
  assert.match(r.log[0], /updated by Orca bot v2/)
})

test('a file that changed brings back a schedule a person deleted', async () => {
  const first = await run([], {}, entries(written))
  const r = await run([], first.seen, entries({ ...written, prompt: 'A new ask' }))
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].prompt, 'A new ask')
  assert.equal(r.added.length, 1)
})

test('switching it off in the file drops a waiting run; back on fills the next time', async () => {
  const first = await run([], {}, entries(written))
  const [s] = first.list
  s.pendingSince = now - 60_000
  s.waitNote = { code: 'busy' }
  const off = await run(first.list, first.seen, entries({ ...written, enabled: false }))
  assert.deepEqual([s.enabled, s.nextRunAt, s.pendingSince, s.waitNote], [false, null, null, null])
  await run(off.list, off.seen, entries(written))
  assert.deepEqual([s.enabled, s.nextRunAt], [true, new Date(2026, 10, 27, 9, 0).getTime()])
})

test('deleted removes the schedule, once', async () => {
  const first = await run([{ ...blankSchedule('mine'), name: 'Made in the panel' }], {}, entries(written))
  const gone = await run(first.list, first.seen, entries({ id: written.id, deleted: true }))
  assert.deepEqual(gone.list.map((s) => s.id), ['mine'])
  assert.deepEqual(gone.seen, { [written.id]: { deleted: true } })
  assert.match(gone.log[0], /Morning PR review: removed by Orca bot/)
  // Put back with Undo: the same mark does not remove it a second time.
  const again = await run(first.list, gone.seen, entries({ id: written.id, deleted: true }))
  assert.equal(again.list.length, 2)
  assert.deepEqual(again.log, [])
  // Written anew after the mark, it is a new schedule.
  const back = await run(gone.list, gone.seen, entries(written))
  assert.deepEqual(back.list.map((s) => s.id), ['mine', inboxId(written.id)])
})

test('without a matching terminal it comes in with none, and takes one when exactly one is open', async () => {
  const nothingOpen = places([live('h2', 'codex', 'repo::/Users/me/code/app')])
  const first = await run([], {}, entries(written), nothingOpen)
  const [s] = first.list
  assert.ok(unbound(s.terminal))
  assert.deepEqual([s.terminal.agent, s.terminal.workspace, s.enabled], ['claude', 'app', true])
  assert.match(first.log[0], /no terminal yet/)
  const still = await run(first.list, first.seen, entries(written), nothingOpen)
  assert.ok(unbound(still.list[0].terminal))
  assert.deepEqual(still.log, [])
  const found = await run(first.list, first.seen, entries(written))
  assert.equal(found.list[0].terminal.handle, 'h1')
  assert.match(found.log[0], /found its terminal → review/)
  // Bound, it stays where it is: a second terminal later does not unsettle it, nor is it looked up again.
  let asked = 0
  await sync(found.list, found.seen, entries(written), async () => (asked++, one), now)
  assert.equal(asked, 0, 'the terminal list is read only when a target has to be matched')
  // The file can be gone by then — what was last applied is remembered while its schedule is here.
  const waiting: Schedule = { ...first.list[0], terminal: terminalFor(item.target, nothingOpen) }
  const later = await run([waiting], first.seen, [], nothingOpen)
  assert.ok(unbound(later.list[0].terminal))
  assert.deepEqual(later.seen, first.seen)
  assert.equal((await run([waiting], later.seen, [])).list[0].terminal.handle, 'h1')
})

test('a terminal a person picked is kept — only a schedule with none is matched', async () => {
  const first = await run([], {}, entries(written), places([]))
  const [s] = first.list
  s.terminal = { handle: 'h9', title: 'mine', agent: 'claude', workspaceId: 'w9', workspace: 'other', tabId: 't9', leafId: 'l9' }
  await run(first.list, first.seen, entries(written))
  assert.equal(s.terminal.handle, 'h9')
})

test('a new target moves the schedule — once its run has ended', async () => {
  const first = await run([], {}, entries(written))
  const [s] = first.list
  s.sentAt = now - 60_000
  s.clearedFor = 1
  const moved = { ...written, name: 'Moved', target: { ...written.target, agent: 'codex' } }
  const held = await run(first.list, first.seen, entries(moved))
  assert.deepEqual([s.terminal.handle, s.name], ['h1', 'Morning PR review'], 'the whole file waits — its end is read off the terminal it was sent to')
  assert.deepEqual(held.seen, first.seen)
  s.sentAt = null
  const done = await run(held.list, held.seen, entries(moved))
  assert.deepEqual([s.terminal.handle, s.name, s.clearedFor], ['h2', 'Moved', null])
  assert.deepEqual(done.seen[written.id], { item: { ...item, name: 'Moved', target: { ...item.target, agent: 'codex' } } })
})

test('an id is forgotten when its file and its schedule are both gone — not while a file could not be read', async () => {
  const first = await run([], {}, entries(written, { id: 'old', deleted: true }))
  assert.deepEqual(Object.keys(first.seen), [written.id, 'old'])
  const kept = await run(first.list, first.seen, [])
  assert.deepEqual(Object.keys(kept.seen), [written.id], 'the schedule is still here; the delete mark went with its file')
  const half = await run([], first.seen, [{ file: '0.json', problem: 'json' }])
  assert.deepEqual(half.seen, first.seen, 'a file caught half-written may be the one')
  const clean = await run([], first.seen, [])
  assert.deepEqual(clean.seen, {})
})

test('what storage holds about the inbox is read loosely', () => {
  const stored = { a: { item }, b: { deleted: true }, c: { item: { ...item, cron: 'whenever' } }, d: 'text', e: { item: { ...item, cron: '0 9 1 1 * 2020' } } }
  assert.deepEqual(Object.keys(seenFrom(stored)), ['a', 'b', 'e'], 'times that have passed since are still what was applied')
  assert.deepEqual(seenFrom(null), {})
  assert.deepEqual(seenFrom([1, 2]), {})
})
