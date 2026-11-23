import { assert, test } from 'orca/testing'
import { cronOfDraft, type Draft, draftOfCron, emptyDraft } from './draft'

const drafts: [string, Partial<Draft>][] = [
  ['default weekdays at 09:00', {}],
  ['every day at two times', { day: 'everyDay', times: ['08:00', '12:30'] }],
  ['picked days, four times in one minute', { day: 'pick', picked: [1, 3, 5], times: ['07:15', '09:15', '12:15', '18:15'] }],
  ['weekends every 30 minutes all day', { day: 'weekends', repeat: true, allDay: true, every: '30' }],
  ['every 15 minutes between two clocks', { day: 'weekdays', repeat: true, every: '15', from: '09:00', to: '18:00' }],
  ['picked dates', { day: 'dates', dates: ['2099-03-01', '2099-03-14'], times: ['10:00'] }],
  ['cron as written', { day: 'cron', cron: '0 9 * * 1-5' }]
]

test('초안 → cron → 초안 → cron 은 같은 식을 낸다', () => {
  for (const [name, patch] of drafts) {
    const first = cronOfDraft({ ...emptyDraft(), ...patch }, 'en')
    assert.ok('cron' in first, `${name}: a draft that cannot be saved is not round-tripped`)
    const again = cronOfDraft({ ...emptyDraft(), ...draftOfCron(first.cron) }, 'en')
    assert.deepEqual(again, first, name)
  }
})
