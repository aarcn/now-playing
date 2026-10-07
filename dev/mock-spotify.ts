// A stateful fake of the Spotify Web API + accounts service, installed over
// window.fetch. Lets the app run in the Even simulator without an account and
// lets tests inject failures. Dev only: never imported by the app itself.

type Json = Record<string, any>

const artist = (id: string, name: string) => ({ id, name, uri: `spotify:artist:${id}`, type: 'artist' })
const album = (id: string, name: string, a: Json, year = '2020', total = 10) =>
  ({ id, name, uri: `spotify:album:${id}`, artists: [a], release_date: `${year}-01-01`, total_tracks: total, type: 'album' })

const queen = artist('queen', 'Queen')
const gambino = artist('gambino', 'Childish Gambino')
const utada = artist('utada', 'Utada Hikaru')
const opera = album('opera', 'A Night at the Opera', queen, '1975', 12)
const awaken = album('awaken', '"Awaken, My Love!"', gambino, '2016', 11)
const fantome = album('fantome', 'Fantôme', utada, '2016', 11)

let n = 0
const track = (name: string, a: Json, al: Json, ms = 210_000, extra: Json = {}) => {
  const id = `t${++n}`
  return { id, name, uri: `spotify:track:${id}`, type: 'track', artists: [a], album: al, duration_ms: ms, is_playable: true, ...extra }
}

const T = [
  track('Bohemian Rhapsody', queen, opera, 354_000),
  track('Redbone', gambino, awaken, 327_000),
  track('Don’t Stop Me Now – Remastered 2011', queen, opera, 209_000),
  track('道 (Michi)', utada, fantome, 255_000),
  track('🔥 Fire Track 🔥', gambino, awaken),
  track('A Song With An Extraordinarily Long Title That Goes On And On Forever', queen, opera),
  track('Local demo', queen, opera, 100_000, { is_local: true, uri: 'spotify:local:demo' }),
]
for (let i = 1; i <= 50; i++) T.push(track(`Filler Song ${i}`, i % 2 ? queen : gambino, i % 2 ? opera : awaken))

const me = { id: 'aaron', display_name: 'Aaron' }
const playlist = (id: string, name: string, owner: string, items: Json[], collaborative = false) =>
  ({ id, name, uri: `spotify:playlist:${id}`, owner: { id: owner }, collaborative, items: { total: items.length }, _items: items })

const playlists = [
  playlist('chill', 'Chill Vibes', 'aaron', T.slice(0, 25)),
  playlist('gym', '🔥🔥 Gym Bangers 🔥', 'aaron', T.slice(10, 20)),
  playlist('dw', 'Discover Weekly', 'spotify', T.slice(20, 30)),
  playlist('road', 'Road Trip – Summer ’24', 'friend', T.slice(5, 15), true),
  playlist('emoji', '🎧🎶', 'aaron', T.slice(0, 3)),
]
for (let i = 1; i <= 20; i++) playlists.push(playlist(`p${i}`, `Playlist ${i}`, 'aaron', T.slice(i, i + 5)))

const albums = [opera, awaken, fantome]
const albumTracks: Record<string, Json[]> = { opera: T.filter(t => t.album === opera), awaken: T.filter(t => t.album === awaken), fantome: T.filter(t => t.album === fantome) }
const artists = [queen, gambino, utada, ...Array.from({ length: 22 }, (_, i) => artist(`a${i}`, `Artist ${i + 1}`))]
const shows = [{ id: 'pod1', name: 'The Daily Thing', uri: 'spotify:show:pod1', type: 'show' }]
const episodes = Array.from({ length: 5 }, (_, i) => ({
  id: `e${i}`, name: `Episode ${5 - i}: Something Happened`, uri: `spotify:episode:e${i}`, type: 'episode',
  duration_ms: 1_800_000, release_date: `2026-10-0${5 - i}`, show: shows[0],
  resume_point: { resume_position_ms: i === 1 ? 600_000 : 0, fully_played: i === 2 },
}))
const liked = new Set(T.slice(0, 40).map(t => t.uri))
liked.delete(T[1].uri)

const devices = [
  { id: 'iphone', name: 'Aaron’s iPhone', type: 'Smartphone', is_active: true, supports_volume: false, volume_percent: 100, is_restricted: false },
  { id: 'mac', name: 'MacBook Pro', type: 'Computer', is_active: false, supports_volume: true, volume_percent: 50, is_restricted: false },
  { id: 'speaker', name: 'Kitchen Speaker', type: 'Speaker', is_active: false, supports_volume: true, volume_percent: 30, is_restricted: true },
]

const state = {
  context: playlists[0] as Json | null,
  list: playlists[0]._items as Json[],
  index: 0,
  playing: true,
  progress: 95_000,
  at: Date.now(),
  shuffle: false,
  repeat: 'off',
  device: 'iphone' as string | null,
  queue: [] as Json[],
}

const current = () => state.list[state.index]
const progress = () => Math.min(state.progress + (state.playing ? Date.now() - state.at : 0), current()?.duration_ms ?? 0)
const setProgress = (ms: number) => { state.progress = ms; state.at = Date.now() }

// ---------- failure injection ----------
interface Fault { pattern: RegExp; skip?: number; hang?: boolean; status?: number; reason?: string; message?: string; times: number; headers?: Record<string, string>; body?: string; offline?: boolean }
const faults: Fault[] = []
const tokenFaults: { error: string; times: number; skip: number; onHit?: () => Promise<unknown> }[] = []

export const mock = {
  state, devices, faults,
  fail(pattern: string, f: Omit<Fault, 'pattern' | 'times'> & { times?: number }) { faults.push({ pattern: new RegExp(pattern), times: 1, ...f }) },
  failToken(error: string, opts: { times?: number; skip?: number; onHit?: () => Promise<unknown> } = {}) { tokenFaults.push({ error, times: 1, skip: 0, ...opts }) },
  stop() { state.device = null; state.playing = false },
  calls: [] as string[],
}

// ---------- routing ----------
const ok = (body: Json | Json[] | null, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status: body === null ? 204 : status, headers })
const err = (status: number, message: string, reason?: string) => ok({ error: { status, message, ...(reason ? { reason } : {}) } }, status)

const page = (items: Json[], url: URL, wrap = (x: Json) => x) => {
  const limit = Number(url.searchParams.get('limit') ?? 20)
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const slice = items.slice(offset, offset + limit).map(wrap)
  return ok({ items: slice, total: items.length, limit, offset, next: offset + limit < items.length ? 'next' : null })
}

function playerState() {
  if (!state.device) return null
  const d = devices.find(x => x.id === state.device)!
  return {
    device: { ...d, is_active: true }, shuffle_state: state.shuffle, repeat_state: state.repeat,
    is_playing: state.playing, progress_ms: progress(), item: current(), currently_playing_type: current()?.type ?? 'track',
    context: state.context ? { uri: state.context.uri, type: state.context.uri.split(':')[1] } : null,
  }
}

function startPlayback(body: Json, url: URL) {
  const devId = url.searchParams.get('device_id')
  if (!state.device && !devId) return err(404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE')
  if (devId) state.device = devId
  if (body?.context_uri) {
    const [, type, id] = body.context_uri.split(':')
    const ctx = type === 'playlist' ? playlists.find(p => p.id === id)
      : type === 'album' ? { uri: body.context_uri, _items: albumTracks[id] ?? T.slice(0, 5) }
      : { uri: body.context_uri, _items: T.filter(t => t.artists[0].id === id) }
    if (!ctx) return err(404, 'Not found')
    state.context = ctx
    state.list = ctx._items
    state.index = body.offset?.uri ? Math.max(0, state.list.findIndex(t => t.uri === body.offset.uri)) : body.offset?.position ?? 0
  } else if (body?.uris) {
    state.context = null
    state.list = body.uris.map((u: string) => T.find(t => t.uri === u) ?? episodes.find(e => e.uri === u)).filter(Boolean)
    state.index = body.offset?.position ?? 0
  }
  if (body?.context_uri || body?.uris) setProgress(body.position_ms ?? 0)
  else setProgress(progress())
  state.playing = true
  return ok(null)
}

// Real Spotify keeps reporting the old player state for a moment after a
// command. Reproduce that: reads lag writes by LAG_MS.
const LAG_MS = 900
const lag = { until: 0, snapshot: null as Json | null }

async function route(method: string, url: URL, body: Json | null): Promise<Response> {
  if (method !== 'GET' && url.pathname.startsWith('/v1/me/player') && Date.now() >= lag.until) {
    lag.snapshot = playerState()
    lag.until = Date.now() + LAG_MS
  }
  const p = url.pathname.replace('/v1', '')
  const needsDevice = () => (state.device ? null : err(404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE'))

  if (method === 'GET' && p === '/me') return ok(me)
  if (method === 'GET' && p === '/me/player') return ok(Date.now() < lag.until ? lag.snapshot : playerState())
  if (method === 'GET' && p === '/me/player/devices') return ok({ devices: devices.map(d => ({ ...d, is_active: d.id === state.device })) })
  if (method === 'PUT' && p === '/me/player/play') return startPlayback(body ?? {}, url)
  if (method === 'PUT' && p === '/me/player/pause') { const e = needsDevice(); if (e) return e; setProgress(progress()); state.playing = false; return ok(null) }
  if (method === 'POST' && p === '/me/player/next') {
    const e = needsDevice(); if (e) return e
    if (state.queue.length) { state.list.splice(state.index + 1, 0, state.queue.shift()!) }
    state.index = Math.min(state.index + 1, state.list.length - 1); setProgress(0); return ok(null)
  }
  if (method === 'POST' && p === '/me/player/previous') { const e = needsDevice(); if (e) return e; state.index = Math.max(0, state.index - 1); setProgress(0); return ok(null) }
  if (method === 'PUT' && p === '/me/player/seek') { setProgress(Number(url.searchParams.get('position_ms'))); return ok(null) }
  if (method === 'PUT' && p === '/me/player/shuffle') { const e = url.searchParams.get('device_id') ? null : needsDevice(); if (e) return e; state.shuffle = url.searchParams.get('state') === 'true'; return ok(null) }
  if (method === 'PUT' && p === '/me/player/repeat') { state.repeat = url.searchParams.get('state')!; return ok(null) }
  if (method === 'PUT' && p === '/me/player/volume') {
    const d = devices.find(x => x.id === state.device)!
    if (!d.supports_volume) return err(403, 'Player command failed: Cannot control device volume', 'VOLUME_CONTROL_DISALLOW')
    d.volume_percent = Number(url.searchParams.get('volume_percent')); return ok(null)
  }
  if (method === 'PUT' && p === '/me/player') { state.device = body!.device_ids[0]; if (body!.play) state.playing = true; return ok(null) }
  if (method === 'GET' && p === '/me/player/queue') return ok({ currently_playing: current(), queue: [...state.queue, ...state.list.slice(state.index + 1, state.index + 8)] })
  if (method === 'POST' && p === '/me/player/queue') { const t = T.find(x => x.uri === url.searchParams.get('uri')); if (t) state.queue.push(t); return ok(null) }
  if (method === 'GET' && p === '/me/player/recently-played') {
    const items = [
      { track: T[0], context: { uri: 'spotify:playlist:chill', type: 'playlist' } },
      { track: T[1], context: { uri: 'spotify:playlist:dailymix', type: 'playlist' } },
      { track: T[2], context: { uri: 'spotify:album:opera', type: 'album' } },
      { track: T[3], context: null },
      { track: T[0], context: { uri: 'spotify:playlist:chill', type: 'playlist' } },
      { track: T[4], context: { uri: 'spotify:artist:gambino', type: 'artist' } },
      { track: T[1], context: { uri: 'spotify:user:aaron:collection', type: 'collection' } },
    ]
    return ok({ items })
  }
  if (method === 'GET' && p === '/me/library/contains') return ok(url.searchParams.get('uris')!.split(',').map(u => liked.has(u)))
  if (method === 'PUT' && p === '/me/library') { url.searchParams.get('uris')!.split(',').forEach(u => liked.add(u)); return ok({}) }
  if (method === 'DELETE' && p === '/me/library') { url.searchParams.get('uris')!.split(',').forEach(u => liked.delete(u)); return ok({}) }
  if (method === 'GET' && p === '/me/playlists') return page(playlists, url, ({ _items, ...pl }) => pl)
  if (method === 'GET' && p === '/me/albums') return page(albums, url, a => ({ album: a }))
  if (method === 'GET' && p === '/me/tracks') return page(T.filter(t => liked.has(t.uri)), url, t => ({ track: t }))
  if (method === 'GET' && p === '/me/shows') return page(shows, url, s => ({ show: s }))
  if (method === 'GET' && p === '/me/following') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const after = url.searchParams.get('after')
    const start = after ? artists.findIndex(a => a.id === after) + 1 : 0
    const items = artists.slice(start, start + limit)
    const more = start + limit < artists.length
    return ok({ artists: { items, total: artists.length, next: more ? 'next' : null, cursors: { after: more ? items[items.length - 1].id : null } } })
  }

  let m: RegExpMatchArray | null
  if (method === 'GET' && (m = p.match(/^\/playlists\/([^/]+)\/items$/))) {
    const pl = playlists.find(x => x.id === m![1])
    if (!pl) return err(404, 'Resource not found')
    if (pl.owner.id !== 'aaron' && !pl.collaborative) return err(403, 'Forbidden')
    return page(pl._items, url, t => ({ added_at: '2026-01-01', item: t }))
  }
  if (method === 'GET' && (m = p.match(/^\/playlists\/([^/]+)$/))) {
    const pl = playlists.find(x => x.id === m![1])
    return pl ? ok({ name: pl.name }) : err(404, 'Resource not found')
  }
  if (method === 'GET' && (m = p.match(/^\/albums\/([^/]+)\/tracks$/))) {
    return page(albumTracks[m[1]] ?? [], url, ({ album: _a, ...t }) => t)
  }
  if (method === 'GET' && (m = p.match(/^\/albums\/([^/]+)$/))) { const a = albums.find(x => x.id === m![1]); return a ? ok(a) : err(404, 'Resource not found') }
  if (method === 'GET' && (m = p.match(/^\/artists\/([^/]+)\/albums$/))) return page(albums.filter(a => a.artists[0].id === m![1]), url)
  if (method === 'GET' && (m = p.match(/^\/artists\/([^/]+)$/))) { const a = artists.find(x => x.id === m![1]); return a ? ok(a) : err(404, 'Resource not found') }
  if (method === 'GET' && (m = p.match(/^\/shows\/([^/]+)\/episodes$/))) return page(episodes, url)
  if (method === 'GET' && (m = p.match(/^\/shows\/([^/]+)$/))) return ok(shows[0])

  return err(404, `mock: no route for ${method} ${p}`)
}

// ---------- install ----------
let tokenN = 0

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href)
  if (!/spotify\.com$/.test(url.hostname)) return realFetch(input, init)
  const method = (init.method ?? 'GET').toUpperCase()
  const label = `${method} ${url.pathname.replace('/v1', '')}${url.search}`
  mock.calls.push(label)
  console.log('[api]', label)
  await new Promise(r => setTimeout(r, 60))   // a little latency, like the real thing

  if (url.hostname === 'accounts.spotify.com') {
    const form = new URLSearchParams(String(init.body ?? ''))
    const fault = tokenFaults.find(f => f.times > 0 && !(f.skip && f.skip-- > 0))
    if (fault) {
      fault.times--
      console.log('[fault] token', fault.error)
      await fault.onHit?.()
      return ok({ error: fault.error, error_description: 'Refresh token revoked' }, 400)
    }
    if (form.get('grant_type') === 'refresh_token' && !form.get('refresh_token')?.startsWith('rt-')) {
      return ok({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400)
    }
    tokenN++
    return ok({ access_token: `at-${tokenN}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${tokenN}`, scope: 'user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-library-modify user-follow-read user-read-recently-played' })
  }

  const fault = faults.find(f => f.times > 0 && f.pattern.test(label) && !(f.skip && f.skip-- > 0))
  if (fault) {
    fault.times--
    console.log('[fault]', label)
    if (fault.offline) throw new TypeError('Failed to fetch')
    if (fault.hang) {
      // Never answers; only the caller's abort signal ends it.
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }
    if (fault.body !== undefined) return new Response(fault.body, { status: fault.status ?? 500, headers: fault.headers })
    return new Response(JSON.stringify({ error: { status: fault.status, message: fault.message ?? 'Injected', reason: fault.reason } }), { status: fault.status ?? 500, headers: fault.headers })
  }

  const body = init.body ? JSON.parse(String(init.body)) : null
  return route(method, url, body)
}

;(window as any).mock = mock
