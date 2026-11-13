// Panel, notification and history text in English (default) and Korean. Records keep codes, not
// sentences, so switching the language redraws past runs too.

export type Lang = 'en' | 'ko'

export const langOf = (value: unknown): Lang => (value === 'ko' ? 'ko' : 'en')

/** Each language in its own words — the same in every language. */
export const langNames: Record<Lang, string> = { en: 'English', ko: '한국어' }

/** Orca's UI language (BCP-47, `env.locale`) as a panel language: Korean for `ko…`, else English. */
export const langOfLocale = (locale: string): Lang => (/^ko\b/i.test(locale) ? 'ko' : 'en')

export const statuses = ['sent', 'success', 'done', 'doneWaiting', 'failed', 'aborted', 'noResult', 'skipped'] as const
export type Status = (typeof statuses)[number]

/** Why a run waits, stopped or ended — rendered with `noteText`. */
export type NoteCode =
  | 'busy'
  | 'dialog'
  | 'moving'
  | 'typing'
  | 'noPrompt'
  | 'unreadable'
  | 'missing'
  | 'noAgent'
  | 'cli'
  | 'cleared'
  | 'previous'
  | 'sameTerminal'
  | 'person'
  | 'stuckTyping'
  | 'stuckNoPrompt'
  | 'byScreen'
  | 'closed'
  | 'timeout'
  | 'sendFailed'
  | 'clearFailed'
  | 'waitedOut'
  | 'notStarted'

export type Note = { code: NoteCode; reason?: NoteCode; detail?: string }

const en = {
  status: {
    sent: 'Sent',
    success: 'Succeeded',
    done: 'Done',
    doneWaiting: 'Done (awaiting input)',
    failed: 'Failed',
    aborted: 'Stopped',
    noResult: 'No result',
    skipped: 'Skipped'
  } as Record<Status, string>,
  note: {
    busy: 'Agent is working',
    dialog: 'A permission or question dialog is open',
    moving: 'Screen changed in the last minute (working or typing)',
    typing: 'Unsent text in the input box',
    noPrompt: 'Input box not visible (a dialog may be open)',
    unreadable: 'Could not read the screen (will retry)',
    missing: 'Terminal is not open — waiting for it',
    noAgent: 'No agent is running in the terminal',
    cli: 'Orca CLI is not available',
    cleared: 'Sent /clear — sending once the screen settles',
    previous: 'Previous run still going — sends when it ends',
    sameTerminal: 'Another schedule just sent to this terminal — next check',
    person: 'Stopped at a permission or question dialog — check the terminal',
    stuckTyping: 'Stopped with text left in the input box — check the terminal',
    stuckNoPrompt: 'Stopped without a visible input box — check the terminal',
    byScreen: 'by screen',
    closed: 'Terminal closed — result unknown',
    timeout: 'Did not finish within 6 hours',
    sendFailed: 'Send failed',
    clearFailed: '/clear failed',
    waitedOut: 'Waited 60 min',
    notStarted: 'Turn start not confirmed'
  } as Record<NoteCode, string>,
  took: (min: string) => `took ${min}`,
  minutes: (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`),
  awaitingAnswer: 'Waiting for an answer — check the terminal',
  ui: {
    newSchedule: 'New schedule',
    editSchedule: 'Edit schedule',
    emptyTitle: 'No schedules yet',
    emptyDescription:
      'Press + at the top, or + on an agent terminal (Claude Code, Codex, Gemini CLI) in Terminals, and pick a time. At that time, once the terminal is idle, the prompt is sent to it.',
    footer:
      'Checks every 30 seconds while Orca is running. A prompt goes out only when the terminal has been quiet for a minute with an empty input box; after 60 minutes of waiting the run is skipped.',
    language: 'Language',
    name: 'Name',
    namePlaceholder: 'Morning report',
    terminal: 'Terminal',
    noTerminals: 'No agent terminals are open in Orca',
    notOpen: 'not open',
    terminalGone: 'This terminal is not open — pick it again in Edit',
    refreshTerminals: 'Reload terminals',
    clearFirst: 'Start a new conversation (send /clear first)',
    clearFirstHint: 'Only on a terminal kept for this schedule — /clear erases its conversation.',
    days: 'Days',
    dayChoice: {
      everyDay: 'Every day',
      weekdays: 'Weekdays',
      weekends: 'Weekends',
      pick: 'Pick days',
      dates: 'Dates',
      cron: 'Cron'
    } as Record<string, string>,
    time: 'Time',
    pattern: { times: 'At set times', every: 'Repeat' } as Record<string, string>,
    timeN: (n: number) => `Time ${n}`,
    addTime: 'Add time',
    removeTime: (n: number) => `Remove time ${n}`,
    everyMinutes: 'Every (minutes)',
    range: { allDay: 'All day', between: 'Between' } as Record<string, string>,
    from: 'From',
    to: 'To',
    cron: 'Cron expression',
    cronPlaceholder: 'min hour day month weekday — e.g. 0 9 * * 1-5',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    picked: (n: number) => (n === 1 ? '1 date picked' : `${n} dates picked`),
    prompt: 'Prompt',
    promptPlaceholder: 'The agent in that terminal reads and runs this as is',
    create: 'Create schedule',
    save: 'Save',
    cancel: 'Cancel',
    next: 'next',
    attention: 'Check',
    problem: 'Cannot save',
    off: 'off',
    never: 'never runs again',
    running: 'Running · sent',
    on: 'On',
    sendNow: 'Send now',
    sendNowTip: 'Sends as soon as the terminal is idle',
    edit: 'Edit',
    remove: 'Delete',
    history: (n: number) => `History (${n})`,
    back: 'Back',
    sendOnce: 'Send once',
    sendOnceTip: 'Send a prompt to this terminal once, as soon as it is idle',
    newHere: 'New schedule for this terminal',
    send: 'Send',
    sendHint: 'Goes out once the terminal is idle, then stays under the terminal as a record.',
    namePlaceholderOnce: 'First line of the prompt',
    showInOrca: 'Show this terminal in Orca',
    collapse: 'Collapse',
    expand: 'Expand',
    groupSummary: (n: number, next: string | null) => `${n === 1 ? '1 schedule' : `${n} schedules`}${next ? ` · next ${next}` : ''}`,
    sentGroup: (n: number, last: string | null) => `Sent ${n}${last ? ` · last ${last}` : ''}`,
    view: 'View',
    tabSchedules: (n: number) => `Schedules ${n}`,
    tabTerminals: (n: number) => `Terminals ${n}`,
    find: 'Find',
    findPlaceholder: 'Find schedules or terminals',
    noMatch: (q: string) => `Nothing matches “${q}”`,
    actions: 'Actions',
    settings: 'Settings',
    langAuto: (name: string) => `Same as Orca (${name})`,
    howItWorks: 'How it works',
    duplicate: 'Duplicate',
    copyOf: (name: string) => `${name} copy`,
    deleted: (name: string) => `Deleted “${name}”`,
    undo: 'Undo',
    waitingToSend: 'Waiting to send',
    stats: {
      schedules: (n: number) => (n === 1 ? '1 schedule' : `${n} schedules`),
      on: (n: number) => `${n} on`,
      waiting: (n: number) => `${n} waiting`,
      running: (n: number) => `${n} running`,
      attention: (n: number) => `${n} need attention`,
      today: (n: number) => (n === 1 ? '1 run today' : `${n} runs today`)
    },
    nextUp: (when: string, name: string) => `Next ${when} · ${name}`,
    noneUp: 'No upcoming runs',
    today: 'today',
    tomorrow: 'tomorrow'
  },
  error: {
    times: 'Check the time fields (e.g. 09:00)',
    tooManyTimes: 'Up to 24 times — use Repeat for more',
    noDays: 'Pick at least one day',
    noDates: 'Pick at least one date on the calendar',
    every: 'The interval is 1–720 minutes',
    range: 'End is before start — split a range past midnight into two schedules',
    cron: 'Invalid cron (min hour day month weekday)',
    never: 'This never runs again — check the time',
    name: 'Enter a name',
    terminal: 'Pick an agent terminal (Claude Code, Codex, Gemini CLI)',
    prompt: 'Enter the prompt to send',
    unknown: 'No such schedule'
  },
  bar: {
    none: 'No schedules',
    attention: (n: number) => `${n} need attention`,
    next: 'Next',
    noActive: 'No active schedules'
  },
  weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  monthTitle(year: number, month: number): string {
    return `${en.months[month - 1]} ${year}`
  },
  locale: 'en-US'
}

type Words = typeof en

const ko: Words = {
  status: {
    sent: '보냄',
    success: '성공',
    done: '끝남',
    doneWaiting: '끝남(입력 대기)',
    failed: '실패',
    aborted: '중단',
    noResult: '결과 없음',
    skipped: '건너뜀'
  },
  note: {
    busy: '에이전트가 작업 중',
    dialog: '권한·질문 창이 떠 있음',
    moving: '화면이 1분 안에 움직임(작업 중이거나 입력 중)',
    typing: '입력 칸에 쓰던 글이 있음',
    noPrompt: '입력 칸이 보이지 않음(질문·선택 창이 떠 있을 수 있음)',
    unreadable: '터미널 화면을 읽지 못함(잠시 뒤 다시)',
    missing: '터미널이 열려 있지 않음 — 다시 열리길 기다림',
    noAgent: '터미널에 에이전트가 떠 있지 않음',
    cli: 'Orca CLI 를 쓸 수 없음',
    cleared: '대화를 비웠음(/clear) — 화면이 조용해지면 보냄',
    previous: '지난 회차가 아직 실행 중 — 끝나면 보냄',
    sameTerminal: '같은 터미널에 다른 예약을 막 보내 다음 확인 때 보냄',
    person: '권한·질문 창에서 멈춤 — 그 터미널을 확인해 주세요',
    stuckTyping: '입력 칸에 글이 남은 채 멈춤 — 그 터미널을 확인해 주세요',
    stuckNoPrompt: '입력 칸이 보이지 않은 채 멈춤 — 그 터미널을 확인해 주세요',
    byScreen: '화면 기준',
    closed: '터미널이 닫혀 결과를 모름',
    timeout: '6시간 안에 끝나지 않음',
    sendFailed: '보내기 실패',
    clearFailed: '대화 비우기(/clear) 실패',
    waitedOut: '60분 동안',
    notStarted: '시작 미확인'
  },
  took: (min) => `걸린 시간 ${min}`,
  minutes: (m) => (m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`),
  awaitingAnswer: '질문·확인을 기다리며 멈춤 — 그 터미널을 확인해 주세요',
  ui: {
    newSchedule: '새 예약',
    editSchedule: '예약 고치기',
    emptyTitle: '예약이 없습니다',
    emptyDescription:
      '위의 + 나 「터미널」 탭에서 에이전트 터미널(Claude Code·Codex·Gemini CLI) 줄의 + 를 눌러 시각을 고르면, 그 시각에 터미널이 비어 있을 때 글을 보냅니다.',
    footer:
      'Orca 가 켜져 있는 동안 30초마다 확인합니다. 터미널 화면이 1분 동안 조용하고 입력 칸이 비었을 때만 보내고, 60분을 기다려도 안 되면 그 회차는 건너뜁니다.',
    language: '언어',
    name: '이름',
    namePlaceholder: '아침 리포트 정리',
    terminal: '터미널',
    noTerminals: 'Orca 에 열린 에이전트 터미널이 없습니다',
    notOpen: '지금 없음',
    terminalGone: '이 터미널이 열려 있지 않습니다 — 고치기에서 다시 고르세요',
    refreshTerminals: '터미널 다시 읽기',
    clearFirst: '새 대화로 시작(/clear 먼저 보냄)',
    clearFirstHint: '이 예약만 쓰는 터미널에서만 켜세요 — /clear 는 그 터미널의 대화를 지웁니다.',
    days: '요일',
    dayChoice: {
      everyDay: '매일',
      weekdays: '평일',
      weekends: '휴일(토·일)',
      pick: '요일 고르기',
      dates: '날짜 지정',
      cron: 'cron 직접'
    },
    time: '시각',
    pattern: { times: '정한 시각', every: '반복' },
    timeN: (n) => `시각 ${n}`,
    addTime: '시각 추가',
    removeTime: (n) => `시각 ${n} 빼기`,
    everyMinutes: '간격(분)',
    range: { allDay: '종일', between: '구간' },
    from: '시작',
    to: '끝',
    cron: 'cron 식',
    cronPlaceholder: '분 시 일 월 요일 — 예: 0 9 * * 1-5',
    prevMonth: '이전 달',
    nextMonth: '다음 달',
    picked: (n) => `${n}일 고름`,
    prompt: '보낼 글',
    promptPlaceholder: '그 터미널의 에이전트가 그대로 읽고 실행합니다',
    create: '예약 만들기',
    save: '저장',
    cancel: '취소',
    next: '다음',
    attention: '확인',
    problem: '저장할 수 없음',
    off: '꺼짐',
    never: '앞으로 돌지 않음',
    running: '실행 중 · 보냄',
    on: '켜기',
    sendNow: '지금 보내기',
    sendNowTip: '터미널이 비면 바로 보냅니다',
    edit: '고치기',
    remove: '지우기',
    history: (n) => `기록 ${n}개`,
    back: '뒤로',
    sendOnce: '한 번 보내기',
    sendOnceTip: '이 터미널에 지금 한 번 보냅니다 — 터미널이 한가해지는 대로',
    newHere: '이 터미널에 새 예약',
    send: '보내기',
    sendHint: '터미널이 한가해지면 한 번 보내고, 터미널 아래 「보낸 기록」에 남습니다.',
    namePlaceholderOnce: '보낼 글의 첫 줄',
    showInOrca: 'Orca 에서 이 터미널 보기',
    collapse: '접기',
    expand: '펼치기',
    groupSummary: (n, next) => `예약 ${n}${next ? ` · 다음 ${next}` : ''}`,
    sentGroup: (n, last) => `보낸 기록 ${n}${last ? ` · 마지막 ${last}` : ''}`,
    view: '보기',
    tabSchedules: (n) => `예약 ${n}`,
    tabTerminals: (n) => `터미널 ${n}`,
    find: '찾기',
    findPlaceholder: '예약·터미널 찾기',
    noMatch: (q) => `「${q}」와 맞는 항목이 없습니다`,
    actions: '동작',
    settings: '설정',
    langAuto: (name) => `Orca 와 같게(${name})`,
    howItWorks: '동작 방식',
    duplicate: '복제',
    copyOf: (name) => `${name} 사본`,
    deleted: (name) => `「${name}」 지움`,
    undo: '되돌리기',
    waitingToSend: '보낼 차례를 기다림',
    stats: {
      schedules: (n) => `예약 ${n}`,
      on: (n) => `켜짐 ${n}`,
      waiting: (n) => `대기 ${n}`,
      running: (n) => `실행 중 ${n}`,
      attention: (n) => `확인 필요 ${n}`,
      today: (n) => `오늘 실행 ${n}`
    },
    nextUp: (when, name) => `다음 ${when} · ${name}`,
    noneUp: '다가오는 실행 없음',
    today: '오늘',
    tomorrow: '내일'
  },
  error: {
    times: '시각 칸의 글을 확인해 주세요(예: 09:00)',
    tooManyTimes: '시각은 24개까지 — 더 많으면 「반복」을 쓰세요',
    noDays: '요일을 하나 이상 고르세요',
    noDates: '달력에서 날을 하나 이상 고르세요',
    every: '간격은 1~720분입니다',
    range: '끝이 시작보다 빠릅니다 — 자정을 넘는 구간은 예약 두 개로 나눠 주세요',
    cron: 'cron 식이 틀렸습니다(분 시 일 월 요일)',
    never: '앞으로 돌지 않습니다 — 시각을 확인해 주세요',
    name: '이름을 적어 주세요',
    terminal: '에이전트 터미널을 골라 주세요(Claude Code·Codex·Gemini CLI)',
    prompt: '보낼 글을 적어 주세요',
    unknown: '없는 예약입니다'
  },
  bar: {
    none: '예약 없음',
    attention: (n) => `예약 ${n}개 확인 필요`,
    next: '다음',
    noActive: '켜진 예약 없음'
  },
  weekdays: ['일', '월', '화', '수', '목', '금', '토'],
  months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  monthTitle(year, month) {
    return `${year}년 ${month}월`
  },
  locale: 'ko-KR'
}

const all: Record<Lang, Words> = { en, ko }

export const words = (lang: Lang): Words => all[lang]

export const statusText = (lang: Lang, status: Status): string => all[lang].status[status] ?? status

/** One line for a wait, stop or end reason. */
export function noteText(lang: Lang, note: Note): string {
  const w = all[lang]
  const base = w.note[note.code] ?? note.code
  if (note.code === 'waitedOut' && note.reason) {
    return lang === 'ko' ? `${base} ${w.note[note.reason]}` : `${base}: ${w.note[note.reason].toLowerCase()}`
  }
  return note.detail ? `${base}: ${note.detail}` : base
}

export const minutesText = (lang: Lang, ms: number): string => all[lang].minutes(Math.round(ms / 60_000))

/** History line after the status badge — how long it took, and why. */
export function recordText(lang: Lang, r: { tookMs?: number; note?: Note }): string {
  return [r.tookMs !== undefined ? all[lang].took(minutesText(lang, r.tookMs)) : '', r.note ? noteText(lang, r.note) : '']
    .filter(Boolean)
    .join(' · ')
}

/** Waits a person has to act on — the status bar turns orange and the panel counts them. Others clear by themselves. */
export const attentionCodes: readonly NoteCode[] = ['missing', 'noAgent', 'typing', 'dialog', 'noPrompt', 'cli']

/** Short date and time — `today 14:00`, `tomorrow 09:00`, `11/20 09:00` (`오늘 14:00` …). */
export function whenText(lang: Lang, at: number, now: number = Date.now()): string {
  const w = all[lang]
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000)
  if (diff === 0) return `${w.ui.today} ${hm}`
  if (diff === 1) return `${w.ui.tomorrow} ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
