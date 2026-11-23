/** Two-digit zero padding for clock, date and duration text. */
export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The message of a caught value. Host and CLI errors are read as Errors, as they always were. */
export const messageOf = (error: unknown): string => (error as Error).message

/** About how wide a text is drawn, in Latin letters: Hangul, kana and CJK take about two. */
export const drawnLength = (text: string): number => [...text].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)

const BREAK = '\u200b'

/** Text a person or an agent wrote, with places to break inside a long run of letters — an id, a path,
 *  a name with no spaces. Unbroken, one such run pushed its card wider than the panel and the whole
 *  panel scrolled sideways (a 304 px panel, 2026-11-17). */
export const soft = (text: string): string => text.replace(/([^\s\u200b]{16})(?=[^\s\u200b])/g, `$1${BREAK}`)

/** A link as it is drawn. The site — what a person reads to know where the link leads — is the link,
 *  whole; the start of the path follows as text, with a place to break after each separator. Orca draws
 *  a link as a button, which centres its text once it wraps, so the long part stays outside it. */
export function linkParts(url: string): { site: string; path: string } {
  const bare = url.replace(/^https?:\/\//i, '')
  const site = bare.split(/[/?#]/, 1)[0]
  const rest = bare.slice(site.length)
  const path = rest.length > 40 ? `${rest.slice(0, 39)}…` : rest
  return { site: soft(site), path: soft(path.replace(/([/?#&=._-])(?=.)/g, `$1${BREAK}`)) }
}
