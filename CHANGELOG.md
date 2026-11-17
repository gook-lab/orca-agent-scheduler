# Changelog

Versions are tags (`vX.Y.Z`); `orca plugin update gook-lab.agent-scheduler` moves to the newest one. Each version's notes are also a [release](https://github.com/gook-lab/orca-agent-scheduler/releases), with a summary in Korean.

## 0.12.1 — 2026-11-17

The card from 0.12.0, tidied — on the real panel it looked off in three places.

- **Every line of a card starts at the same edge.** The name and the next run began beside the round mark while the last result began under it, at the card's left, so the mark looked like it floated on its own. The last result is now the third line of the same column.
- **A schedule that has not run yet is two lines.** Its card kept a line that held nothing but the two buttons. Send now (▷) and open (⌄) sit beside the next run again, as they did before 0.12.0.
- **A grey mark is a circle again.** A neutral fill is the card's own colour, so "not run yet", "waiting to send" and "off" showed a glyph with no circle around it. They have a line around them now, and off is an empty circle — the `Off` under the name says the rest.
- Cards are lower: about 74 px folded (90 in 0.12.0) and 58 px for a schedule that has not run yet (90) — lower than in 0.11.2 too (91 and 65). At 280 px the next run wraps to a second line beside the buttons, and a name that broke in two fits on one. Checked on the real panel at 280 and 457 px, and in both themes with the scenarios.

## 0.12.0 — 2026-11-17

The schedule card, redrawn, and five ways a check could go wrong, closed.

- **A card is a filled surface with a line around it and a round mark at its left.** The mark is for a glance down the list: what is going on now — running ▸, a person must act !, waiting to send … — else how the last run went — ✓ ✕ – ? — and ○ when the schedule is off. The name and its switch sit beside it with the next run under them. Folded, the last result is a word in the mark's colour (`Succeeded today 16:51 · took 3 min`) instead of a badge that said the same thing twice; opened, the badge is back with what the agent wrote. All colours come from Orca's theme, and the line stays because a light theme gives the card surface the panel's own colour — without it nothing showed where a card ends. Checked on the real panel at 280 and 457 px in the dark theme, and in both themes with the scenarios.
- **A send that throws is not sent again.** When the CLI call itself failed in a way nobody saw the end of, the run stayed "waiting to send" and the next check typed the prompt a second time. It is now recorded as Failed, once.
- **One schedule that throws no longer ends the check.** The schedules after it were skipped without a word in the log. It is logged (`<name>: check failed — …`) and tried again; the others go out. A terminal list in a shape this version does not know, or one that throws, is a wait like a missing CLI.
- **An edit storage refuses is undone.** The form said it could not save while the worker kept the schedule in memory, and never wrote it — so it came back later, and a second press of Create added a second copy. Now the edit is rolled back, and a write that fails after a send is tried again with the next check.
- **A schedule whose run is going keeps its terminal.** Its end is read off the terminal it was sent to; moved meanwhile, the run was closed by whatever the other terminal's agent was doing. The form says `Its run is still going — change the terminal once it has ended`; everything else can be edited. A schedule moved while it waits types its `/clear` into the new terminal.
- **Checks do not pile up behind a hung CLI call.** One runs and at most one waits; before, the 30-second timer stacked them and every panel edit waited behind them all.
- A save from something other than the panel with a missing or mistyped field is refused with the form's wording instead of a TypeError. Stored schedules that cannot be read are counted in the log when the worker starts.

## 0.11.2 — 2026-11-17

- **The counts on top are a line of words**: `4 of 4 on · 2 runs today`. They were pills (`4 schedules`, `4 on`, `2 runs today`) that looked like filters and did nothing when pressed, and `4 schedules` repeated the tab's own count. Badges are left for what is out of the ordinary — waiting, running, need attention — and show only then.

## 0.11.1 — 2026-11-17

- **The favorite star shows that it is on.** It was the same outline star either way: Orca's ghost buttons ignore their tone, so the accent meant to mark a favorite never showed, and with a single terminal block there was no order to change either — a press looked like it did nothing. It is now ☆ when off and ★ when on.

## 0.11.0 — 2026-11-17

The schedule card, redone for a glance.

- **A card is folded until it is opened.** Folded, it shows the name with its switch, the next run with the time left (`next today 19:13 · in 2h 33m`), and how the last run went — status, when, how long. Two buttons instead of four: send now (▷) and open (⌄).
- **Opened in place** (⌄): what the agent wrote and its link, how the run's end was seen, the rule (with `/clear` when it clears first), the start of the prompt, then **Edit**, **Duplicate** and **Delete** as named buttons, and the history. Orca's panel kit has no menu that pops up, so the card opens instead. Folding a card drops its delete question.
- **How sending works** moved from under the list to Settings, with **What's new** beside *Show the introduction again*. The list holds schedules only.
- The title row's four buttons stay in one row on a very narrow panel — at 280 px with a scrollbar they broke in two; the title gives way instead.

Checked on the real panel at 280 and 457 px, folded and opened.

## 0.10.3 — 2026-11-17

- **A long address no longer pushes the card out of the panel.** A result link has no spaces, so on a narrow panel it ran past the card's edge and the whole panel scrolled sideways (a 304 px panel, a 41-letter address). The site is now the link, and the path follows it as text that breaks after each `/`, `.`, `-`, `?`, `&`, `=`.
- The same for anything a person or an agent wrote — a schedule's name, a summary, the reason in a note, an imported name: a run of 16 letters without a space gets a place to break. Checked on the real panel at 280, 304 and 457 px.

## 0.10.2 — 2026-11-17

From a day of real use: two runs on a long-lived Claude Code terminal ended late and without their results.

- **A result line ends the run.** The first check that sees the run's line takes it and ends the run. Before, the line was read only once the run had ended some other way — on that terminal no end event came, so the run waited for a quiet screen while its line sat there, and on a small pane later output can push the line off first.
- **A result line that comes after the end is still taken**, for 60 minutes. An agent that ends its turn to wait for its own background command writes the line when the command is done; by then the run was recorded as `Done · No result line on screen`. The record now takes the line's status, summary and link, and a late Failed is notified.
- **Quiet means nothing new on screen.** An idle Claude Code repaints its status line every few seconds to minutes: the terminal's last-output time kept moving while the text stayed the same (measured: 7 moves in 4 minutes, no change in the text). "Quiet for a minute" before sending and "quiet for 3 minutes" for an end by screen were met only by chance — one run stayed Running for 17 minutes after its agent had stopped, and another waited to send behind `the screen moved within a minute`. Text unchanged since an earlier check now counts as quiet.
- A link that Claude Code draws with its mark (`⧉ https://…`) is read; it was dropped.
- The log says how each run ended: `(agent done)`, `(result line)` or `(by screen)`.
- Korean: a note with its reason reads `화면 기준 · 화면에 결과 줄이 없음` — the two parts ran together.

## 0.10.1 — 2026-11-17

- **Send now is one run at a time.** The ▷ on a schedule is off while that schedule waits to send or its run is going, and when its terminal is closed; the tooltip says which. Pressed twice, it used to queue a second send behind the first.
- A schedule waiting to send shows a grey **Waiting to send** badge from the press on. Before, the card showed nothing until the first check gave a reason.
- A warning comes with the way out: **Pick a terminal** when the terminal is gone, **Show this terminal in Orca** when a dialog, unsent text or a missing agent is in the way.
- A schedule that is on while its terminal is closed says so in orange (it was grey), with **Pick a terminal**.
- Deleting a schedule asks first, in the card, and says how many past results go with it. Undo stays.
- `orca plugin check` draws one more scene, `stuck`.

## 0.10.0 — 2026-11-17

- **Ask for a one-line result.** A schedule can ask the agent to end its reply with `[result <tag> ok|failed|skipped] summary [link] URL [end]`. When the run ends the worker reads that line off the terminal screen, and the record shows Succeeded, Failed or Skipped with the summary and the link. The agent only prints text, so nothing new needs permission. On by default for a new schedule, off for Send once and for schedules saved before; a prompt that starts with `/` never gets the sentence. README "Result".
- A failure notification carries the summary the agent gave.
- **What's new** under *How sending works* opens the release notes — what each version changed.
- `orca plugin check` draws one more scene, `result`.
- Settings can copy schedules over from the OrcaCron menubar app, switched off, on a computer that has that app's schedules. README "Import from OrcaCron".

Fixed

- A prompt that starts with `--` was read by the Orca CLI as a flag and never sent (`Unknown flag`, or the CLI's help for `--help`). The text now goes as `--text=<prompt>`.
- A second schedule could send into a terminal while another schedule's run there was still going, and both were then closed by the same reply. It now waits for that run to end.
- A date more than 400 days ahead — a picked date in a later year, or 29 February — was saved as "never runs again". The search now runs to the rule's last year, or eight years.
- One stored schedule that could not be read (a number where the times go, an empty history entry) stopped every schedule, or the worker itself. Storage is now read field by field.
- A one-off send did not show its result — the note, how long it took, the summary and link were recorded but not drawn.
- A run that stopped at a question was green like a finished one; it is orange now.
- Searching did not open a folded block, so a found schedule stayed out of sight.
- History counted 30 records and showed 10; it shows all it counts.

Changed

- A run asked for a result that ends without the line says `No result line on screen` in its record.
- The 6-hour status reads **Timed out** (was "No result", which now means something else).
- The form says which clock the times are on (`Asia/Seoul, UTC+9`), and takes `9:30 pm` as well as `21:30`.
- Result links with a name before the site (`user@site`) are dropped, and a link shows its site in full.
- Korean: 휴일 → 주말 for Saturday and Sunday.

## 0.9.13 — 2026-11-17

- A result line wraps instead of being cut to one line. At 360px a late run's record lost how long it took (`… sent 3 h 12 min late · took 4 …`); past results under a schedule wrap the same way.

## 0.9.12 — 2026-11-17

- The plugin page gets two screenshots: a late catch-up on the Schedules tab, and the panel in Korean. No change in behaviour.
- `orca plugin check` draws the scene `late`, and `korean` now shows the usual day rather than the no-CLI warnings.

## 0.9.11 — 2026-11-17

- The plugin page gets an icon and a cover picture. No change in behaviour.

## 0.9.10 — 2026-11-17

- README shows the panel: the Schedules tab and the introduction. No change in behaviour.
- `orca plugin check` draws one more scene, `open` — every terminal open, one run going, one waiting.

## 0.9.9 — 2026-11-17

- A run that went out after its time had passed unchecked (the computer asleep, Orca closed) says so: its record reads `sent 6 h 2 min late`, and a notification goes out when it is sent. Sending itself is unchanged — such a run was already caught up once.

## 0.9.8 — 2026-11-17

- When the worker finds no Orca CLI (Windows and Linux for now), the Terminals tab and the form's terminal picker say `Orca CLI not found` instead of asking you to run an agent that could never show up.
- README and the catalog description say the plugin is macOS only for now.

## 0.9.7 — 2026-11-17

First public release (`gook-lab.agent-scheduler`).

- One-off sends still waiting are counted apart from those sent: `Waiting to send 1 · Sent 2`. A send stuck on a closed terminal no longer reads as sent.
- While the lists are being read the tabs carry no number, rather than a 0 that reads as none.

## 0.9.0 – 0.9.6 — 2026-11-13

- A terminal whose agent mark blinks out for a second or two stays in the list and the form (kept for two checks).
- Entering the Terminals tab reads the list afresh. A search that hides everything offers Clear search. A saved schedule is tinted for a few seconds.
- A new one-off send opens its terminal's sent group. With no agent terminal open, the panel says how to get one, with a reload.
- `/clear` first (Start a new conversation) is for schedules only, not one-off sends.
- The next run counts down every second, a run being sent spins, and both tabs show a placeholder until the first answer.
- Settings and the form share the title row (title and ×) with a line under it. Form spacing by group.

## 0.4.0 – 0.8.0 — 2026-11-13

- Sends to a terminal you pick instead of launching a new agent; English by default, Korean when Orca is in Korean.
- Laid out like Orca's own sidebars: title row with icon buttons, tabs, search.
- Form flow: the chosen terminal on one line, why Create is off, back to the result after saving; orange only when a person must act.
- Favorites, agent marks, a three-page introduction on first open, and how sending works under the list.
