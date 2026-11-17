import { assert, test } from 'orca/testing'
import { words } from './i18n'
import { readReport, reportToken, SUMMARY_MAX } from './report'

const rule = '──────────────────────────────'
const box = [rule, '❯ ', rule]

test('the result line at the end of a reply is read — status, summary, link', () => {
  const r = readReport(['⏺ Done. Three were stale.', '', '  [result k3f9 ok] 3 PRs need review [link] https://github.com/acme/notes/pull/128 [end]', ...box], 'k3f9')
  assert.deepEqual(r, { status: 'success', summary: '3 PRs need review', link: 'https://github.com/acme/notes/pull/128' })
})

test('failed and skipped are read as said; a result without a link has none', () => {
  assert.deepEqual(readReport(['⏺ [result k3f9 failed] The build broke [end]'], 'k3f9'), { status: 'failed', summary: 'The build broke' })
  assert.deepEqual(readReport(['• [result k3f9 skipped] Nothing new since yesterday [end]'], 'k3f9'), { status: 'skipped', summary: 'Nothing new since yesterday' })
})

test('a line wrapped to the terminal width is put back — the summary with spaces, the link without', () => {
  const r = readReport(
    [
      '⏺ [result k3f9 ok] 원장 갱신 — 새 변경 3건을 넣고 칩 숫자를 다시',
      '  계산함 [link] https://example.com/artifact/5EEawQ0mB1x9',
      '  Zp7Lr2/edit?tab=ledger [end]',
      ...box
    ],
    'k3f9'
  )
  assert.equal(r?.summary, '원장 갱신 — 새 변경 3건을 넣고 칩 숫자를 다시 계산함')
  assert.equal(r?.link, 'https://example.com/artifact/5EEawQ0mB1x9Zp7Lr2/edit?tab=ledger')
})

test('the ask echoed on screen is not a result — STATUS is not a status', () => {
  const ask = words('en').reportAsk('k3f9')
  assert.ok(ask.includes('[result k3f9 STATUS]'), 'the ask shows the form')
  assert.equal(readReport([`❯ Plan the day ${ask}`, '⏺ Planned.', ...box], 'k3f9'), null)
  assert.equal(readReport([`❯ 하루 계획 ${words('ko').reportAsk('k3f9')}`, ...box], 'k3f9'), null)
})

test("an earlier run's line still on screen is not taken for this run", () => {
  const old = '⏺ [result a111 ok] Yesterday went fine [link] https://example.com/y [end]'
  assert.equal(readReport([old, '❯ Plan the day', '⏺ Planned, nothing to report.', ...box], 'k3f9'), null)
  const mine = readReport([old, '❯ Plan the day', '⏺ [result k3f9 skipped] Nothing to plan [end]', ...box], 'k3f9')
  assert.deepEqual(mine, { status: 'skipped', summary: 'Nothing to plan' })
})

test('with two lines for this run, the newest counts', () => {
  const r = readReport(['⏺ [result k3f9 failed] First try broke [end]', '⏺ Fixed it.', '  [result k3f9 ok] Second try went through [end]'], 'k3f9')
  assert.deepEqual(r, { status: 'success', summary: 'Second try went through' })
})

test('a line cut off before its end is passed by — it does not take in the line after it', () => {
  const cut = '⏺ [result k3f9 failed] First try broke'
  assert.deepEqual(readReport([cut, '⏺ Fixed it.', '  [result k3f9 ok] Second try went through [end]', ...box], 'k3f9'), { status: 'success', summary: 'Second try went through' })
  assert.deepEqual(readReport(['⏺ [result k3f9 ok] Went through [end]', '⏺ One more thing.', '  [result k3f9 failed] and then', ...box], 'k3f9'), { status: 'success', summary: 'Went through' })
  const far = `⏺ [result k3f9 ok] ${'x'.repeat(5000)} [end]`
  assert.equal(readReport([far], 'k3f9'), null, 'an end that far away is not this line\'s')
})

test('only web links are kept; the summary stays', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a link', 'https://exa mple.com/"x']) {
    const r = readReport([`⏺ [result k3f9 ok] Done [link] ${bad} [end]`], 'k3f9')
    assert.equal(r?.summary, 'Done')
    assert.equal(r?.link, undefined, bad)
  }
})

test('a link with a name before the site is dropped — it would read as one site and lead to another', () => {
  for (const bad of ['https://github.com:acme-notes.pull.128@evil.example/x', 'https://user@example.com/', 'http://a:b@example.com']) {
    assert.equal(readReport([`⏺ [result k3f9 ok] Done [link] ${bad} [end]`], 'k3f9')?.link, undefined, bad)
  }
  for (const good of ['https://example.com/u/@me', 'https://example.com:8443/a?b=c@d#e', 'https://example.com']) {
    assert.equal(readReport([`⏺ [result k3f9 ok] Done [link] ${good} [end]`], 'k3f9')?.link, good, good)
  }
})

test('a very long summary is cut', () => {
  const r = readReport([`⏺ [result k3f9 ok] ${'word '.repeat(200)}[end]`], 'k3f9')
  assert.equal(r?.summary.length, SUMMARY_MAX)
})

test('no line, a line without its end, or another status — nothing is read', () => {
  assert.equal(readReport(['⏺ Planned.', ...box], 'k3f9'), null)
  assert.equal(readReport(['⏺ [result k3f9 ok] Planned', ...box], 'k3f9'), null)
  assert.equal(readReport(['⏺ [result k3f9 great] Planned [end]'], 'k3f9'), null)
  assert.equal(readReport(['⏺ [result k3f9 ok] Planned [end]'], '.*'), null, 'a tag that is not four letters or digits reads nothing')
})

test('the tag is four letters or digits, and differs between runs sent at different times', () => {
  const nine = new Date(2026, 10, 13, 9, 0).getTime()
  assert.match(reportToken(nine), /^[0-9a-z]{4}$/)
  assert.match(reportToken(0), /^[0-9a-z]{4}$/)
  assert.notEqual(reportToken(nine), reportToken(nine + 86_400_000))
  assert.notEqual(reportToken(nine), reportToken(nine + 30 * 60_000))
})

test('a link drawn with the mark Claude Code puts before it, on a narrow pane', () => {
  const lines = [
    '⏺ The board is as it was: ⧉',
    '  https://example.com/board/a1B2c3D4e5F6g7H8',
    '  [result k3f9 skipped] Nothing changed (12 items) [link] ⧉',
    '  https://example.com/board/a1B2c3D4e5F6g7H8 [end]',
    '✻ Cogitated for 6s · done 9:04 AM'
  ]
  assert.deepEqual(readReport(lines, 'k3f9'), {
    status: 'skipped',
    summary: 'Nothing changed (12 items)',
    link: 'https://example.com/board/a1B2c3D4e5F6g7H8'
  })
  assert.deepEqual(readReport(['[result k3f9 ok] Done [link] ⧉ see the board [end]'], 'k3f9'), { status: 'success', summary: 'Done' }, 'no address after the mark — no link')
})
