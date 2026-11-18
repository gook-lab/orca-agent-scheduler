// Panel, notification and history text in English (default) and Korean. Records keep codes, not
// sentences, so switching the language redraws past runs too.
import { reportForm } from './report'

export type Lang = 'en' | 'ko'

export const langOf = (value: unknown): Lang => (value === 'ko' ? 'ko' : 'en')

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** Days, hours, minutes and seconds left in `ms`, counting whole seconds. */
const parts = (ms: number): [number, number, number, number] => {
  const t = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(t / 86400), Math.floor(t / 3600) % 24, Math.floor(t / 60) % 60, t % 60]
}

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
  | 'otherRun'
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
  | 'noLine'

export type Note = { code: NoteCode; reason?: NoteCode; detail?: string }

const en = {
  status: {
    sent: 'Sent',
    success: 'Succeeded',
    done: 'Done',
    doneWaiting: 'Done (awaiting input)',
    failed: 'Failed',
    aborted: 'Stopped',
    noResult: 'Timed out',
    skipped: 'Skipped'
  } as Record<Status, string>,
  note: {
    busy: 'Agent is working',
    dialog: 'A permission or question dialog is open',
    moving: 'Screen changed a moment ago (working or typing)',
    typing: 'Unsent text in the input box',
    noPrompt: 'Input box not visible (a dialog may be open)',
    unreadable: 'Could not read the screen (will retry)',
    missing: 'Terminal is not open — waiting for it',
    noAgent: 'No agent is running in the terminal',
    cli: 'Orca CLI is not available',
    cleared: 'Sent /clear — sending once the screen settles',
    previous: 'Previous run still going — sends when it ends',
    sameTerminal: 'Another schedule just sent to this terminal — next check',
    otherRun: "Another schedule's run is still going in this terminal — sends when it ends",
    person: 'Stopped at a permission or question dialog — check the terminal',
    stuckTyping: 'Stopped with text left in the input box — check the terminal',
    stuckNoPrompt: 'Stopped without a visible input box — check the terminal',
    byScreen: 'by screen',
    closed: 'Terminal closed — result unknown',
    timeout: 'Did not finish within 6 hours',
    sendFailed: 'Send failed',
    clearFailed: '/clear failed',
    waitedOut: 'Waited 60 min',
    notStarted: 'Turn start not confirmed',
    noLine: 'No result line on screen'
  } as Record<NoteCode, string>,
  took: (min: string) => `took ${min}`,
  late: (span: string) => `sent ${span} late`,
  minutes: (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`),
  awaitingAnswer: 'Waiting for an answer — check the terminal',
  /** Added to the end of a prompt whose schedule asks for a result (src/report.ts reads the line back). */
  reportAsk: (token: string) =>
    `When you finish, end your reply with one line in this form: ${reportForm(token, 'one-line summary')} — STATUS is ok, failed or skipped; leave out "[link] URL" when there is no link.`,
  ui: {
    newSchedule: 'New schedule',
    editSchedule: 'Edit schedule',
    emptyTitle: 'No schedules yet',
    emptyDescription: 'Press + on a terminal in the Terminals tab to start.',
    openTerminals: 'Open Terminals',
    footer:
      'Checks every 30 seconds while Orca is running. A prompt goes out only when the terminal has been quiet for a minute with an empty input box; after 60 minutes of waiting the run is skipped. A run that fell due while the computer slept or Orca was closed still goes out once, marked late. Times are this computer\'s local time.',
    language: 'Language',
    name: 'Name',
    namePlaceholder: 'Morning report',
    terminal: 'Terminal',
    change: 'Change',
    moreOptions: 'More options',
    discardTitle: 'Discard what you wrote?',
    discard: 'Discard',
    keepEditing: 'Keep editing',
    noTerminals: 'No agent terminals are open in Orca',
    noTerminalsHint: 'Run claude, codex or gemini in an Orca terminal and it shows up here.',
    noCli: 'Orca CLI not found',
    noCliHint: 'Prompts go out through the CLI inside the Orca app, and it was not found here. For now this plugin works on macOS only.',
    notOpen: 'not open',
    terminalGone: 'This terminal is closed — nothing can be sent to it',
    pickTerminal: 'Pick a terminal',
    refreshTerminals: 'Reload terminals',
    clearFirst: 'Start a new conversation (send /clear first)',
    clearFirstHint: 'Only on a terminal kept for this schedule — /clear erases its conversation.',
    report: 'Ask for a one-line result',
    reportHint: 'Adds a sentence to the prompt asking the agent to end with one line: how it went (ok, failed or skipped), a summary, and a link if there is one. They show with the run.',
    reportNotOnCommand: 'Not added to a prompt that starts with / — a command goes out as it is, and no result is read.',
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
    clock: (zone: string) => `Times are this computer's local time (${zone}).`,
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
    promptPlaceholder: 'What the agent in that terminal should do',
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
    sendNowQueued: 'Already waiting to send',
    sendNowRunning: 'Already running — send again when this run ends',
    edit: 'Edit',
    remove: 'Delete',
    history: (n: number) => `History (${n})`,
    close: 'Close',
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
    // Waiting ones are counted apart — a send stuck on a closed terminal has not been sent.
    sentGroup: (sent: number, waiting: number, last: string | null) =>
      [waiting ? `Waiting to send ${waiting}` : '', sent ? `Sent ${sent}` : '', !waiting && last ? `last ${last}` : '']
        .filter(Boolean)
        .join(' · '),
    view: 'View',
    // No number while the list is still being read — 0 would read as "none".
    tabSchedules: (n: number | null) => (n === null ? 'Schedules' : `Schedules ${n}`),
    tabTerminals: (n: number | null) => (n === null ? 'Terminals' : `Terminals ${n}`),
    find: 'Find',
    findPlaceholder: 'Find schedules or terminals',
    noMatch: (q: string) => `Nothing matches “${q}”`,
    clearSearch: 'Clear search',
    actions: 'Actions',
    settings: 'Settings',
    langAuto: (name: string) => `Same as Orca (${name})`,
    help: 'How sending works',
    showIntro: 'Show the introduction again',
    whatsNew: "What's new",
    importer: {
      title: 'Import from OrcaCron',
      hint: (dir: string) =>
        `Copies the schedules of the menubar app OrcaCron (${dir}). They arrive switched off: turn each one off in OrcaCron, then on here — while both are on, the prompt goes out twice. The app's limit on late runs does not come over: here a run missed while the computer slept still goes out once.`,
      button: (n: number) => (n === 1 ? 'Import 1 schedule' : `Import ${n} schedules`),
      done: (n: number) => (n === 1 ? 'Imported 1 schedule, switched off' : `Imported ${n} schedules, switched off`),
      doneHint: 'Turn each one off in OrcaCron, then switch it on in the Schedules tab.',
      imported: 'imported',
      badCron: 'cannot import — times not understood',
      nothing: 'Everything is already imported.',
      failed: 'Could not import'
    },
    intro: {
      steps: [
        {
          title: 'Prompts on a schedule',
          body: 'Pick an agent terminal — Claude Code, Codex or Gemini CLI — and a time. At that time the prompt goes into the terminal as if you typed it.'
        },
        {
          title: 'Only when the terminal is free',
          body: 'It waits until the screen has been quiet for a minute and the input box is empty. After 60 minutes of waiting, that run is skipped.'
        },
        {
          title: 'Start from a terminal',
          body: 'On the Terminals tab, + makes a schedule and › sends a prompt once.'
        }
      ],
      step: (n: number, of: number) => `${n} / ${of}`,
      skip: 'Skip',
      prev: 'Back',
      next: 'Next',
      start: 'Get started'
    },
    duplicate: 'Duplicate',
    copyOf: (name: string) => `${name} copy`,
    deleted: (name: string) => `Deleted “${name}”`,
    deleteAsk: (name: string) => `Delete “${name}”?`,
    deleteLoses: (n: number) => `Its ${n} past ${n === 1 ? 'result goes' : 'results go'} with it.`,
    undo: 'Undo',
    waitingToSend: 'Waiting to send',
    stats: {
      waiting: (n: number) => `${n} waiting`,
      running: (n: number) => `${n} running`,
      attention: (n: number) => `${n} need attention`
    },
    /** The time left, to the minute — a card does not tick by the second. */
    inAbout: (ms: number) => {
      const [d, h, m] = parts(ms)
      if (ms < 60_000) return 'now'
      if (d > 0) return `in ${d}d ${h}h`
      return h > 0 ? `in ${h}h ${pad2(m)}m` : `in ${m}m`
    },
    more: 'More',
    less: 'Less',
    loading: 'Reading the list',
    today: 'today',
    tomorrow: 'tomorrow'
  },
  error: {
    times: 'Check the time fields (e.g. 09:00, 21:30 or 9:30 pm)',
    tooManyTimes: 'Up to 24 times — use Repeat for more',
    noDays: 'Pick at least one day',
    noDates: 'Pick at least one date on the calendar',
    every: 'The interval is 1–720 minutes',
    range: 'End is before start — split a range past midnight into two schedules',
    cron: 'Invalid cron (min hour day month weekday)',
    never: 'This never runs again — check the time',
    name: 'Enter a name',
    terminal: 'Pick an agent terminal (Claude Code, Codex, Gemini CLI)',
    running: 'Its run is still going — change the terminal once it has ended',
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
    noResult: '시간 초과',
    skipped: '건너뜀'
  },
  note: {
    busy: '에이전트가 작업 중',
    dialog: '권한·질문 창이 떠 있음',
    moving: '화면이 방금 움직임(작업 중이거나 입력 중)',
    typing: '입력 칸에 쓰던 글이 있음',
    noPrompt: '입력 칸이 보이지 않음(질문·선택 창이 떠 있을 수 있음)',
    unreadable: '터미널 화면을 읽지 못함(잠시 뒤 다시)',
    missing: '터미널이 열려 있지 않음 — 다시 열리길 기다림',
    noAgent: '터미널에 에이전트가 떠 있지 않음',
    cli: 'Orca CLI 를 쓸 수 없음',
    cleared: '대화를 비웠음(/clear) — 화면이 조용해지면 보냄',
    previous: '지난 회차가 아직 실행 중 — 끝나면 보냄',
    sameTerminal: '같은 터미널에 다른 예약을 막 보내 다음 확인 때 보냄',
    otherRun: '같은 터미널에서 다른 예약의 회차가 아직 실행 중 — 끝나면 보냄',
    person: '권한·질문 창에서 멈춤 — 그 터미널을 확인해 주세요',
    stuckTyping: '입력 칸에 글이 남은 채 멈춤 — 그 터미널을 확인해 주세요',
    stuckNoPrompt: '입력 칸이 보이지 않은 채 멈춤 — 그 터미널을 확인해 주세요',
    byScreen: '화면 기준',
    closed: '터미널이 닫혀 결과를 모름',
    timeout: '6시간 안에 끝나지 않음',
    sendFailed: '보내기 실패',
    clearFailed: '대화 비우기(/clear) 실패',
    waitedOut: '60분 기다림',
    notStarted: '시작 미확인',
    noLine: '화면에 결과 줄이 없음'
  },
  took: (min) => `걸린 시간 ${min}`,
  late: (span) => `${span} 늦게 보냄`,
  minutes: (m) => (m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`),
  awaitingAnswer: '질문·확인을 기다리며 멈춤 — 그 터미널을 확인해 주세요',
  reportAsk: (token) =>
    `끝나면 답의 마지막 줄을 이 형식으로 적는다: ${reportForm(token, '한 줄 요약')} — STATUS 는 ok · failed · skipped 중 하나, 링크가 없으면 「[link] URL」은 뺀다.`,
  ui: {
    newSchedule: '새 예약',
    editSchedule: '예약 고치기',
    emptyTitle: '예약이 없습니다',
    emptyDescription: '「터미널」 탭에서 터미널 줄의 + 를 눌러 시작하세요.',
    openTerminals: '터미널 보기',
    footer:
      'Orca 가 켜져 있는 동안 30초마다 확인합니다. 터미널 화면이 1분 동안 조용하고 입력 칸이 비었을 때만 보내고, 60분을 기다려도 안 되면 그 회차는 건너뜁니다. 컴퓨터가 자거나 Orca 가 꺼져 있어 놓친 회차는 다시 켜진 뒤 한 번 보내고 「늦게 보냄」으로 남깁니다. 시각은 이 컴퓨터의 현지 시각입니다.',
    language: '언어',
    name: '이름',
    namePlaceholder: '아침 리포트 정리',
    terminal: '터미널',
    change: '바꾸기',
    moreOptions: '더 보기',
    discardTitle: '쓰던 내용을 버릴까요?',
    discard: '버리기',
    keepEditing: '계속 쓰기',
    noTerminals: 'Orca 에 열린 에이전트 터미널이 없습니다',
    noTerminalsHint: 'Orca 터미널에서 claude · codex · gemini 를 실행하면 여기 나옵니다.',
    noCli: 'Orca CLI 를 찾지 못했습니다',
    noCliHint: '보내기는 Orca 앱 안의 CLI 로 하는데, 여기서는 그 CLI 를 찾지 못했습니다. 지금은 macOS 에서만 동작합니다.',
    notOpen: '지금 없음',
    terminalGone: '이 터미널이 닫혀 있어 보낼 수 없습니다',
    pickTerminal: '터미널 고르기',
    refreshTerminals: '터미널 다시 읽기',
    clearFirst: '새 대화로 시작(/clear 먼저 보냄)',
    clearFirstHint: '이 예약만 쓰는 터미널에서만 켜세요 — /clear 는 그 터미널의 대화를 지웁니다.',
    report: '끝나면 결과 한 줄 받기',
    reportHint: '보낼 글 끝에, 마지막 줄에 상태(ok · failed · skipped)와 한 줄 요약, 링크가 있으면 링크를 적어 달라는 문장을 붙입니다. 그 줄을 실행 기록에 보여 줍니다.',
    reportNotOnCommand: '/ 로 시작하는 글(명령)에는 붙이지 않습니다 — 그대로 보내고 결과도 읽지 않습니다.',
    days: '요일',
    dayChoice: {
      everyDay: '매일',
      weekdays: '평일',
      weekends: '주말(토·일)',
      pick: '요일 고르기',
      dates: '날짜 지정',
      cron: 'cron 직접'
    },
    time: '시각',
    clock: (zone) => `시각은 이 컴퓨터의 현지 시각입니다(${zone}).`,
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
    promptPlaceholder: '그 터미널의 에이전트에게 시킬 일',
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
    sendNowQueued: '이미 보내기를 기다리는 중입니다',
    sendNowRunning: '이미 실행 중입니다 — 이 회차가 끝난 뒤 다시 보내세요',
    edit: '고치기',
    remove: '지우기',
    history: (n) => `기록 ${n}개`,
    close: '닫기',
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
    sentGroup: (sent, waiting, last) =>
      [waiting ? `보내기 대기 ${waiting}` : '', sent ? `보낸 기록 ${sent}` : '', !waiting && last ? `마지막 ${last}` : '']
        .filter(Boolean)
        .join(' · '),
    view: '보기',
    tabSchedules: (n) => (n === null ? '예약' : `예약 ${n}`),
    tabTerminals: (n) => (n === null ? '터미널' : `터미널 ${n}`),
    find: '찾기',
    findPlaceholder: '예약·터미널 찾기',
    noMatch: (q) => `「${q}」와 맞는 항목이 없습니다`,
    clearSearch: '검색어 지우기',
    actions: '동작',
    settings: '설정',
    langAuto: (name) => `Orca 와 같게(${name})`,
    help: '보내는 방식',
    showIntro: '소개 다시 보기',
    whatsNew: '업데이트 내역',
    importer: {
      title: 'OrcaCron 에서 가져오기',
      hint: (dir) =>
        `메뉴바 앱 OrcaCron(${dir})의 예약을 복사합니다. 꺼진 채로 들어오니, OrcaCron 에서 그 예약을 끈 뒤 여기서 켜세요 — 둘 다 켜져 있으면 같은 글이 두 번 나갑니다. 앱의 「늦으면 건너뜀」 한도는 넘어오지 않습니다: 여기서는 컴퓨터가 자는 동안 놓친 회차를 한 번 보냅니다.`,
      button: (n) => `예약 ${n}개 가져오기`,
      done: (n) => `예약 ${n}개를 꺼진 채로 가져왔습니다`,
      doneHint: 'OrcaCron 에서 그 예약을 끈 뒤 「예약」 탭에서 켜세요.',
      imported: '가져옴',
      badCron: '가져올 수 없음 — 시각을 읽지 못함',
      nothing: '모두 이미 가져왔습니다.',
      failed: '가져오지 못했습니다'
    },
    intro: {
      steps: [
        {
          title: '정한 시각에 프롬프트 보내기',
          body: '에이전트 터미널(Claude Code·Codex·Gemini CLI)과 시각을 고르면, 그 시각에 그 터미널에 글을 대신 입력해 보냅니다.'
        },
        {
          title: '터미널이 비어 있을 때만',
          body: '화면이 1분 동안 조용하고 입력 칸이 비었을 때 보냅니다. 60분을 기다려도 안 되면 그 회차는 건너뜁니다.'
        },
        {
          title: '터미널에서 시작',
          body: '「터미널」 탭에서 + 는 예약, › 는 한 번 보내기입니다.'
        }
      ],
      step: (n, of) => `${n} / ${of}`,
      skip: '건너뛰기',
      prev: '이전',
      next: '다음',
      start: '시작하기'
    },
    duplicate: '복제',
    copyOf: (name) => `${name} 사본`,
    deleted: (name) => `「${name}」 지움`,
    deleteAsk: (name) => `「${name}」 예약을 지울까요?`,
    deleteLoses: (n) => `지난 기록 ${n}개도 함께 지워집니다.`,
    undo: '되돌리기',
    waitingToSend: '보내기 대기',
    stats: {
      waiting: (n) => `대기 ${n}`,
      running: (n) => `실행 중 ${n}`,
      attention: (n) => `확인 필요 ${n}`
    },
    inAbout: (ms) => {
      const [d, h, m] = parts(ms)
      if (ms < 60_000) return '곧'
      if (d > 0) return `${d}일 ${h}시간 뒤`
      return h > 0 ? `${h}시간 ${pad2(m)}분 뒤` : `${m}분 뒤`
    },
    more: '더 보기',
    less: '접기',
    loading: '목록을 읽는 중',
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
    running: '실행이 아직 끝나지 않았습니다 — 끝난 뒤에 터미널을 바꿔 주세요',
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
  if (note.reason) {
    return lang === 'ko' ? `${base} · ${w.note[note.reason]}` : `${base}: ${w.note[note.reason].toLowerCase()}`
  }
  return note.detail ? `${base}: ${note.detail}` : base
}

export const minutesText = (lang: Lang, ms: number): string => all[lang].minutes(Math.round(ms / 60_000))

/** `sent 6 h 2 min late` for a run caught up after its time; empty when it went out on time. */
export const lateText = (lang: Lang, lateMs: number | undefined): string => (lateMs === undefined ? '' : all[lang].late(minutesText(lang, lateMs)))

/** History line after the status badge — how late it went out, how long it took, and why. */
export function recordText(lang: Lang, r: { tookMs?: number; note?: Note; lateMs?: number }): string {
  return [lateText(lang, r.lateMs), r.tookMs !== undefined ? all[lang].took(minutesText(lang, r.tookMs)) : '', r.note ? noteText(lang, r.note) : '']
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
