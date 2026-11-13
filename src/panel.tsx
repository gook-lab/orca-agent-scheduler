// 예약 패널 — 지금 보고 있는 워크스페이스의 에이전트에 예약을 건다. 실행은 worker 가 한다.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Collapsible,
  EmptyState,
  Field,
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
import './protocol'
import { agentKind, agentName } from './screen'

type Agent = { terminalId: string; title: string; agent: string | null; state: string }

/** worker 가 알려 주는 예약 목록 — 처음에 한 번 묻고, 고칠 때마다 worker 가 다시 보낸다. */
const schedules = atom<Schedule[]>([])
const agents = atom<Agent[]>([])
const workspaceName = atom<string>('')

type Draft = {
  id?: string
  name: string
  terminalId: string
  day: DayChoice | 'cron'
  times: string
  cron: string
  prompt: string
  clearFirst: boolean
}
const emptyDraft = (): Draft => ({ name: '', terminalId: '', day: 'weekdays', times: '09:00', cron: '0 9 * * 1-5', prompt: '', clearFirst: false })
const draft = atom<Draft>(emptyDraft())
const formOpen = atom(false)
const formError = atom<string | null>(null)
const saving = atom(false)

async function refreshAgents(): Promise<void> {
  try {
    const [{ agents: list }, context] = await Promise.all([host.call('agents.list'), host.call('workspace.readContext')])
    set(
      agents,
      list
        .filter((a) => a.terminalId && agentKind(a.agent))
        .map((a) => ({ terminalId: a.terminalId as string, title: a.title ?? '터미널', agent: a.agent, state: a.state }))
    )
    set(workspaceName, context?.displayName ?? '')
  } catch {
    set(agents, [])
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('schedules.changed', (p) => set(schedules, p.schedules)))
  ctx.subscriptions.push(on('workspace.changed', () => void refreshAgents()))
  ctx.subscriptions.push(on('agent.status.changed', () => void refreshAgents()))
  // worker 를 깨우고 지금 목록을 받는다.
  void plugin.request('schedules.list').then((list) => set(schedules, list)).catch(() => undefined)
  void refreshAgents()
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
  const target = read(agents).find((a) => a.terminalId === d.terminalId)
  const old = read(schedules).find((s) => s.id === d.id)
  set(saving, true)
  try {
    await plugin.request('schedules.save', {
      ...(d.id ? { id: d.id } : {}),
      name: d.name,
      terminalId: d.terminalId,
      terminalTitle: target?.title ?? old?.terminalTitle ?? '',
      agent: target?.agent ?? old?.agent ?? null,
      workspace: target ? read(workspaceName) : (old?.workspace ?? ''),
      cron: c.cron,
      prompt: d.prompt,
      clearFirst: d.clearFirst,
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
    terminalId: s.terminalId,
    day: spec?.day ?? 'cron',
    times: spec ? spec.times.map(clock).join(', ') : '09:00',
    cron: s.cron,
    prompt: s.prompt,
    clearFirst: s.clearFirst
  })
  set(formError, null)
  set(formOpen, true)
}

const agentLabel = (agent: string | null): string => {
  const k = agentKind(agent)
  return k ? agentName[k] : '에이전트'
}

const statusTone = (status: string | null): 'success' | 'danger' | 'warning' | 'neutral' =>
  status === '성공' || status?.startsWith('끝남')
    ? 'success'
    : status === '실패' || status === '결과 없음'
      ? 'danger'
      : status === '건너뜀' || status === '중단'
        ? 'warning'
        : 'neutral'

function ScheduleCard({ s }: { s: Schedule }) {
  const live = read(agents).find((a) => a.terminalId === s.terminalId)
  const last = s.history[0]
  const note = s.blocked ?? (s.pendingSince !== null ? s.waitNote : null)
  return (
    <Card title={s.name} description={`${agentLabel(s.agent)} · ${live?.title ?? s.terminalTitle}${s.workspace ? ` · ${s.workspace}` : ''}`}>
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
            {'보냄 · 끝나기를 기다리는 중 '}
            <RelativeTime at={s.sentAt} />
          </Text>
        ) : last ? (
          <Row gap="xs">
            <Badge tone={statusTone(last.status)}>{last.status}</Badge>
            <Text muted size="xs" truncate>
              {[new Date(last.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), last.summary]
                .filter(Boolean)
                .join(' · ')}
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
            <IconButton icon="play" label="지금 보내기" tooltip="터미널이 비면 바로 보냅니다" onPress={() => void plugin.request('schedules.runNow', { id: s.id })} />
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
                    {[new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), r.summary]
                      .filter(Boolean)
                      .join(' · ')}
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
  const list = read(agents)
  const old = read(schedules).find((s) => s.id === d.id)
  const options = list.map((a) => ({ value: a.terminalId, label: `${agentLabel(a.agent)} · ${a.title}` }))
  if (d.terminalId && !options.some((o) => o.value === d.terminalId)) {
    options.unshift({ value: d.terminalId, label: `${old?.terminalTitle ?? '고른 터미널'} (이 워크스페이스에 없음)` })
  }
  const c = cronOfDraft(d)
  const patch = (p: Partial<Draft>) => update(draft, (x) => ({ ...x, ...p }))
  return (
    <Stack gap="sm">
      <Input label="이름" value={d.name} placeholder="아침 리포트 정리" onChange={(name) => patch({ name })} />
      <Select
        label="터미널"
        value={d.terminalId}
        placeholder={list.length === 0 ? '이 워크스페이스에 에이전트 터미널이 없습니다' : '고르세요'}
        options={options}
        onChange={(terminalId) => patch({ terminalId })}
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
      <Textarea label="보낼 글" rows={4} value={d.prompt} placeholder="받는 에이전트가 그대로 읽고 실행합니다" onChange={(prompt) => patch({ prompt })} />
      <Checkbox
        label="보내기 전에 대화 비우기(/clear)"
        description="켜면 보낼 때마다 그 터미널의 대화를 지웁니다. 꺼 두면 쓰던 터미널에 걸어도 화면이 조용해질 때까지 기다렸다 보냅니다."
        checked={d.clearFirst}
        onChange={(clearFirst) => patch({ clearFirst })}
      />
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
      <Collapsible title={read(draft).id ? '예약 고치기' : '새 예약'} open={open} onChange={(o) => set(formOpen, o)}>
        <Form />
      </Collapsible>
      {list.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="예약이 없습니다"
          description="「새 예약」에서 이 워크스페이스의 Claude Code·Codex·Gemini 터미널을 골라 정해진 시각에 글을 보냅니다."
        />
      ) : (
        list.map((s) => <ScheduleCard s={s} />)
      )}
      <Text muted size="xs">
        Orca 가 켜져 있는 동안 30초마다 확인합니다. 터미널이 일하는 중이거나 입력 칸에 글이 있으면 빌 때까지 기다리고, 60분이 지나면 그 회차는 건너뜁니다.
      </Text>
    </Stack>
  )
}
