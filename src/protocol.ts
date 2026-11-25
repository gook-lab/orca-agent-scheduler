// Panel ↔ worker contract. Read by both src/panel.tsx and src/worker.ts.
import type { Schedule, TerminalRef } from './engine'

export {}

/** What the panel sends to save — the worker fills in the run state. */
export type ScheduleDraft = Pick<Schedule, 'name' | 'terminal' | 'cron' | 'prompt' | 'enabled' | 'clearFirst'> & {
  id?: string
  /** Ask the agent for a result line (Schedule.report); left out = no. */
  report?: boolean
  /** Send once now (no times) — cron is ignored and the name may be empty. */
  once?: boolean
  /** Shell command run before sending (Schedule.precheck); left out = none. Not for Send once. */
  precheck?: string
}

/** An agent terminal the panel can offer (only the worker can run the Orca CLI). */
export type TerminalOption = TerminalRef

export type RunnerStatus = {
  lastTickAt: number | null
  log: string[]
  /** False when the worker could not find the Orca CLI — nothing can be listed or sent (README "Sending"). */
  cli: boolean
}

/** A schedule of the menubar app OrcaCron, as Settings lists it before importing (src/orcacron.ts). */
export type ImportEntry = {
  id: string
  name: string
  cron: string
  terminal: TerminalRef
  /** That terminal is open in Orca now. */
  open: boolean
  /** Already brought over. */
  imported: boolean
  badCron: boolean
}

/** `found` is false when the app's data is not on this computer — Settings then shows nothing about it. */
export type ImportList = { found: boolean; dir: string; items: ImportEntry[] }

/** Plugin storage key of the language ('en' | 'ko'), shared by the panel atom and the worker. */
export const LANG_KEY = 'lang'

declare module 'orca' {
  interface PluginRequests {
    /** Every schedule (also wakes the worker). */
    'schedules.list': { output: Schedule[] }
    /** Create or edit. Bad fields → invalid_params. */
    'schedules.save': { input: ScheduleDraft; output: Schedule }
    'schedules.delete': { input: { id: string }; output: { ok: true } }
    'schedules.toggle': { input: { id: string; enabled: boolean }; output: Schedule }
    /** Send now regardless of the time (once the terminal is idle). */
    'schedules.runNow': { input: { id: string }; output: Schedule }
    /** Put a just-deleted schedule back (Undo). */
    'schedules.restore': { input: { schedule: Schedule }; output: Schedule }
    /** Agent terminals open in Orca, across workspaces. */
    'terminals.list': { output: TerminalOption[] }
    /** Bring Orca to that terminal's tab (`orca terminal switch`). */
    'terminals.focus': { input: { handle: string }; output: { ok: boolean } }
    'runner.status': { output: RunnerStatus }
    /** What OrcaCron has to bring over. */
    'orcacron.list': { output: ImportList }
    /** Copy those over, switched off; ones already here or not importable are passed by. */
    'orcacron.import': { input: { ids: string[] }; output: { added: number } }
  }
  interface PluginPanelEvents {
    'schedules.changed': { schedules: Schedule[] }
    /** The agent terminals, pushed when the list changes (checked every 30 s). */
    'terminals.changed': { terminals: TerminalOption[] }
  }
}
