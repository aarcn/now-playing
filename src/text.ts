// The G2 firmware font silently skips characters it doesn't have (emoji, curly
// quotes, en dashes, the ellipsis…), so everything shown on the glasses goes
// through `glassesText` first. Glyph coverage per github.com/nickustinov/even-g2-notes.

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[‹«]/g, '<'],
  [/[›»]/g, '>'],
  [/[  -   ]/g, ' '],
  [/•/g, '·'],
]

// Emoji, pictographs, dingbats, misc technical, variation selectors, ZWJ, flags.
const UNSUPPORTED = /[\p{Extended_Pictographic}⌀-⏿✀-➿︀-️​-‍\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}]/gu

// Extended_Pictographic also matches a few symbols the font does have; keep those.
const SUPPORTED_SYMBOLS = new Set('\u00A9\u00AE\u2122\u2194\u2195\u2196\u2197\u2198\u2199\u2605\u2606\u2609\u260E\u260F\u261C\u261E\u2660\u2661\u2663\u2664\u2665\u2667')

export function glassesText(input: string): string {
  let s = input
  for (const [pattern, replacement] of REPLACEMENTS) s = s.replace(pattern, replacement)
  s = s.replace(UNSUPPORTED, ch => (SUPPORTED_SYMBOLS.has(ch) ? ch : ''))
  return s.replace(/\s+/g, ' ').trim()
}

// Fullwidth characters (CJK, Hangul, fullwidth forms) take about two Latin widths.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u

/** Approximate on-screen width in Latin characters. */
export function width(s: string): number {
  let w = 0
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1
  return w
}

/** Cleans, then shortens to `max` character widths and `maxBytes` UTF-8 bytes, ending in "...". */
export function clip(input: string, max: number, maxBytes = Infinity): string {
  let s = glassesText(input)
  const fits = (t: string) => width(t) <= max && new TextEncoder().encode(t).length <= maxBytes
  if (fits(s)) return s
  while (s.length && !fits(s + '...')) s = Array.from(s).slice(0, -1).join('')
  return s.trimEnd() + '...'
}

/**
 * Rough rendered width in pixels in the glasses' proportional font. Character
 * widths were measured from simulator screenshots (dev/calibrate.html); the
 * estimate runs a few percent wide so a line never wraps.
 */
export function approxPx(s: string): number {
  let w = 0
  for (const ch of s) {
    if (WIDE.test(ch)) w += 24
    else if (ch === '\u25B6') w += 23                  // play icon
    else if (ch === '\u2665' || ch === '\u2661') w += 20 // hearts
    else if (/[MWmw@%]/.test(ch)) w += 16
    else if (/[A-Z]/.test(ch)) w += /[IJ]/.test(ch) ? 6 : 12
    else if (/[0-9]/.test(ch)) w += 11.5
    else if (/[ijl.,:;'!|\u00B7]/.test(ch)) w += 5
    else if (/[frt]/.test(ch)) w += 7
    else if (ch === ' ') w += 5.3
    else if (/[-"()\[\]\/]/.test(ch)) w += 8
    else w += 10.3
  }
  return Math.ceil(w)
}

/** Like `clip`, but by estimated pixel width: use it for lines that must not wrap. */
export function clipPx(input: string, maxPx: number): string {
  let s = glassesText(input)
  if (approxPx(s) <= maxPx) return s
  while (s.length && approxPx(s + '...') > maxPx) s = Array.from(s).slice(0, -1).join('')
  return s.trimEnd() + '...'
}

/** A cleaned label, with a fallback when nothing printable is left (e.g. an all-emoji name). */
export function label(input: string | null | undefined, fallback: string, max = 42): string {
  const s = clip(input ?? '', max, 63)
  return s || fallback
}

export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
