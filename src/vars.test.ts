import { assert, test } from 'orca/testing'
import { fillPrompt, flatten, usedVars, VAR_MAX } from './vars'

const now = new Date(2026, 10, 25, 7, 5).getTime()

test('names this version does not know, and text that only looks like one, stay as typed', () => {
  assert.equal(fillPrompt('{{nope}} {{ date }} {date} {{Date}}', { now, history: [] }), '{{nope}} 2026-11-25 {date} {{Date}}')
})

test('an empty value takes the text after |, or stays empty', () => {
  const c = { now, history: [] }
  assert.equal(fillPrompt('[{{last_result| none yet }}] [{{last_link}}] [{{last_run|-}}]', c), '[none yet] [] [-]')
})

test('last_result and last_link come from one run — the newest with a result line', () => {
  const history = [
    { at: now - 1000, status: 'success' as const, tookMs: 500 },
    { at: now - 9000, status: 'success' as const, tookMs: 500, summary: 'old', link: 'https://a.example/' },
    { at: now - 99000, status: 'success' as const, tookMs: 500, summary: 'older', link: 'https://b.example/' }
  ]
  assert.equal(fillPrompt('{{last_result}} {{last_link}}', { now, history }), 'old https://a.example/')
})

test('a long or multi-line value becomes one bounded line', () => {
  assert.equal(flatten(' a \n\n b\r\nc '), 'a; b; c')
  const long = fillPrompt('{{precheck}}', { now, history: [], precheck: 'x'.repeat(VAR_MAX + 50) })
  assert.equal(long.length, VAR_MAX)
  assert.ok(long.endsWith('…'))
})

test('usedVars lists the known names once', () => {
  assert.deepEqual(usedVars('{{precheck}} {{precheck|x}} {{nope}} {{date}}'), ['precheck', 'date'])
})
