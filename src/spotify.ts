import { getAccessToken, invalidateAccessToken } from './auth'

const API = 'https://api.spotify.com/v1'
const TIMEOUT_MS = 10_000

/** fetch that gives up after TIMEOUT_MS, so a dead connection can't hang the app. */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Errors ----------

export class SpotifyError extends Error {
  constructor(public status: number, public reason: string, message: string, public retryAfterSec = 0) {
    super(message)
  }
}

/** Turns Spotify's error into something readable on a 576px display. */
function friendly(status: number, reason: string, message: string): string {
  if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message)) return 'Spotify Premium is required'
  if (reason === 'VOLUME_CONTROL_DISALLOW') return 'This device doesn\'t allow volume control'
  if (/not registered/i.test(message)) return 'Add this account in your Spotify app\'s Users'
  if (reason === 'NO_ACTIVE_DEVICE') return 'No active device. Open Spotify somewhere'
  if (status === 403 && /scope/i.test(message)) return 'Reconnect Spotify on your phone for this'
  if (status === 403 && /restriction/i.test(message)) return 'Spotify doesn\'t allow that right now'
  if (status === 403) return 'Spotify refused that'
  if (status === 404 && /device/i.test(message)) return 'That device isn\'t available anymore'
  if (status === 404) return 'Not found on Spotify'
  if (status === 429) return 'Spotify is busy, slowing down'
  if (status >= 500) return 'Spotify is having trouble'
  return message || `Spotify error ${status}`
}

// When Spotify rate-limits us, every call waits out Retry-After instead of hammering.
let blockedUntil = 0
export const rateLimitedFor = () => Math.max(0, blockedUntil - Date.now())

async function call<T = any>(method: string, path: string, body?: unknown, attempt = 0): Promise<T | null> {
  if (Date.now() < blockedUntil) {
    throw new SpotifyError(429, 'RATE_LIMITED', friendly(429, '', ''), Math.ceil(rateLimitedFor() / 1000))
  }

  const token = await getAccessToken()   // throws NotLoggedIn
  let res: Response
  try {
    res = await fetchWithTimeout(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')
    throw new SpotifyError(0, 'OFFLINE', timedOut ? 'Spotify took too long to answer' : 'No connection')
  }

  if (res.status === 401 && attempt === 0) {
    invalidateAccessToken()
    return call(method, path, body, attempt + 1)
  }
  if (res.status >= 500 && method === 'GET' && attempt === 0) {
    await new Promise(r => setTimeout(r, 600))
    return call(method, path, body, attempt + 1)
  }

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON body (e.g. a 502 page) */ }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 5
    blockedUntil = Date.now() + retryAfter * 1000
    throw new SpotifyError(429, data?.error?.reason ?? 'RATE_LIMITED', friendly(429, '', ''), retryAfter)
  }
  if (!res.ok) {
    const reason = data?.error?.reason ?? ''
    const message = data?.error?.message ?? ''
    throw new SpotifyError(res.status, reason, friendly(res.status, reason, message))
  }
  return data
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
  return entries.length ? '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])) : ''
}

// ---------- Player ----------

export type Repeat = 'off' | 'context' | 'track'

export interface PlayerState {
  kind: 'track' | 'episode' | 'ad' | 'unknown'
  uri: string
  title: string
  artist: { name: string; uri: string } | null   // first artist, or the show for episodes
  artists: string
  album: { name: string; uri: string } | null
  contextUri: string
  isPlaying: boolean
  progressMs: number
  durationMs: number
  shuffle: boolean
  repeat: Repeat
  device: Device | null
  artUrl: string             // '' when there's no cover
}

/** Picks the smallest cover that's still at least `min` px, from Spotify's [640, 300, 64] list. */
function pickImage(images: { url: string; width?: number | null }[] | undefined, min = 144): string {
  if (!images?.length) return ''
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return (sorted.find(i => (i.width ?? 0) >= min) ?? sorted[sorted.length - 1]).url
}

export interface Device {
  id: string
  name: string
  type: string
  isActive: boolean
  volume: number | null       // null when the device doesn't allow remote volume (e.g. iPhone)
  restricted: boolean
}

const toDevice = (d: any): Device => ({
  id: d.id,
  name: d.name,
  type: d.type,
  isActive: d.is_active,
  volume: d.supports_volume === false ? null : d.volume_percent ?? null,
  restricted: !!d.is_restricted,
})

/** null when nothing is loaded on any device. */
export async function getPlayer(): Promise<PlayerState | null> {
  const p = await call('GET', '/me/player?additional_types=episode')
  if (!p) return null

  const base = {
    contextUri: p.context?.uri ?? '',
    isPlaying: !!p.is_playing,
    progressMs: p.progress_ms ?? 0,
    shuffle: !!p.shuffle_state,
    repeat: (p.repeat_state ?? 'off') as Repeat,
    device: p.device ? toDevice(p.device) : null,
  }

  const item = p.item
  if (!item) {
    const kind = p.currently_playing_type === 'ad' ? 'ad' : 'unknown'
    if (kind === 'unknown' && !p.device) return null
    return { ...base, kind, uri: '', title: kind === 'ad' ? 'Advertisement' : '', artist: null, artists: '', album: null, durationMs: 0, artUrl: '' }
  }

  if (item.type === 'episode') {
    return {
      ...base,
      kind: 'episode',
      uri: item.uri,
      title: item.name,
      artist: item.show ? { name: item.show.name, uri: item.show.uri } : null,
      artists: item.show?.name ?? '',
      album: null,
      durationMs: item.duration_ms ?? 0,
      artUrl: pickImage(item.images ?? item.show?.images),
    }
  }

  return {
    ...base,
    kind: 'track',
    uri: item.uri,
    title: item.name,
    artist: item.artists?.[0] ? { name: item.artists[0].name, uri: item.artists[0].uri } : null,
    artists: (item.artists ?? []).map((a: any) => a.name).join(', '),
    album: item.album ? { name: item.album.name, uri: item.album.uri } : null,
    durationMs: item.duration_ms ?? 0,
    artUrl: pickImage(item.album?.images),
  }
}

export async function getDevices(): Promise<Device[]> {
  const data = await call('GET', '/me/player/devices')
  return (data?.devices ?? []).map(toDevice)
}

/**
 * Runs a playback command. If Spotify says no device is active, retry on the
 * first available device (e.g. the phone app is open but idle).
 */
async function onDevice(run: (deviceQuery: string) => Promise<unknown>): Promise<void> {
  try {
    await run('')
  } catch (e) {
    if (!(e instanceof SpotifyError) || e.reason !== 'NO_ACTIVE_DEVICE') throw e
    const device = (await getDevices()).find(d => !d.restricted)
    if (!device) throw new SpotifyError(404, 'NO_DEVICE', 'Open Spotify on any device first')
    await run(q({ device_id: device.id }))
  }
}

export const play = () => onDevice(d => call('PUT', `/me/player/play${d}`))
export const pause = () => call('PUT', '/me/player/pause')
export const next = () => call('POST', '/me/player/next')
export const previous = () => call('POST', '/me/player/previous')
export const seek = (ms: number) => call('PUT', `/me/player/seek${q({ position_ms: Math.max(0, Math.round(ms)) })}`)
export const setShuffle = (on: boolean) => onDevice(d => call('PUT', `/me/player/shuffle${q({ state: on })}${d.replace('?', '&')}`))
export const setRepeat = (mode: Repeat) => call('PUT', `/me/player/repeat${q({ state: mode })}`)
export const setVolume = (pct: number) => call('PUT', `/me/player/volume${q({ volume_percent: Math.max(0, Math.min(100, Math.round(pct))) })}`)
export const transferTo = (deviceId: string, startPlaying: boolean) =>
  call('PUT', '/me/player', { device_ids: [deviceId], play: startPlaying })
export const addToQueue = (uri: string) => onDevice(d => call('POST', `/me/player/queue${q({ uri })}${d.replace('?', '&')}`))

export type Offset = { position: number } | { uri: string }

export const playContext = (contextUri: string, offset?: Offset) =>
  onDevice(d => call('PUT', `/me/player/play${d}`, { context_uri: contextUri, ...(offset ? { offset } : {}) }))

export const playUris = (uris: string[], offset?: Offset, positionMs?: number) =>
  onDevice(d => call('PUT', `/me/player/play${d}`, {
    uris,
    ...(offset ? { offset } : {}),
    ...(positionMs ? { position_ms: Math.round(positionMs) } : {}),
  }))

/** Turn shuffle on and start a context at a random spot, so the first song is random too. */
export async function shufflePlay(contextUri: string, total?: number): Promise<void> {
  await setShuffle(true)
  const offset = total && total > 1 ? { position: Math.floor(Math.random() * total) } : undefined
  await playContext(contextUri, offset)
}

export interface QueueItem { uri: string; title: string; subtitle: string }

export async function getQueue(): Promise<QueueItem[]> {
  const data = await call('GET', '/me/player/queue')
  return (data?.queue ?? []).filter(Boolean).map((i: any) => ({
    uri: i.uri,
    title: i.name,
    subtitle: i.type === 'episode' ? i.show?.name ?? '' : (i.artists ?? []).map((a: any) => a.name).join(', '),
  }))
}

// ---------- Saving ----------

export async function isSaved(uri: string): Promise<boolean> {
  const data = await call<boolean[]>('GET', `/me/library/contains${q({ uris: uri })}`)
  return !!data?.[0]
}

export const setSaved = (uri: string, saved: boolean) =>
  call(saved ? 'PUT' : 'DELETE', `/me/library${q({ uris: uri })}`)

// ---------- Library ----------

export interface Page<T> {
  items: T[]
  offset: number                  // position of items[0] in the full list
  total?: number
  next?: () => Promise<Page<T>>   // undefined on the last page
}

/** Wraps an offset-paged endpoint into a Page with a `next` loader. */
function offsetPager<T>(path: (offset: number, limit: number) => string, map: (raw: any) => T | null, limit: number) {
  const load = async (offset: number): Promise<Page<T>> => {
    const data = await call('GET', path(offset, limit))
    const items = (data?.items ?? []).map(map).filter((x: T | null): x is T => x !== null)
    return {
      items,
      offset,
      total: data?.total,
      next: data?.next ? () => load(offset + limit) : undefined,
    }
  }
  return load(0)
}

export interface Track { uri: string; title: string; artists: string; album: { name: string; uri: string } | null; artist: { name: string; uri: string } | null; durationMs: number; playable: boolean }

const toTrack = (t: any): Track | null => t && t.type !== 'episode' ? {
  uri: t.uri,
  title: t.name,
  artists: (t.artists ?? []).map((a: any) => a.name).join(', '),
  artist: t.artists?.[0] ? { name: t.artists[0].name, uri: t.artists[0].uri } : null,
  album: t.album ? { name: t.album.name, uri: t.album.uri } : null,
  durationMs: t.duration_ms ?? 0,
  playable: t.is_playable !== false && !t.is_local,
} : null

let meId: Promise<string> | null = null
const getMeId = () => (meId ??= call('GET', '/me').then(m => m.id).catch(e => { meId = null; throw e }))

export interface Playlist { uri: string; name: string; total?: number; canListTracks: boolean }

export async function getPlaylists(limit: number): Promise<Page<Playlist>> {
  const me = await getMeId()
  return offsetPager(
    (o, l) => `/me/playlists${q({ limit: l, offset: o })}`,
    p => p && {
      uri: p.uri,
      name: p.name,
      total: p.items?.total ?? p.tracks?.total,
      // Spotify only shares the track list of playlists you own or collaborate on.
      canListTracks: p.owner?.id === me || !!p.collaborative,
    },
    limit,
  )
}

export function getPlaylistTracks(playlistId: string, limit: number): Promise<Page<Track>> {
  return offsetPager(
    (o, l) => `/playlists/${playlistId}/items${q({ limit: l, offset: o, additional_types: 'track' })}`,
    // The Feb 2026 API renamed the nested `track` to `item`; accept both.
    entry => toTrack(entry?.item ?? entry?.track),
    limit,
  )
}

export interface Album { uri: string; name: string; artist: string; year: string; total?: number }

const toAlbum = (a: any): Album => ({
  uri: a.uri,
  name: a.name,
  artist: a.artists?.[0]?.name ?? '',
  year: (a.release_date ?? '').slice(0, 4),
  total: a.total_tracks,
})

export function getSavedAlbums(limit: number): Promise<Page<Album>> {
  return offsetPager((o, l) => `/me/albums${q({ limit: l, offset: o })}`, e => e?.album && toAlbum(e.album), limit)
}

export async function getAlbumTracks(albumId: string, limit: number): Promise<Page<Track>> {
  const album = await call('GET', `/albums/${albumId}`)
  const withAlbum = (t: any) => toTrack({ ...t, album: { name: album.name, uri: album.uri } })
  return offsetPager((o, l) => `/albums/${albumId}/tracks${q({ limit: l, offset: o })}`, withAlbum, limit)
}

export interface Artist { uri: string; name: string }

/** Followed artists use cursor paging, not offsets. */
export function getFollowedArtists(limit: number): Promise<Page<Artist>> {
  const load = async (after?: string, offset = 0): Promise<Page<Artist>> => {
    const data = await call('GET', `/me/following${q({ type: 'artist', limit, after })}`)
    const a = data?.artists ?? {}
    const items = (a.items ?? []).map((x: any) => ({ uri: x.uri, name: x.name }))
    return {
      items,
      offset,
      total: a.total,
      next: a.next && a.cursors?.after ? () => load(a.cursors.after, offset + items.length) : undefined,
    }
  }
  return load()
}

export function getArtistAlbums(artistId: string, limit: number): Promise<Page<Album>> {
  return offsetPager(
    (o, l) => `/artists/${artistId}/albums${q({ include_groups: 'album,single,compilation', limit: l, offset: o })}`,
    toAlbum,
    limit,
  )
}

export interface Show { uri: string; name: string }
export interface Episode { uri: string; name: string; date: string; durationMs: number; resumeMs: number; finished: boolean }

export function getSavedShows(limit: number): Promise<Page<Show>> {
  return offsetPager((o, l) => `/me/shows${q({ limit: l, offset: o })}`, e => e?.show && { uri: e.show.uri, name: e.show.name }, limit)
}

export function getShowEpisodes(showId: string, limit: number): Promise<Page<Episode>> {
  return offsetPager(
    (o, l) => `/shows/${showId}/episodes${q({ limit: l, offset: o })}`,
    e => e && {
      uri: e.uri,
      name: e.name,
      date: e.release_date ?? '',
      durationMs: e.duration_ms ?? 0,
      resumeMs: e.resume_point?.resume_position_ms ?? 0,
      finished: !!e.resume_point?.fully_played,
    },
    limit,
  )
}

export function getLikedTracks(limit: number, startOffset = 0): Promise<Page<Track>> {
  const load = async (offset: number): Promise<Page<Track>> => {
    const data = await call('GET', `/me/tracks${q({ limit, offset })}`)
    return {
      items: (data?.items ?? []).map((i: any) => toTrack(i.track)).filter(Boolean),
      offset,
      total: data?.total,
      next: data?.next ? () => load(offset + limit) : undefined,
    }
  }
  return load(startOffset)
}

/** Up to 50 liked-song URIs starting at `offset`, for "play from here" in Liked Songs. */
export async function getLikedUris(offset: number): Promise<string[]> {
  const data = await call('GET', `/me/tracks${q({ limit: 50, offset })}`)
  return (data?.items ?? []).map((i: any) => i.track?.uri).filter(Boolean)
}

export interface ContextRef { uri: string; type: 'playlist' | 'album' | 'artist' | 'show'; name: string }

const nameCache = new Map<string, string>()
export const rememberName = (uri: string, name: string) => nameCache.set(uri, name)

/** Name of a playlist/album/artist/show by URI, or '' if Spotify won't say. */
export async function getContextName(uri: string): Promise<string> {
  if (nameCache.has(uri)) return nameCache.get(uri)!
  const [, type, id] = uri.split(':')
  if (!['playlist', 'album', 'artist', 'show'].includes(type)) return ''
  try {
    const path = type === 'playlist' ? `/playlists/${id}${q({ fields: 'name' })}` : `/${type}s/${id}`
    const item = await call('GET', path)
    nameCache.set(uri, item?.name ?? '')
  } catch {
    // Spotify-made playlists (Daily Mix, Discover Weekly) 404 for Development Mode apps.
    nameCache.set(uri, '')
  }
  return nameCache.get(uri)!
}

/** Playlists/albums/artists/shows you played from recently, newest first. */
export async function getRecentContexts(max: number): Promise<ContextRef[]> {
  const data = await call('GET', `/me/player/recently-played${q({ limit: 50 })}`)
  const seen = new Map<string, { type: ContextRef['type']; track: string }>()
  for (const { context, track } of data?.items ?? []) {
    const type = context?.type
    if (!['playlist', 'album', 'artist', 'show'].includes(type) || seen.has(context.uri)) continue
    seen.set(context.uri, { type, track: track?.name ?? '' })
    if (seen.size === max) break
  }
  // Look names up a few at a time; firing them all at once trips Spotify's rate limit.
  const refs: ContextRef[] = []
  const entries = [...seen]
  for (let i = 0; i < entries.length; i += 3) {
    refs.push(...await Promise.all(entries.slice(i, i + 3).map(async ([uri, { type, track }]) => {
      const name = await getContextName(uri)
      // No name (e.g. a Spotify-made mix): describe it by a song you heard from it.
      return { uri, type, name: name || `${type === 'playlist' ? 'Mix' : type} with "${track}"` }
    })))
  }
  return refs
}

export const idOf = (uri: string) => uri.split(':')[2] ?? ''
