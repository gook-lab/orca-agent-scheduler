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

test('13개월 넘게 남은 날짜 — 연도 칸의 마지막 해까지 찾는다', () => {
  assert.deepEqual(next('0 9 25 12 * 2027', at(2026, 6, 1, 10, 0)), at(2027, 12, 25, 9, 0))
  assert.deepEqual(next('0 9 1 1 * 2099', at(2026, 11, 13)), at(2099, 1, 1, 9, 0))
  assert.equal(next('0 9 31 2 * 2030-2099', at(2026, 11, 13)), null)
})

test('2월 29일 — 다음 윤년까지 찾는다', () => {
  assert.deepEqual(next('0 9 29 2 *', at(2025, 3, 2, 10, 0)), at(2028, 2, 29, 9, 0))
  // 2100년은 윤년이 아니다 — 2096년 다음은 2104년
  assert.deepEqual(next('0 9 29 2 *', at(2096, 3, 1)), at(2104, 2, 29, 9, 0))
})
