# Agent Scheduler — Orca plugin

Sends a prompt to a Claude Code, Codex or Gemini CLI terminal in Orca at set times. It waits until that terminal is idle, sends through the Orca CLI, and records when the agent finishes. The plugin grew out of the menubar app [OrcaCron](https://github.com/gook-lab/orca-cron) and keeps its own schedules; the two do not share data.

The panel follows Orca's language: Korean when Orca is in Korean, English otherwise. Settings (the gear at the top) can fix it to English or Korean; the status bar and notifications follow.

## Target — a terminal you pick

A schedule belongs to one terminal you already have open, in any workspace. The terminal list in the form shows only terminals where Orca sees an agent running: the terminal title, then the workspace and the agent. A plain shell is never offered and never sent to. Opened from a terminal line, Edit or Duplicate, the form shows that terminal on one line with **Change**; the list opens only when you press it, and folds again once you pick.

- Orca restarts give terminals new handles. The schedule finds its terminal again by its pane. A terminal that was closed shows as `not open`; the run waits, and you pick another terminal by editing the schedule.
- **Start a new conversation** sends `/clear` first, then the prompt once the screen settles. Turn it on only for a terminal kept for that schedule — `/clear` erases the conversation in it.

## Sending — idle check, then the Orca CLI

At the set time the run becomes due and is checked every 30 seconds. The prompt goes out only when all of these hold:

| Check | Why |
|---|---|
| The screen has been quiet for a minute | The agent or a person may still be working |
| Orca does not report the agent as working | A working report older than 3 minutes is ignored, in case its end was missed |
| The input box is visible and empty | A permission or question dialog is open, or a person is typing |
| No other schedule sent to this terminal in the same check | Two prompts would land in one turn |

A run that waits more than 60 minutes is skipped, with the reason it was waiting.

Sending uses `orca terminal send --terminal <handle> --text <prompt> --enter --wait-submit 8`, run from the CLI inside the running Orca app (`<Orca app>/Contents/Resources/bin/orca`; the `orca` on PATH can belong to another copy). The plugin API is not used for this because of limits measured on Orca 1.4.255:

| Plugin API | Measured | So |
|---|---|---|
| `terminal.sendText` | Allowed only for terminals in the workspace on screen (`terminal is outside the active worktree`) | Send with the CLI, which reaches every workspace |
| `terminal.read` | Returns no error for a closed terminal | Tell open from closed by the CLI's terminal list |

## End detection — agent status, then the screen

- After sending, Orca's agent status events decide the end: working → done or waiting. An outcome the agent reports becomes Succeeded, Failed or Stopped; without one the run is Done, with the time it took. Waiting for input becomes Done (awaiting input), with a notification.
- A done or waiting event while a permission or question dialog is on screen does not end the run. The card shows that a person must answer, and a notification goes out once.
- If the events are missed, the screen decides: quiet for 3 minutes with an empty input box is Done. Quiet with no input box, or with text left in it, is flagged on the card and in the status bar until the screen moves again.
- A terminal closed mid-run is Stopped; a run with no end after 6 hours is No result.

## Schedule — days, times, calendar, cron

| Field | Choices |
|---|---|
| Days | Every day · Weekdays · Weekends · Pick days (Monday first) · Dates on a calendar (up to 12 months ahead) · Cron |
| Time | Set times (up to 24) or every N minutes (1–720), all day or between two times |
| Cron | Five fields, or six with a year; several expressions joined by `;` |

The form shows a summary of what it will do (for example `Weekdays 09:00–18:00, every 30 min`). Create stays off until the form is complete, with the first missing field named above it (name, terminal, time, prompt). After saving, the panel shows the Schedules tab with that terminal's block open. A schedule saved as cron that the form can express reopens in the form.

## Screens — side panel laid out like Orca's own sidebars

The calendar icon in the right sidebar opens the **Agent Scheduler** panel. It is laid out like Orca's file explorer: a title row with icon buttons, tabs, a search box, then the list.

| Part | What it shows and does |
|---|---|
| Title row | **Agent Scheduler**, then New schedule (+), Send once (›), Reload terminals and Settings |
| Tabs and search | **Schedules N** and **Terminals N**. The search box under them filters both, by terminal title, workspace, agent or schedule name |
| Schedules | What runs next, then counts: schedules, on, waiting, running, need attention, runs today. Below that, one block per terminal |
| Terminal line | Agent icon (Claude Code ★, Codex `>_`, Gemini CLI ⚡), a green dot while the terminal is open, workspace and title. Pressing the workspace or the icon brings Orca to that terminal (`orca terminal switch`). Then **Send once** and **New schedule for this terminal**. A block folds to one line: `2 schedules · next tomorrow 09:00` |
| Schedule in a block | Switch with the name; next run and the rule, then send now, edit, duplicate, delete (Undo for 8 seconds); last result and the history. A run waiting its turn shows why in grey; an orange warning appears only when a person must act (the same ones counted on top and in the status bar) |
| Sent records | One-off sends sit folded under their terminal as `Sent N · last today 12:03`; the newest 20 finished ones are kept |
| Terminals | Every open agent terminal, each on the same line as above |
| Settings | Language (same as Orca, English or Korean) and how sending works |

A closed terminal keeps its block, greyed out, with its last known agent; its schedules wait until it is open again or you pick another terminal in Edit.

The status bar shows the next run, and turns orange with a count when a schedule needs attention (terminal not open, no agent, a dialog, text in the input box, the CLI missing).

## Send once — one prompt now

**Send once** (› in the title row, or on a terminal line) opens the same form without days or times. The prompt goes out under the same idle check as a schedule, the name may stay empty (the first line of the prompt is used), and the result stays as a sent record under the terminal.

## Permissions — screen, status, CLI

| Permission | Used for |
|---|---|
| `terminal:read` | Reading the chosen terminal's screen for the idle check, dialogs and the end |
| `agent:read` | Agent status events for the end |
| `workspace:read` | Workspace names in the terminal menu |
| `storage:own` | Schedules and the language setting |
| `notifications:show` | Answers needed, failures |

Sending, showing a terminal and the terminal list go through the Orca CLI, so they do not appear as permissions. The worker runs as a trusted Node process under your account, as the approval text says, which is what lets it run the CLI.

## Development — orca plugin test · check

```bash
ORCA="/Applications/Orca.app/Contents/Resources/bin/orca"   # the CLI of the Orca app you run
$ORCA plugin test .                # tests: schedule maths, screen checks, engine, worker, panel
$ORCA plugin check . --json        # draws the panel once per scenario
npx -p typescript tsc -p . --noEmit
$ORCA plugin dev watch . --check   # load into Orca, reload on each edit (a new permission needs a new approval)
```
