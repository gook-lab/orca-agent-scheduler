// A run's result, read off the terminal screen. The prompt ends with an ask for one last line in a set
// form; when the agent stops, the worker finds that line on the screen it already reads. The agent only
// prints text — it runs and writes nothing for this — so no permission dialog can come of it, and nothing
// here depends on which agent it is (checked live on Claude Code and Codex).
import type { Status } from './i18n'

export type Report = { status: Status; summary: string; link?: string }

/** A run's tag, from the time it was sent — so a line an earlier run left on screen is not taken for this one. */
export const reportToken = (sentAt: number): string => (sentAt % 36 ** 4).toString(36).padStart(4, '0')

/** The form the agent is asked for. `STATUS` and the placeholder words are not a result: only ok ·
 *  failed · skipped is read, so the prompt echoed on screen never counts. */
export const reportForm = (token: string, summary: string): string => `[result ${token} STATUS] ${summary} [link] URL [end]`

const statusOf: Record<string, Status> = { ok: 'success', failed: 'failed', skipped: 'skipped' }

export const SUMMARY_MAX = 300
const LINK_MAX = 2000
/** How far after `[result …]` its `[end]` is looked for — room for the longest summary and link kept. */
const LINE_MAX = 4000
/** Only web links — the panel opens them in the browser. No `user@` before the site: the panel shows
 *  the start of the address, and `https://known.site@other.site/` reads as one site and leads to another. */
const webLink = /^https?:\/\/[^\s<>"'`\\/?#@]+(?:[/?#][^\s<>"'`\\]*)?$/i

export const isWebLink = (link: string): boolean => link.length <= LINK_MAX && webLink.test(link)

/**
 * The newest `[result <token> ok|failed|skipped] summary [link] URL [end]` on screen, or null.
 * The agent's text is wrapped to the terminal's width, so the lines are joined first: a summary broken
 * at a space reads the same with one space, and a link — which has no spaces — gets its pieces back
 * together by dropping them. A line that never reaches its `[end]` is passed by, and cannot take in the
 * line after it.
 */
export function readReport(lines: string[], token: string): Report | null {
  if (!/^[0-9a-z]{4}$/.test(token)) return null
  const text = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
  const opening = new RegExp(`\\[result\\s+${token}\\s+(ok|failed|skipped)\\]`, 'g')
  let found: { status: string; body: string } | null = null
  for (let m = opening.exec(text); m; m = opening.exec(text)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + LINE_MAX)
    const end = rest.indexOf('[end]')
    const next = rest.indexOf('[result ')
    if (end >= 0 && (next < 0 || end < next)) found = { status: m[1], body: rest.slice(0, end) }
  }
  if (!found) return null
  const cut = found.body.indexOf('[link]')
  const summary = (cut < 0 ? found.body : found.body.slice(0, cut)).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
  const after = cut < 0 ? '' : found.body.slice(cut + '[link]'.length).replace(/\s+/g, '')
  // Claude Code draws a mark (⧉) before a link — the address starts where its scheme does.
  const link = after.slice(Math.max(0, after.search(/https?:\/\//i)))
  return {
    status: statusOf[found.status],
    summary,
    ...(isWebLink(link) ? { link } : {})
  }
}
