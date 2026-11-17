// Same cases as the OrcaCron app's checks (Sources/SchedulerCheck) so the two read each other's cron.
import { assert, test } from 'orca/testing'
import { cronOfSpec, daysOf, describe, minuteFromText, specOfCron, type TimeSpec, zoneText } from './timespec'

const times = (list: number[]) => ({ kind: 'times' as const, list })
const every = (n: number, from: number, to: number) => ({ kind: 'every' as const, n, from, to })

test('days of a weekday set', () => {
  assert.deepEqual(daysOf([0, 1, 2, 3, 4, 5, 6]), { kind: 'everyDay' })
  assert.deepEqual(daysOf([5, 4, 3, 2, 1]), { kind: 'weekdays' })
  assert.deepEqual(daysOf([6, 0]), { kind: 'weekends' })
  assert.deepEqual(daysOf([3, 1]), { kind: 'some', set: [1, 3] })
})

test('set times → cron, same minute shares one expression', () => {
  assert.equal(cronOfSpec({ days: { kind: 'weekdays' }, pattern: times([540, 1080]) }), '0 9,18 * * 1-5')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: times([1080, 570]) }), '30 9 * * *; 0 18 * * *')
  assert.equal(cronOfSpec({ days: { kind: 'weekends' }, pattern: times([600]) }), '0 10 * * 0,6')
  assert.equal(cronOfSpec({ days: { kind: 'some', set: [3, 1] }, pattern: times([540]) }), '0 9 * * 1,3')
  assert.equal(cronOfSpec({ days: { kind: 'some', set: [] }, pattern: times([540]) }), null, 'no day')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: times([]) }), null, 'no time')
})

test('repeat → cron with ranges and steps', () => {
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(5, 420, 480) }), '*/5 7 * * *; 0 8 * * *')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(60, 3, 1439) }), '3 * * * *')
  assert.equal(cronOfSpec({ days: { kind: 'weekdays' }, pattern: every(30, 540, 1080) }), '*/30 9-17 * * 1-5; 0 18 * * 1-5')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(5, 0, 1439) }), '*/5 * * * *')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(30, 600, 500) }), null, 'backwards range')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(0, 0, 1439) }), null, 'zero interval')
  assert.equal(cronOfSpec({ days: { kind: 'everyDay' }, pattern: every(721, 0, 1439) }), null, 'over 720 minutes')
})

test('picked dates → year field, one expression per month', () => {
  const spec: TimeSpec = { days: { kind: 'dates', dates: ['2026-12-01', '2026-11-25', '2026-11-20'] }, pattern: times([540]) }
  assert.equal(cronOfSpec(spec), '0 9 20,25 11 * 2026; 0 9 1 12 * 2026')
  assert.equal(cronOfSpec({ days: { kind: 'dates', dates: [] }, pattern: times([540]) }), null)
})

test('cron → the form, round trip', () => {
  const specs: TimeSpec[] = [
    { days: { kind: 'weekdays' }, pattern: times([540, 1080]) },
    { days: { kind: 'everyDay' }, pattern: times([570, 1080]) },
    { days: { kind: 'some', set: [1, 3, 5] }, pattern: times([480]) },
    { days: { kind: 'weekends' }, pattern: every(30, 540, 1080) },
    { days: { kind: 'everyDay' }, pattern: every(5, 0, 1439) },
    { days: { kind: 'dates', dates: ['2026-11-20', '2026-11-25', '2026-12-01'] }, pattern: times([540, 1080]) }
  ]
  for (const spec of specs) assert.deepEqual(specOfCron(cronOfSpec(spec) as string), spec, JSON.stringify(spec))
  assert.equal(specOfCron('0 9 13 * 1'), null, 'day of month + weekday is not a form shape')
  assert.equal(specOfCron('nonsense'), null)
})

test('summary in English and Korean', () => {
  const both = (cron: string) => [describe(cron, 'en'), describe(cron, 'ko')]
  assert.deepEqual(both('0 9,18 * * 1-5'), ['Weekdays 09:00 · 18:00', '평일 09:00 · 18:00'])
  assert.deepEqual(both('0 9 * * 1,3'), ['Every Mon·Wed 09:00', '매주 월·수 09:00'])
  assert.deepEqual(both('0 9 * * 0,6'), ['Weekends 09:00', '주말 09:00'])
  assert.deepEqual(both('3 0,6,12,18 * * *'), ['Every day at :03 past 00·06·12·18', '매일 00·06·12·18시 03분'])
  assert.deepEqual(both('*/5 * * * *'), ['Every 5 min', '5분마다'])
  assert.deepEqual(both('3 * * * *'), ['Hourly at :03', '매시 03분'])
  assert.deepEqual(both('*/30 9-17 * * 1-5; 0 18 * * 1-5'), ['Weekdays 09:00–18:00, every 30 min', '평일 09:00~18:00 30분마다'])
  assert.deepEqual(both('0 9 20,25 11 * 2026'), ['11/20, 11/25 09:00', '11/20, 11/25 09:00'])
  assert.deepEqual(both('0 9 1,2,3,4 12 * 2026'), ['12/1 +3 more 09:00', '12/1 등 4일 09:00'])
  assert.deepEqual(both('0 9 13 * 1'), ['0 9 13 * 1', '0 9 13 * 1'], 'other cron shows as written')
})

test('typed times', () => {
  const cases: [string, number | null][] = [
    ['09:00', 540],
    ['9:5', 545],
    ['930', 570],
    ['0930', 570],
    ['9', 540],
    ['9시 30분', 570],
    ['9시', 540],
    ['7.05', 425],
    ['25:00', null],
    ['9:60', null],
    ['12345', null],
    ['', null],
    ['a', null],
    // A 12-hour time said with its half.
    ['9pm', 1260],
    ['9:30 PM', 1290],
    ['9.30 p.m.', 1290],
    ['12am', 0],
    ['12:15 am', 15],
    ['12pm', 720],
    ['오후 9시 30분', 1290],
    ['오전 12시', 0],
    ['13pm', null],
    ['0am', null],
    ['9 am pm', null]
  ]
  for (const [text, minute] of cases) assert.equal(minuteFromText(text), minute, text)
})

test("the clock the times are read on — this computer's zone and its offset from UTC", () => {
  assert.match(zoneText(), /^(?:[A-Za-z_+\-/0-9]+, )?UTC[+−]\d{1,2}(?::\d{2})?$/)
  const offset = -new Date().getTimezoneOffset()
  assert.ok(zoneText().endsWith(`UTC${offset < 0 ? '−' : '+'}${Math.floor(Math.abs(offset) / 60)}${offset % 60 ? `:${String(Math.abs(offset) % 60).padStart(2, '0')}` : ''}`))
})
