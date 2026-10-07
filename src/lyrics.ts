import { fetchWithTimeout } from './spotify'

// Lyrics come from LRCLIB (lrclib.net), a free community database of
// time-synced lyrics. Spotify's own lyrics aren't in its public API.

const API = 'https://lrclib.net/api'
// LRCLIB asks apps to identify themselves; browsers can't set User-Agent, so it accepts this header.
const CLIENT = 'NowPlaying for Even G2 (v0.4)'

export interface LyricLine { ms: number; text: string }
export type Lyrics =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain' }          // words exist but aren't timed, so they can't follow the song
  | { kind: 'instrumental' }
  | { kind: 'none' }

export interface SongInfo { uri: string; title: string; artist: string; album: string; durationMs: number }

const cache = new Map<string, Promise<Lyrics>>()
const CACHE_MAX = 60

/** Lyrics for a song, looked up once and cached. Rejects on network errors (so they're retried). */
export function getLyrics(song: SongInfo): Promise<Lyrics> {
  const hit = cache.get(song.uri)
  if (hit) return hit
  const lookup = findLyrics(song).catch(e => {
    cache.delete(song.uri)   // don't remember a failure caused by a bad connection
    throw e
  })
  cache.set(song.uri, lookup)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return lookup
}

async function request(path: string, params: Record<string, string>): Promise<any | null> {
  const res = await fetchWithTimeout(`${API}${path}?${new URLSearchParams(params)}`, { headers: { 'Lrclib-Client': CLIENT } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`lyrics ${res.status}`)
  return res.json()
}

async function findLyrics(song: SongInfo): Promise<Lyrics> {
  const duration = Math.round(song.durationMs / 1000)

  // 1. Exact match on title, artist, album and length (LRCLIB allows +-2 s).
  const exact = await request('/get', {
    track_name: song.title,
    artist_name: song.artist,
    ...(song.album ? { album_name: song.album } : {}),
    ...(duration ? { duration: String(duration) } : {}),
  })
  if (exact) return toLyrics(exact)

  // 2. Search with Spotify's extras stripped ("- Remastered 2011", "(feat. X)"),
  //    keeping only results within 3 s of the song's length.
  const results: any[] = (await request('/search', { track_name: simplifyTitle(song.title), artist_name: song.artist })) ?? []
  const close = results.filter(r => !duration || !r.duration || Math.abs(r.duration - duration) <= 3)
  const best = close.find(r => r.syncedLyrics) ?? close.find(r => r.instrumental) ?? close.find(r => r.plainLyrics)
  return best ? toLyrics(best) : { kind: 'none' }
}

function toLyrics(r: any): Lyrics {
  if (r.syncedLyrics) {
    const lines = parseSynced(r.syncedLyrics)
    if (lines.length) return { kind: 'synced', lines }
  }
  if (r.instrumental) return { kind: 'instrumental' }
  if (r.plainLyrics) return { kind: 'plain' }
  return { kind: 'none' }
}

/** "Song - Remastered 2011 (feat. X)" -> "Song", with curly quotes made straight. */
export function simplifyTitle(title: string): string {
  return title
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s*[‐-―-]\s+.*$/, '')        // " - Remastered", " - Live at ..."
    .replace(/\s*[([](feat\.?|ft\.?|with|from)\b[^)\]]*[)\]]/gi, '')
    .trim() || title
}

/** Parses LRC text ("[01:23.45] words"); a line may carry several timestamps. */
export function parseSynced(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!stamps.length) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const [, min, sec] of stamps) {
      lines.push({ ms: Math.round((Number(min) * 60 + Number(sec.replace(':', '.'))) * 1000), text })
    }
  }
  return lines.sort((a, b) => a.ms - b.ms)
}

/** Index of the line being sung at `ms`, or -1 before the first line. */
export function lineAt(lines: LyricLine[], ms: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].ms <= ms) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}
