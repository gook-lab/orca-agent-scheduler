import { assert, test } from 'orca/testing'
import { nextRun, parseCron } from './cron'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)
const next = (expr: string, after: Date) => nextRun(parseCron(expr)!, after)

test('평일 09:00 — 금요일 다음은 월요일', () => {
  // 2026-11-13 은 금요일
  assert.deepEqual(next('0 9 * * 1-5', at(2026, 11, 13, 9, 0)), at(2026, 11, 16, 9, 0))
  assert.deepEqual(next('0 9 * * 1-5', at(2026, 11, 13, 8, 59)), at(2026, 11, 13, 9, 0))
})

test('같은 분은 제외하고 다음 시각', () => {
  assert.deepEqual(next('*/15 * * * *', at(2026, 11, 13, 10, 15)), at(2026, 11, 13, 10, 30))
})

test('식 여러 개는 가장 먼저 오는 시각', () => {
  assert.deepEqual(next('30 9 * * *; 0 18 * * *', at(2026, 11, 13, 10, 0)), at(2026, 11, 13, 18, 0))
})

test('일·요일 둘 다 정하면 둘 중 하나만 맞아도 된다', () => {
  // 13일 또는 월요일 — 11/14(토) 뒤로는 11/16(월)
  assert.deepEqual(next('0 9 13 * 1', at(2026, 11, 13, 10, 0)), at(2026, 11, 16, 9, 0))
})

test('연도 칸 — 지난 해만 있으면 돌지 않음', () => {
  assert.equal(next('0 9 20 11 * 2025', at(2026, 11, 13)), null)
  assert.deepEqual(next('0 9 20 11 * 2026', at(2026, 11, 13)), at(2026, 11, 20, 9, 0))
})

test('틀린 식', () => {
  for (const bad of ['', '0 9 * *', '60 9 * * *', '0 24 * * *', '0 9 * * 8', '0 9 5-1 * *', 'a b c d e', '*/0 * * * *']) {
    assert.equal(parseCron(bad), null, bad)
  }
})

test('2월 31일은 앞으로 돌지 않음', () => {
  assert.equal(next('0 9 31 2 *', at(2026, 11, 13)), null)
})
