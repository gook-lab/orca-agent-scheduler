// 패널 ↔ worker 약속. src/panel.tsx 와 src/worker.ts 가 함께 읽는다.
import type { Schedule } from './engine'

export {}

/** 패널이 저장을 부탁할 때 보내는 칸 — 실행 상태 칸은 worker 가 채운다. */
export type ScheduleDraft = Pick<Schedule, 'name' | 'workspaceId' | 'workspace' | 'agent' | 'cron' | 'prompt' | 'enabled'> & {
  id?: string
}

/** 고를 수 있는 워크스페이스(workspace.list 는 worker 만 부를 수 있다). */
export type WorkspaceOption = { id: string; name: string; branch: string | null; path: string; kind: 'worktree' | 'folder' }

export type RunnerStatus = { lastTickAt: number | null; log: string[] }

declare module 'orca' {
  interface PluginRequests {
    /** 예약 전부(worker 를 깨우는 용도도 겸한다). */
    'schedules.list': { output: Schedule[] }
    /** 새로 만들거나 고친다. 칸이 틀리면 invalid_params. */
    'schedules.save': { input: ScheduleDraft; output: Schedule }
    'schedules.delete': { input: { id: string }; output: { ok: true } }
    'schedules.toggle': { input: { id: string; enabled: boolean }; output: Schedule }
    /** 시각과 상관없이 지금 띄운다(지난 회차가 돌고 있으면 끝난 뒤). */
    'schedules.runNow': { input: { id: string }; output: Schedule }
    'workspaces.list': { output: WorkspaceOption[] }
    'runner.status': { output: RunnerStatus }
  }
  interface PluginPanelEvents {
    'schedules.changed': { schedules: Schedule[] }
  }
}
