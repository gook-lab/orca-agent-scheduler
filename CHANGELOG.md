# Changelog

Versions are tags (`vX.Y.Z`); `orca plugin update gook-lab.agent-scheduler` moves to the newest one.

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
