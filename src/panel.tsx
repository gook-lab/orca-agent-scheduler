// 예약 패널 — 워크스페이스·에이전트·시각·보낼 글을 정한다. 시각이 되면 worker 가 새 에이전트를 띄워 보낸다.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  host,
  IconButton,
  Input,
  on,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Switch,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { clock, cronOf, type DayChoice, dayChoices, describe, nextRun, parseCron, parseTimes, specOf } from './cron'
import type { Schedule } from './engine'
import type { WorkspaceOption } from './protocol'
import './protocol'
import { agentKind, agentKinds, agentName } from './screen'

/** worker 가 알려 주는 예약 목록 — 처음에 한 번 묻고, 고칠 때마다 worker 가 다시 보낸다. */
const schedules = atom<Schedule[]>([])
const workspaces = atom<WorkspaceOption[]>([])
/** 지금 보고 있는 워크스페이스 — 새 예약의 기본값. */
const focused = atom<{ displayName: string; branch: string } | null>(null)

type Draft = {
  id?: string
  name: string
  workspaceId: string
  agent: string
  day: DayChoice | 'cron'
  times: string
  cron: string
  prompt: string
}
const emptyDraft = (): Draft => ({
  name: '',
  workspaceId: '',
  agent: 'claude',
  day: 'weekdays',
  times: '09:00',
  cron: '0 9 * * 1-5',
  prompt: ''
})
const draft = atom<Draft>(emptyDraft())
const formOpen = atom(false)
const formError = atom<string | null>(null)
const saving = atom(false)

async function refreshWorkspaces(): Promise<void> {
  try {
    set(workspaces, await plugin.request('workspaces.list'))
  } catch {
    set(workspaces, [])
  }
}

/** 지금 보고 있는 워크스페이스의 id(이름·브랜치가 같은 것). */
function focusedId(): string {
  const f = read(focused)
  if (!f) return ''
  return read(workspaces).find((w) => w.name === f.displayName && (w.branch ?? '') === f.branch)?.id ?? ''
}

function openNew(): void {
  set(draft, { ...emptyDraft(), workspaceId: focusedId() })
  set(formError, null)
  set(formOpen, true)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('schedules.changed', (p) => set(schedules, p.schedules)))
  ctx.subscriptions.push(on('workspace.changed', (e) => set(focused, e.context)))
  ctx.subscriptions.push(on('workspace.created', () => void refreshWorkspaces()))
  ctx.subscriptions.push(on('workspace.removed', () => void refreshWorkspaces()))
  // worker 를 깨우고 지금 목록을 받는다.
  void plugin.request('schedules.list').then((list) => set(schedules, list)).catch(() => undefined)
  void refreshWorkspaces()
  void host.call('workspace.readContext').then((c) => set(focused, c)).catch(() => undefined)
}

/** 고른 요일·시각(또는 cron 직접)을 식으로. 틀리면 이유. */
function cronOfDraft(d: Draft): { cron: string } | { error: string } {
  if (d.day === 'cron') {
    const rules = parseCron(d.cron)
    if (!rules) return { error: 'cron 식이 틀렸습니다(분 시 일 월 요일)' }
    return nextRun(rules, new Date()) ? { cron: d.cron.trim() } : { error: '이 식으로는 앞으로 돌지 않습니다' }
  }
  const times = parseTimes(d.times)
  if (!times) return { error: '시각은 09:00, 18:30 처럼 쉼표로 나눠 적어 주세요(24개까지)' }
  return { cron: cronOf(d.day, times) }
}

async function save(): Promise<void> {
  const d = read(draft)
  const c = cronOfDraft(d)
  if ('error' in c) return set(formError, c.error)
  const target = read(workspaces).find((w) => w.id === d.workspaceId)
  const old = read(schedules).find((s) => s.id === d.id)
  set(saving, true)
  try {
    await plugin.request('schedules.save', {
      ...(d.id ? { id: d.id } : {}),
      name: d.name,
      workspaceId: d.workspaceId,
      workspace: target?.name ?? old?.workspace ?? '',
      agent: d.agent,
      cron: c.cron,
      prompt: d.prompt,
      enabled: old?.enabled ?? true
    })
    set(draft, emptyDraft())
    set(formError, null)
    set(formOpen, false)
  } catch (error) {
    set(formError, (error as Error).message)
  } finally {
    set(saving, false)
  }
}

function edit(s: Schedule): void {
  const spec = specOf(s.cron)
  set(draft, {
    id: s.id,
    name: s.name,
    workspaceId: s.workspaceId,
    agent: s.agent,
    day: spec?.day ?? 'cron',
    times: spec ? spec.times.map(clock).join(', ') : '09:00',
    cron: s.cron,
    prompt: s.prompt
  })
  set(formError, null)
  set(formOpen, true)
}

const agentLabel = (agent: string | null): string => {
  const k = agentKind(agent)
  return k ? agentName[k] : '에이전트'
}

const workspaceLabel = (w: WorkspaceOption): string => (w.branch && w.branch !== w.name ? `${w.name} · ${w.branch}` : w.name)

const statusTone = (status: string | null): 'success' | 'danger' | 'warning' | 'neutral' =>
  status === '성공' || status?.startsWith('끝남')
    ? 'success'
    : status === '실패' || status === '결과 없음'
      ? 'danger'
      : status === '건너뜀' || status === '중단'
        ? 'warning'
        : 'neutral'

const when = (at: number): string => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function ScheduleCard({ s }: { s: Schedule }) {
  const last = s.history[0]
  const gone = read(workspaces).length > 0 && !read(workspaces).some((w) => w.id === s.workspaceId)
  const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null) ?? (gone ? '워크스페이스가 없어졌습니다 — 고치기에서 다시 고르세요' : null)
  return (
    <Card title={s.name} description={`${agentLabel(s.agent)} · ${s.workspace}`}>
      <Stack gap="xs">
        <Text size="sm">
          {describe(s.cron)}
          {s.enabled && s.nextRunAt !== null ? (
            <Text muted size="sm">
              {' · 다음 '}
              <RelativeTime at={s.nextRunAt} />
            </Text>
          ) : (
            <Text muted size="sm">{s.enabled ? ' · 앞으로 돌지 않음' : ' · 꺼짐'}</Text>
          )}
        </Text>
        {s.sentAt !== null ? (
          <Text size="sm" tone="accent">
            {'실행 중 · '}
            <RelativeTime at={s.sentAt} />
            {' 띄움'}
          </Text>
        ) : last ? (
          <Row gap="xs">
            <Badge tone={statusTone(last.status)}>{last.status}</Badge>
            <Text muted size="xs" truncate>
              {[when(last.at), last.summary].filter(Boolean).join(' · ')}
            </Text>
          </Row>
        ) : null}
        {note ? (
          <Callout tone="warning" icon="warning">
            {note}
          </Callout>
        ) : null}
        <Row justify="between">
          <Switch
            label="켜기"
            checked={s.enabled}
            onChange={(enabled) => void plugin.request('schedules.toggle', { id: s.id, enabled })}
          />
          <Row gap="xs">
            <IconButton
              icon="play"
              label="지금 보내기"
              tooltip="새 에이전트를 바로 띄워 보냅니다"
              onPress={() => void plugin.request('schedules.runNow', { id: s.id })}
            />
            <IconButton icon="edit" label="고치기" onPress={() => edit(s)} />
            <IconButton icon="delete" label="지우기" tone="danger" onPress={() => void plugin.request('schedules.delete', { id: s.id })} />
          </Row>
        </Row>
        {s.history.length > 0 ? (
          <Collapsible title={`기록 ${s.history.length}개`}>
            <Stack gap="xs">
              {s.history.slice(0, 10).map((r) => (
                <Row gap="xs">
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  <Text muted size="xs" truncate>
                    {[when(r.at), r.summary].filter(Boolean).join(' · ')}
                  </Text>
                </Row>
              ))}
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Card>
  )
}

function Form() {
  const d = read(draft)
  const list = read(workspaces)
  const old = read(schedules).find((s) => s.id === d.id)
  const options = list.map((w) => ({ value: w.id, label: workspaceLabel(w) }))
  if (d.workspaceId && !options.some((o) => o.value === d.workspaceId)) {
    options.unshift({ value: d.workspaceId, label: `${old?.workspace ?? '고른 워크스페이스'} (지금 없음)` })
  }
  const c = cronOfDraft(d)
  const patch = (p: Partial<Draft>) => update(draft, (x) => ({ ...x, ...p }))
  return (
    <Stack gap="sm">
      <Input label="이름" value={d.name} placeholder="아침 리포트 정리" onChange={(name) => patch({ name })} />
      <Select
        label="워크스페이스"
        value={d.workspaceId}
        placeholder={list.length === 0 ? '워크스페이스 목록을 읽지 못했습니다' : '고르세요'}
        options={options}
        onChange={(workspaceId) => patch({ workspaceId })}
      />
      <RadioGroup
        label="에이전트"
        orientation="horizontal"
        value={d.agent}
        options={agentKinds.map((k) => ({ value: k, label: agentName[k] }))}
        onChange={(agent) => patch({ agent })}
      />
      <RadioGroup
        label="요일"
        orientation="horizontal"
        value={d.day}
        options={[...dayChoices, { value: 'cron', label: 'cron 직접' }]}
        onChange={(day) => patch({ day: day as Draft['day'] })}
      />
      {d.day === 'cron' ? (
        <Input label="cron 식" value={d.cron} placeholder="분 시 일 월 요일 — 예: 0 9 * * 1-5" onChange={(cron) => patch({ cron })} invalid={'error' in c} />
      ) : (
        <Input label="시각" value={d.times} placeholder="09:00, 18:30" onChange={(times) => patch({ times })} invalid={'error' in c} />
      )}
      <Text muted size="xs">
        {'error' in c ? c.error : describe(c.cron)}
      </Text>
      <Textarea label="보낼 글" rows={4} value={d.prompt} placeholder="새로 띄운 에이전트가 그대로 읽고 실행합니다" onChange={(prompt) => patch({ prompt })} />
      {read(formError) ? <Callout tone="danger">{read(formError)}</Callout> : null}
      <Row gap="xs">
        <Button tone="accent" variant="solid" disabled={read(saving) || 'error' in c} onPress={() => void save()}>
          {d.id ? '저장' : '예약 만들기'}
        </Button>
        <Button
          variant="ghost"
          onPress={() => {
            set(draft, emptyDraft())
            set(formError, null)
            set(formOpen, false)
          }}
        >
          취소
        </Button>
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const list = read(schedules)
  const open = read(formOpen)
  return (
    <Stack gap="md">
      <Collapsible
        title={read(draft).id ? '예약 고치기' : '새 예약'}
        open={open}
        onChange={(o) => (o && !read(draft).id && !read(draft).workspaceId ? openNew() : set(formOpen, o))}
      >
        <Form />
      </Collapsible>
      {list.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="예약이 없습니다"
          description="「새 예약」에서 워크스페이스와 에이전트(Claude Code·Codex·Gemini CLI)를 고르면, 정해진 시각마다 새 에이전트를 띄워 글을 보냅니다."
        />
      ) : (
        list.map((s) => <ScheduleCard s={s} />)
      )}
      <Text muted size="xs">
        Orca 가 켜져 있는 동안 30초마다 확인합니다. 회차마다 새 터미널 탭이 생기니 다 본 탭은 닫아 주세요. 지난 회차가 아직 돌고 있으면 끝날 때까지(최대 60분) 기다렸다 띄웁니다.
      </Text>
    </Stack>
  )
}
