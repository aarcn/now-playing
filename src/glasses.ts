import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList as Ev,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { serial } from './bridge'
import { NotLoggedIn } from './auth'
import * as spotify from './spotify'
import type { Album, ContextRef, Page, Playlist, PlayerState, Track } from './spotify'
import { clip, label, mmss } from './text'

// ---------- Tunables ----------
const W = 576
const H = 288
const BAR_CHARS = 20          // progress bar width in characters
const MAX_ROWS = 20           // firmware limit for a list
const FLASH_MS = 4000
const POLL_PLAYING_MS = 3000
const POLL_IDLE_MS = 8000
const POLL_BACKGROUND_MS = 20000

const debug = import.meta.env.DEV ? (...args: unknown[]) => console.debug('[np]', ...args) : () => {}

// ---------- Preferences (set from the phone screen) ----------
export const prefs = { swipeDownIsNext: true }

// ---------- State ----------
interface Row { label: string; run?: () => Promise<void> }   // no run = an inert note
interface View { title: string; rows: Row[] }

const stack: View[] = []      // empty = the now-playing screen
let player: PlayerState | null = null
let syncedAt = 0              // when `player` was fetched, for local progress
let saved: boolean | null = null
let contextName = ''
let status = 'Connecting to Spotify...'
let failures = 0
let flash = ''
let flashUntil = 0
let foreground = true
let navBusy = false
let pageCreated = false
let lastNowText = ''

// Commands run one after another so rapid swipes all land. A command bumps the
// epoch so a poll that started before it can't overwrite the optimistic state,
// and holds polling briefly because Spotify takes a moment to reflect changes.
let commandChain: Promise<void> = Promise.resolve()
let commandEpoch = 0
let holdUntil = 0

// ---------- Now-playing text ----------
function progressMs(): number {
  if (!player) return 0
  const elapsed = player.isPlaying ? Date.now() - syncedAt : 0
  return Math.min(player.progressMs + elapsed, player.durationMs || Infinity)
}

function statusLine(p: PlayerState): string {
  const bits: string[] = []
  if (saved) bits.push('♥')
  if (p.shuffle) bits.push('Shuffle')
  if (p.repeat === 'context') bits.push('Repeat')
  if (p.repeat === 'track') bits.push('Repeat one')
  if (p.device) bits.push(clip(p.device.name, 22) + (p.device.volume !== null ? ` ${p.device.volume}%` : ''))
  return bits.join('  ·  ')
}

function nowText(): string {
  const notice = Date.now() < flashUntil ? flash : failures >= 3 ? 'Can\'t reach Spotify, retrying...' : ''
  if (status) return `${status}\n\n${notice}`.trim()

  const p = player
  if (!p) {
    return ['Nothing playing', '', 'Tap to resume on your last device,', 'or double-tap to pick something.', '', notice].join('\n')
  }
  if (p.kind === 'ad') return ['Advertisement', 'Your music will resume after this.', '', statusLine(p), notice].join('\n')
  if (p.kind === 'unknown') return [`Ready on ${clip(p.device?.name ?? 'your device', 30)}`, 'Tap to play, double-tap for the menu.', '', notice].join('\n')

  const pos = progressMs()
  const filled = p.durationMs ? Math.round((pos / p.durationMs) * BAR_CHARS) : 0
  const bar = '━'.repeat(filled) + '─'.repeat(BAR_CHARS - filled)
  const subtitle = p.kind === 'episode' ? p.artists : [p.artists, p.album?.name].filter(Boolean).join(' · ')

  return [
    `${p.isPlaying ? '▶' : 'II'}  ${clip(p.title, 34) || 'Untitled'}`,
    clip(subtitle, 46),
    contextName && p.contextUri !== p.album?.uri ? `from ${clip(contextName, 40)}` : '',
    `${mmss(pos)}  ${bar}  ${mmss(p.durationMs)}`,
    statusLine(p),
    notice,
  ].join('\n').trimEnd()
}

function showFlash(message: string) {
  flash = clip(message, 46)
  flashUntil = Date.now() + FLASH_MS
}

function errorText(e: unknown): string {
  if (e instanceof NotLoggedIn) return 'Not signed in. Open the app on your phone'
  return e instanceof Error ? e.message : 'Something went wrong'
}

// ---------- Rendering ----------
function nowPage() {
  return {
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: W, height: H,
      borderWidth: 0, paddingLength: 16,
      containerID: 1, containerName: 'now',
      content: nowText(),
      isEventCapture: 1,
    })],
  }
}

function listPage(view: View) {
  const rows = view.rows.slice(0, MAX_ROWS)
  return {
    containerTotalNum: 2,
    textObject: [new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: W, height: 40,
      borderWidth: 0, paddingLength: 8,
      containerID: 1, containerName: 'title',
      content: clip(view.title, 44),
      isEventCapture: 0,
    })],
    listObject: [new ListContainerProperty({
      xPosition: 0, yPosition: 44, width: W, height: H - 44,
      borderWidth: 0,
      containerID: 2, containerName: 'list',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: rows.length,
        itemName: rows.map(r => r.label),
        isItemSelectBorderEn: 1,
      }),
    })],
  }
}

async function rebuild(page: ReturnType<typeof nowPage> | ReturnType<typeof listPage>): Promise<boolean> {
  try {
    return await rebuildOnce(page)
  } catch (e) {
    console.warn('[glasses] render failed:', e)
    return false
  }
}

async function rebuildOnce(page: ReturnType<typeof nowPage> | ReturnType<typeof listPage>): Promise<boolean> {
  if (!pageCreated) {
    // createStartUpPageContainer may only run once. If the Even app reloaded us
    // (it does when the phone goes to the background) a page already exists,
    // so fall through to a rebuild.
    const result = await serial(b => b.createStartUpPageContainer(new CreateStartUpPageContainer(page)))
    pageCreated = true
    if (result === StartUpPageCreateResult.success) return true
    debug('create returned', result, '- rebuilding instead')
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await serial(b => b.rebuildPageContainer(new RebuildPageContainer(page)))) return true
    await new Promise(r => setTimeout(r, 300))
  }
  console.warn('[glasses] rebuildPageContainer failed twice')
  return false
}

async function render(): Promise<void> {
  const view = stack[stack.length - 1]
  if (!view) {
    lastNowText = nowText()
    debug('now', JSON.stringify(lastNowText))
    await rebuild(nowPage())
  } else {
    debug('view', JSON.stringify({ title: view.title, rows: view.rows.map(r => r.label) }))
    await rebuild(listPage(view))
  }
}

/** Redraws the now-playing text in place, only when it changed. */
async function updateNow(): Promise<void> {
  if (stack.length || !pageCreated || !foreground) return
  const text = nowText()
  if (text === lastNowText) return
  lastNowText = text
  debug('now', JSON.stringify(text))
  const ok = await serial(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'now', content: text }))).catch(() => false)
  if (!ok) lastNowText = ''   // try again on the next tick
}

/** Briefly replaces a list's title (e.g. "Loading..." or "Added to queue"). */
async function listNotice(message: string, revertMs = 0): Promise<void> {
  const view = stack[stack.length - 1]
  if (!view) return
  debug('notice', message)
  await serial(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'title', content: clip(message, 44) }))).catch(() => {})
  if (revertMs) {
    setTimeout(() => {
      if (stack[stack.length - 1] === view) {
        void serial(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'title', content: clip(view.title, 44) }))).catch(() => {})
      }
    }, revertMs)
  }
}

// ---------- Navigation ----------
async function push(view: View) {
  stack.push(view)
  await render()
}

async function pop() {
  stack.pop()
  await render()
}

async function home() {
  stack.length = 0
  await render()
}

/** Runs a list action with input locked and a loading hint, turning errors into a notice. */
async function navigate(action: () => Promise<void>): Promise<void> {
  if (navBusy) return
  navBusy = true
  const slow = setTimeout(() => {
    if (stack.length) void listNotice('Loading...')
    else { showFlash('Loading...'); void updateNow() }
  }, 250)
  try {
    await action()
  } catch (e) {
    debug('nav error', e)
    if (stack.length) {
      await listNotice(errorText(e), 3000)
    } else {
      showFlash(errorText(e))
      await updateNow()
    }
  } finally {
    clearTimeout(slow)
    if (flash === 'Loading...') flashUntil = 0
    navBusy = false
  }
}

// ---------- Commands ----------
function command(run: () => Promise<unknown>, opts: { done?: string; optimistic?: () => void } = {}): Promise<void> {
  commandEpoch++
  opts.optimistic?.()
  void updateNow()
  const job = commandChain.then(async () => {
    try {
      await run()
      if (opts.done) showFlash(opts.done)
    } catch (e) {
      showFlash(errorText(e))
    } finally {
      holdUntil = Date.now() + 1200
      schedulePoll(1300)
      await updateNow()
    }
  })
  commandChain = job.catch(() => {})
  return job
}

/** Starts playback from a list, then shows the now-playing screen. */
async function playFromList(what: string, run: () => Promise<unknown>): Promise<void> {
  await run()   // errors surface on the list via navigate()
  showFlash(`Playing ${what}`)
  commandEpoch++
  holdUntil = Date.now() + 1200
  schedulePoll(1300)
  await home()
}

function togglePlay() {
  const p = player
  if (!p || p.kind === 'unknown') return command(spotify.play)
  const wasPlaying = p.isPlaying
  return command(wasPlaying ? spotify.pause : spotify.play, {
    optimistic: () => {
      p.progressMs = progressMs()
      syncedAt = Date.now()
      p.isPlaying = !wasPlaying
    },
  })
}

function skip(forward: boolean) {
  if (forward) {
    showFlash('Next >>')
    return command(spotify.next)
  }
  // Like every music player: "previous" restarts the song unless you're near its start.
  if (player && progressMs() > 5000) {
    return command(() => spotify.seek(0), {
      done: 'Restarted',
      optimistic: () => { player!.progressMs = 0; syncedAt = Date.now() },
    })
  }
  showFlash('<< Previous')
  return command(spotify.previous)
}

// ---------- Views ----------
const more = 'More...'
const arrow = (s: string) => `${s}  >`

function menuView(): View {
  const p = player
  const playing = p && (p.kind === 'track' || p.kind === 'episode')
  const rows: Row[] = [{ label: arrow('Library'), run: () => push(libraryView()) }]

  if (playing) {
    rows.push({ label: arrow('Up next'), run: async () => push(await queueView()) })

    if (saved !== null) {
      const noun = p.kind === 'episode' ? 'episode' : 'song'
      rows.push(saved
        ? { label: `♥ Liked (tap to unlike this ${noun})`, run: () => homeThen(setLiked(p.uri, false)) }
        : { label: `♡ Like this ${noun}`, run: () => homeThen(setLiked(p.uri, true)) })
    }

    const shuffleTo = !p.shuffle
    rows.push({
      label: `Shuffle: ${p.shuffle ? 'On' : 'Off'}`,
      run: () => homeThen(command(() => spotify.setShuffle(shuffleTo), {
        done: `Shuffle ${shuffleTo ? 'on' : 'off'}`,
        optimistic: () => { if (player) player.shuffle = shuffleTo },
      })),
    })

    const nextRepeat: Record<spotify.Repeat, spotify.Repeat> = { off: 'context', context: 'track', track: 'off' }
    const repeatName: Record<spotify.Repeat, string> = { off: 'Off', context: 'All', track: 'One song' }
    rows.push({
      label: `Repeat: ${repeatName[p.repeat]}`,
      run: () => {
        const mode = nextRepeat[p.repeat]
        return homeThen(command(() => spotify.setRepeat(mode), {
          done: `Repeat: ${repeatName[mode]}`,
          optimistic: () => { if (player) player.repeat = mode },
        }))
      },
    })

    if (p.device && p.device.volume !== null) {
      rows.push({ label: arrow(`Volume: ${p.device.volume}%`), run: () => push(volumeView(p.device!.volume!)) })
    } else if (p.device) {
      rows.push({ label: `Volume: set on ${clip(p.device.name, 22)}` })
    }

    rows.push({ label: arrow('Seek'), run: () => push(seekView()) })
  }

  rows.push({ label: arrow(p?.device ? `Device: ${clip(p.device.name, 24)}` : 'Devices'), run: async () => push(await devicesView()) })

  if (playing && p.album) rows.push({ label: arrow(`Album: ${clip(p.album.name, 28)}`), run: () => openAlbum(p.album!.uri, p.album!.name) })
  if (playing && p.artist && p.kind === 'track') rows.push({ label: arrow(`Artist: ${clip(p.artist.name, 28)}`), run: () => openArtist(p.artist!.uri, p.artist!.name) })
  if (playing && p.artist && p.kind === 'episode') rows.push({ label: arrow(`Show: ${clip(p.artist.name, 30)}`), run: () => openShow(p.artist!.uri, p.artist!.name) })

  // The system dialog may not answer until the user does, so don't wait on it.
  rows.push({ label: 'Exit', run: async () => { void serial(b => b.shutDownPageContainer(1)).catch(() => {}) } })
  return { title: 'Menu  ·  double-tap = back', rows }
}

async function homeThen(job: Promise<void>) {
  await home()
  await job
}

function setLiked(uri: string, like: boolean): Promise<void> {
  return command(() => spotify.setSaved(uri, like), {
    done: like ? 'Added to Liked Songs' : 'Removed from Liked Songs',
    optimistic: () => { saved = like },
  })
}

function libraryView(): View {
  return {
    title: 'Library',
    rows: [
      { label: arrow('Playlists'), run: async () => push(await pagedView('Playlists', await spotify.getPlaylists(19), playlistRow, [], 'No playlists yet')) },
      { label: arrow('Albums'), run: async () => push(await pagedView('Albums', await spotify.getSavedAlbums(19), albumRow, [], 'No saved albums')) },
      { label: arrow('Artists'), run: async () => push(await pagedView('Artists', await spotify.getFollowedArtists(19), a => ({ label: label(a.name, 'Unknown artist'), run: () => openArtist(a.uri, a.name) }), [], 'You don\'t follow any artists')) },
      { label: arrow('Podcasts'), run: async () => push(await pagedView('Podcasts', await spotify.getSavedShows(19), s => ({ label: label(s.name, 'Podcast'), run: () => openShow(s.uri, s.name) }), [], 'No saved podcasts')) },
      { label: arrow('Liked Songs'), run: openLiked },
      { label: arrow('Recently played'), run: async () => push(recentView(await spotify.getRecentContexts(19))) },
    ],
  }
}

/** A list page with optional fixed rows on top and a "More..." row when there's more. */
function pagedView<T>(title: string, page: Page<T>, toRow: (item: T, index: number) => Row, header: Row[], empty: string): View {
  const rows = [...header, ...page.items.map((item, i) => toRow(item, page.offset + i))]
  if (!page.items.length && page.offset === 0) rows.push({ label: empty })
  if (page.next) {
    const loadNext = page.next
    rows.push({ label: more, run: async () => push(pagedView(title, await loadNext(), toRow, [], empty)) })
  }
  const shown = page.items.length
  const pageTitle = page.offset > 0 ? `${title}  (${page.offset + 1}-${page.offset + shown})` : title
  return { title: pageTitle, rows }
}

function playlistRow(pl: Playlist): Row {
  return { label: label(pl.name, 'Untitled playlist'), run: () => openPlaylist(pl.uri, pl.name, pl.canListTracks, pl.total) }
}

function albumRow(a: Album): Row {
  return { label: label(a.year ? `${a.name} · ${a.year}` : `${a.name} · ${a.artist}`, 'Untitled album'), run: () => openAlbum(a.uri, a.name, a.total) }
}

function playRows(uri: string, name: string, total?: number): Row[] {
  spotify.rememberName(uri, name)
  return [
    { label: '▶ Play', run: () => playFromList(name, () => spotify.playContext(uri)) },
    { label: '▶ Shuffle play', run: () => playFromList(`${name} on shuffle`, () => spotify.shufflePlay(uri, total)) },
  ]
}

async function openPlaylist(uri: string, name: string, canListTracks?: boolean, total?: number) {
  const header = playRows(uri, name, total)
  const notShared: View = { title: name, rows: [...header, { label: 'Spotify only shares track lists' }, { label: 'for playlists you own.' }] }
  if (canListTracks === false) return push(notShared)
  try {
    const page = await spotify.getPlaylistTracks(spotify.idOf(uri), 17)
    await push(pagedView(name, page, t => trackRow(t, () => spotify.playContext(uri, { uri: t.uri })), header, 'This playlist is empty'))
  } catch (e) {
    if (e instanceof spotify.SpotifyError && (e.status === 403 || e.status === 404)) return push(notShared)
    throw e
  }
}

async function openAlbum(uri: string, name: string, total?: number) {
  const page = await spotify.getAlbumTracks(spotify.idOf(uri), 17)
  await push(pagedView(name, page, t => trackRow(t, () => spotify.playContext(uri, { uri: t.uri })), playRows(uri, name, total ?? page.total), 'No tracks'))
}

async function openArtist(uri: string, name: string) {
  spotify.rememberName(uri, name)
  const header: Row[] = [
    { label: '▶ Play artist', run: () => playFromList(name, () => spotify.playContext(uri)) },
    { label: '▶ Shuffle artist', run: () => playFromList(`${name} on shuffle`, () => spotify.shufflePlay(uri)) },
  ]
  const page = await spotify.getArtistAlbums(spotify.idOf(uri), 17)
  await push(pagedView(name, page, albumRow, header, 'No albums'))
}

async function openShow(uri: string, name: string) {
  spotify.rememberName(uri, name)
  const page = await spotify.getShowEpisodes(spotify.idOf(uri), 19)
  await push(pagedView(name, page, ep => ({
    label: label(`${ep.name}${ep.finished ? ' · played' : ep.resumeMs > 0 ? ' · resume' : ''}`, 'Episode'),
    run: () => playFromList(ep.name, () => spotify.playUris([ep.uri], undefined, ep.finished ? 0 : ep.resumeMs)),
  }), [], 'No episodes'))
}

async function openLiked() {
  const first = await spotify.getLikedTracks(17)
  const total = first.total ?? 0
  const header: Row[] = [
    { label: '▶ Play', run: () => playFromList('Liked Songs', async () => spotify.playUris(await spotify.getLikedUris(0))) },
    {
      label: '▶ Shuffle play',
      run: () => playFromList('Liked Songs on shuffle', async () => {
        // Spotify can't play Liked Songs as a context, so shuffle a random
        // 50-song window of the library rather than always the newest 50.
        const start = total > 50 ? Math.floor(Math.random() * (total - 50)) : 0
        const uris = await spotify.getLikedUris(start)
        await spotify.setShuffle(true)
        await spotify.playUris(uris, { position: Math.floor(Math.random() * uris.length) })
      }),
    },
  ]
  await push(pagedView('Liked Songs', first, (t, index) =>
    trackRow(t, async () => spotify.playUris(await spotify.getLikedUris(index))), header, 'No liked songs yet'))
}

function recentView(items: ContextRef[]): View {
  return {
    title: 'Recently played',
    rows: items.length ? items.map(c => ({
      label: label(c.name, 'Recent'),
      run: () => {
        if (c.type === 'playlist') return openPlaylist(c.uri, c.name)
        if (c.type === 'album') return openAlbum(c.uri, c.name)
        if (c.type === 'artist') return openArtist(c.uri, c.name)
        return openShow(c.uri, c.name)
      },
    })) : [{ label: 'Nothing played recently' }],
  }
}

function trackRow(t: Track, play: () => Promise<unknown>): Row {
  const text = label(t.artists ? `${t.title} · ${t.artists}` : t.title, 'Untitled')
  if (!t.playable) return { label: `${text} (unavailable)` }
  return { label: text, run: async () => push(await trackView(t, play)) }
}

/** Everything you can do with one song. */
async function trackView(t: Track, play: () => Promise<unknown>): Promise<View> {
  const isLiked = await spotify.isSaved(t.uri).catch(() => null)
  const rows: Row[] = [
    { label: '▶ Play', run: () => playFromList(t.title, play) },
    {
      label: '+ Add to queue',
      run: async () => {
        await spotify.addToQueue(t.uri)
        await pop()
        await listNotice(`Queued: ${t.title}`, 2500)
      },
    },
  ]
  if (isLiked !== null) {
    rows.push({
      label: isLiked ? '♥ Liked (tap to unlike)' : '♡ Like',
      run: async () => {
        await spotify.setSaved(t.uri, !isLiked)
        if (player?.uri === t.uri) saved = !isLiked
        await pop()
        await listNotice(isLiked ? 'Removed from Liked Songs' : 'Added to Liked Songs', 2500)
      },
    })
  }
  if (t.album) rows.push({ label: arrow(`Album: ${clip(t.album.name, 28)}`), run: () => openAlbum(t.album!.uri, t.album!.name) })
  if (t.artist) rows.push({ label: arrow(`Artist: ${clip(t.artist.name, 28)}`), run: () => openArtist(t.artist!.uri, t.artist!.name) })
  return { title: t.title, rows }
}

async function queueView(): Promise<View> {
  const queue = await spotify.getQueue()
  return {
    title: 'Up next  ·  tap to skip ahead',
    rows: queue.length ? queue.slice(0, MAX_ROWS).map((item, i) => ({
      label: label(item.subtitle ? `${item.title} · ${item.subtitle}` : item.title, 'Untitled'),
      run: () => homeThen(command(async () => {
        for (let n = 0; n <= i; n++) await spotify.next()
      }, { done: `Skipped to ${item.title}` })),
    })) : [{ label: 'Nothing queued' }],
  }
}

async function devicesView(): Promise<View> {
  const devices = await spotify.getDevices()
  const rows: Row[] = devices.map(d => ({
    label: `${d.isActive ? '●' : '○'} ${clip(d.name, 30)}${d.restricted ? ' (no remote)' : ''}`,
    run: d.restricted || d.isActive ? undefined : () => homeThen(command(
      () => spotify.transferTo(d.id, player?.isPlaying ?? true),
      { done: `Playing on ${d.name}` },
    )),
  }))
  if (!rows.length) rows.push({ label: 'No devices found. Open Spotify' }, { label: 'on a phone, computer or speaker.' })
  rows.push({ label: 'Refresh', run: async () => { stack.pop(); await push(await devicesView()) } })
  return { title: 'Play on', rows }
}

function volumeView(current: number): View {
  const set = (pct: number) => () => homeThen(command(() => spotify.setVolume(pct), {
    done: pct === 0 ? 'Muted' : `Volume ${pct}%`,
    optimistic: () => { if (player?.device) player.device.volume = pct },
  }))
  const levels = [100, 75, 50, 25, 10]
  return {
    title: `Volume  ·  now ${current}%`,
    rows: [
      { label: 'Louder (+10%)', run: set(Math.min(100, current + 10)) },
      { label: 'Quieter (-10%)', run: set(Math.max(0, current - 10)) },
      ...levels.map(l => ({ label: `${l === current ? '●' : '○'} ${l}%`, run: set(l) })),
      { label: `${current === 0 ? '●' : '○'} Mute`, run: set(0) },
    ],
  }
}

function seekView(): View {
  const by = (deltaMs: number, done: string) => () => homeThen(command(() => spotify.seek(progressMs() + deltaMs), {
    done,
    optimistic: () => {
      if (!player) return
      player.progressMs = Math.max(0, Math.min(progressMs() + deltaMs, player.durationMs))
      syncedAt = Date.now()
    },
  }))
  return {
    title: 'Seek',
    rows: [
      { label: 'Restart', run: by(-Infinity, 'Restarted') },
      { label: 'Back 30 s', run: by(-30_000, 'Back 30 s') },
      { label: 'Back 10 s', run: by(-10_000, 'Back 10 s') },
      { label: 'Forward 10 s', run: by(10_000, 'Forward 10 s') },
      { label: 'Forward 30 s', run: by(30_000, 'Forward 30 s') },
    ],
  }
}

// ---------- Spotify sync ----------
let pollTimer = 0
let pollAt = 0

/** Polls after `ms`, unless a poll is already due sooner. */
function schedulePoll(ms: number) {
  const at = Date.now() + ms
  if (pollTimer && pollAt <= at) return
  clearTimeout(pollTimer)
  pollAt = at
  pollTimer = window.setTimeout(pollLoop, ms)
}

function nextPollDelay(): number {
  const limited = spotify.rateLimitedFor()
  if (limited) return limited + 250
  if (failures) return Math.min(15_000, POLL_PLAYING_MS * 2 ** (failures - 1))   // 3s, 6s, 12s, 15s...
  if (!foreground) return POLL_BACKGROUND_MS
  return player?.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS
}

async function pollLoop() {
  pollTimer = 0
  await refresh()
  schedulePoll(nextPollDelay())
}

async function refresh(): Promise<void> {
  const epoch = commandEpoch
  try {
    const next = await spotify.getPlayer()
    if (epoch !== commandEpoch || Date.now() < holdUntil) return   // stale: a command ran meanwhile

    const trackChanged = next?.uri !== player?.uri
    const contextChanged = next?.contextUri !== player?.contextUri
    player = next
    syncedAt = Date.now()
    status = ''
    failures = 0

    if (trackChanged) loadSaved()
    if (contextChanged) loadContextName()
  } catch (e) {
    if (e instanceof NotLoggedIn) {
      if (!status.startsWith('Not signed in')) window.dispatchEvent(new Event('np:signed-out'))
      status = 'Not signed in\n\nOpen this app on your phone\nto connect Spotify.'
      player = null
    } else {
      failures++
      debug('poll failed', failures, e)
    }
  }
  await updateNow()
}

function loadSaved() {
  saved = null
  const uri = player?.uri
  if (!uri || player?.kind === 'ad') return
  spotify.isSaved(uri)
    .then(v => { if (player?.uri === uri) { saved = v; void updateNow() } })
    .catch(() => {})   // missing scope after an update: just hide the heart
}

function loadContextName() {
  contextName = ''
  const uri = player?.contextUri
  if (!uri) return
  spotify.getContextName(uri)
    .then(name => { if (player?.contextUri === uri) { contextName = name; void updateNow() } })
    .catch(() => {})
}

/** Called by the phone screen after signing in or out. */
export function refreshNow() {
  status = ''
  schedulePoll(0)
}

// ---------- Input ----------
function onEvent(e: EvenHubEvent) {
  // Protobuf drops zero values, so a plain tap (CLICK_EVENT = 0) arrives with
  // eventType undefined. Default only inside the envelope that's present.
  const sys = e.sysEvent ? (e.sysEvent.eventType ?? Ev.CLICK_EVENT) : null
  const scroll = e.textEvent ? (e.textEvent.eventType ?? null) : null

  if (sys === Ev.FOREGROUND_ENTER_EVENT) {
    foreground = true
    lastNowText = ''
    schedulePoll(0)
    return
  }
  if (sys === Ev.FOREGROUND_EXIT_EVENT) { foreground = false; return }
  if (sys === Ev.SYSTEM_EXIT_EVENT || sys === Ev.ABNORMAL_EXIT_EVENT) { stop(); return }

  if (sys === Ev.DOUBLE_CLICK_EVENT) {
    if (stack.length) void navigate(pop)
    else void navigate(() => push(menuView()))
    return
  }

  if (!stack.length) {
    if (sys === Ev.CLICK_EVENT) void togglePlay()
    else if (scroll === Ev.SCROLL_BOTTOM_EVENT) void skip(prefs.swipeDownIsNext)
    else if (scroll === Ev.SCROLL_TOP_EVENT) void skip(!prefs.swipeDownIsNext)
    return
  }

  if (e.listEvent) {
    const row = stack[stack.length - 1].rows[e.listEvent.currentSelectItemIndex ?? 0]
    debug('select', row?.label)
    if (row?.run) void navigate(row.run)
  }
}

// ---------- Lifecycle ----------
let tickTimer = 0

function stop() {
  clearTimeout(pollTimer)
  clearInterval(tickTimer)
  pollTimer = tickTimer = 0
}

export async function startGlasses(): Promise<void> {
  await render()
  await serial(async b => { b.onEvenHubEvent(onEvent) })
  await pollLoop()
  tickTimer = window.setInterval(updateNow, 1000)
}
