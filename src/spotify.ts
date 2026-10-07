import { getAccessToken, invalidateAccessToken } from './auth'

const API = 'https://api.spotify.com/v1'

export class SpotifyError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message)
  }
}

async function call<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T | null> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401 && !retried) {
    invalidateAccessToken()
    return call(method, path, body, true)
  }
  if (res.status === 204) return null

  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = data?.error ?? {}
    throw new SpotifyError(res.status, err.reason ?? '', err.message ?? `Spotify ${res.status}`)
  }
  return data
}

// ---------- Player ----------

export interface PlayerState {
  title: string
  artist: string
  album: string
  isPlaying: boolean
  progressMs: number
  durationMs: number
  deviceName: string
}

/** null when nothing is playing on any device. */
export async function getPlayer(): Promise<PlayerState | null> {
  const p = await call('GET', '/me/player?additional_types=episode')
  if (!p?.item) return null
  const item = p.item
  const isEpisode = item.type === 'episode'
  return {
    title: item.name,
    artist: isEpisode ? item.show?.name ?? '' : item.artists.map((a: any) => a.name).join(', '),
    album: isEpisode ? '' : item.album?.name ?? '',
    isPlaying: p.is_playing,
    progressMs: p.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    deviceName: p.device?.name ?? '',
  }
}

/**
 * Runs a playback command. If Spotify says no device is active, wake the first
 * available one (e.g. phone app open but idle) and pass its id explicitly.
 */
async function withDevice(run: (query: string) => Promise<unknown>): Promise<void> {
  try {
    await run('')
  } catch (e) {
    if (!(e instanceof SpotifyError) || e.reason !== 'NO_ACTIVE_DEVICE') throw e
    const { devices } = (await call('GET', '/me/player/devices')) ?? { devices: [] }
    if (!devices.length) throw new SpotifyError(404, 'NO_DEVICE', 'Open Spotify on a device first')
    await run(`?device_id=${devices[0].id}`)
  }
}

export const play = () => withDevice(q => call('PUT', `/me/player/play${q}`))
export const pause = () => call('PUT', '/me/player/pause')
export const next = () => call('POST', '/me/player/next')
export const previous = () => call('POST', '/me/player/previous')

export const playContext = (contextUri: string) =>
  withDevice(q => call('PUT', `/me/player/play${q}`, { context_uri: contextUri }))

export const playTracks = (uris: string[]) =>
  withDevice(q => call('PUT', `/me/player/play${q}`, { uris }))

// ---------- Library ----------

export interface Entry { label: string; uri: string }
export interface Page { entries: Entry[]; hasMore: boolean }

export async function getPlaylists(offset: number, limit: number): Promise<Page> {
  const data = await call('GET', `/me/playlists?limit=${limit}&offset=${offset}`)
  return {
    entries: data.items.filter(Boolean).map((p: any) => ({ label: p.name, uri: p.uri })),
    hasMore: data.next !== null,
  }
}

export async function getAlbums(offset: number, limit: number): Promise<Page> {
  const data = await call('GET', `/me/albums?limit=${limit}&offset=${offset}`)
  return {
    entries: data.items.map(({ album }: any) => ({ label: `${album.name} · ${album.artists[0]?.name ?? ''}`, uri: album.uri })),
    hasMore: data.next !== null,
  }
}

/** Playlists/albums/artists you played from recently, newest first. */
export async function getRecentContexts(max: number): Promise<Page> {
  const data = await call('GET', '/me/player/recently-played?limit=50')
  const uris: string[] = []
  for (const { context } of data.items) {
    const playable = ['playlist', 'album', 'artist'].includes(context?.type)
    if (playable && !uris.includes(context.uri)) uris.push(context.uri)
    if (uris.length === max) break
  }

  // The recently-played feed only has URIs, so look up each name. Batch lookups
  // were removed for Development Mode apps, hence one request per item.
  const entries = await Promise.all(uris.map(async uri => {
    const [, type, id] = uri.split(':')
    try {
      const path = type === 'playlist' ? `/playlists/${id}?fields=name` : `/${type}s/${id}`
      const item = await call('GET', path)
      return { label: item.name, uri }
    } catch {
      return null
    }
  }))
  return { entries: entries.filter((e): e is Entry => e !== null), hasMore: false }
}

/** Most recent liked songs as track URIs (Liked Songs can't be played as a context). */
export async function getLikedTrackUris(limit = 50): Promise<string[]> {
  const data = await call('GET', `/me/tracks?limit=${limit}`)
  return data.items.map((i: any) => i.track.uri)
}
