import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList as Ev,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { serial } from './bridge'
import { NotLoggedIn } from './auth'
import * as spotify from './spotify'
import type { Entry, Page, PlayerState } from './spotify'

// ---------- Tunables ----------
const W = 576
const H = 288
const BAR_CHARS = 20       // progress bar width; adjust after seeing it on the glasses
const POLL_MS = 3000       // how often to ask Spotify for the player state
const TICK_MS = 1000       // how often to redraw the progress bar locally
const PAGE_SIZE = 18       // list max is 20 items: "‹ Back" + 18 + "More…"
const FLASH_MS = 4000

// ---------- State ----------
type Loader = (offset: number, limit: number) => Promise<Page>
type Screen =
  | { kind: 'now' }
  | { kind: 'menu' }
  | { kind: 'list'; title: string; entries: Entry[]; hasMore: boolean; offset: number; load?: Loader }

const MENU: { label: string; run: () => Promise<void> }[] = [
  { label: 'Playlists', run: () => openList('Playlists', spotify.getPlaylists) },
  { label: 'Albums', run: () => openList('Albums', spotify.getAlbums) },
  { label: 'Recent', run: async () => showList({ kind: 'list', title: 'Recent', ...(await spotify.getRecentContexts(PAGE_SIZE)), offset: 0 }) },
  { label: 'Liked Songs', run: async () => { await spotify.playTracks(await spotify.getLikedTrackUris()); await afterPlay('Liked Songs') } },
  { label: 'Exit', run: async () => { await serial(b => b.shutDownPageContainer(1)) } },
]

let screen: Screen = { kind: 'now' }
let player: PlayerState | null = null
let syncedAt = 0           // when `player` was fetched, for local progress interpolation
let status = 'Loading…'    // replaces the now-playing view when set (logged out, errors)
let flash = ''
let flashUntil = 0
let busy = false           // ignore input while a list loads or a command runs
let lastNowText = ''
let pageCreated = false
let timers: number[] = []

// ---------- Text helpers ----------
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function progressMs(): number {
  if (!player) return 0
  const elapsed = player.isPlaying ? Date.now() - syncedAt : 0
  return Math.min(player.progressMs + elapsed, player.durationMs)
}

function nowText(): string {
  const footer = Date.now() < flashUntil ? flash : ''
  if (status) return `${status}\n\n${footer}`
  if (!player) return `Nothing playing\n\nStart Spotify on any device,\nor double-tap to pick something.\n\n${footer}`

  const pos = progressMs()
  const filled = player.durationMs ? Math.round((pos / player.durationMs) * BAR_CHARS) : 0
  const bar = '━'.repeat(filled) + '─'.repeat(BAR_CHARS - filled)
  const subtitle = [player.artist, player.album].filter(Boolean).join(' · ')

  return [
    `${player.isPlaying ? '▶' : 'II'}  ${clip(player.title, 34)}`,
    clip(subtitle, 46),
    '',
    `${mmss(pos)}  ${bar}  ${mmss(player.durationMs)}`,
    footer || (player.deviceName ? `on ${clip(player.deviceName, 30)}` : ''),
  ].join('\n')
}

// ---------- Pages ----------
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

function listPage(title: string, labels: string[]) {
  return {
    containerTotalNum: 2,
    textObject: [new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: W, height: 40,
      borderWidth: 0, paddingLength: 8,
      containerID: 1, containerName: 'title',
      content: title,
      isEventCapture: 0,
    })],
    listObject: [new ListContainerProperty({
      xPosition: 0, yPosition: 44, width: W, height: H - 44,
      borderWidth: 0,
      containerID: 2, containerName: 'list',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: labels.length,
        itemName: labels.map(l => clip(l, 48)),
        isItemSelectBorderEn: 1,
      }),
    })],
  }
}

async function showNow(): Promise<void> {
  screen = { kind: 'now' }
  lastNowText = nowText()
  const page = nowPage()
  if (!pageCreated) {
    // The Even docs say createStartUpPageContainer must be called exactly once.
    await serial(b => b.createStartUpPageContainer(new CreateStartUpPageContainer(page)))
    pageCreated = true
  } else {
    await serial(b => b.rebuildPageContainer(new RebuildPageContainer(page)))
  }
}

async function showMenu(): Promise<void> {
  screen = { kind: 'menu' }
  await serial(b => b.rebuildPageContainer(new RebuildPageContainer(listPage('Library', MENU.map(m => m.label)))))
}

async function showList(s: Extract<Screen, { kind: 'list' }>): Promise<void> {
  screen = s
  const labels = ['‹ Back', ...s.entries.map(e => e.label), ...(s.hasMore ? ['More…'] : [])]
  const title = s.offset ? `${s.title} (${s.offset + 1}–${s.offset + s.entries.length})` : s.title
  await serial(b => b.rebuildPageContainer(new RebuildPageContainer(listPage(title, labels))))
}

async function openList(title: string, load: Loader, offset = 0): Promise<void> {
  const page = await load(offset, PAGE_SIZE)
  if (!page.entries.length && offset === 0) {
    showFlash(`No ${title.toLowerCase()} found`)
    return showNow()
  }
  await showList({ kind: 'list', title, ...page, offset, load })
}

/** Redraws the now-playing text in place, only when it actually changed. */
async function updateNow(): Promise<void> {
  if (screen.kind !== 'now' || !pageCreated) return
  const text = nowText()
  if (text === lastNowText) return
  lastNowText = text
  await serial(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'now', content: text })))
}

function showFlash(message: string) {
  flash = message
  flashUntil = Date.now() + FLASH_MS
}

// ---------- Spotify sync ----------
async function refresh(): Promise<void> {
  try {
    player = await spotify.getPlayer()
    syncedAt = Date.now()
    status = ''
  } catch (e) {
    status = e instanceof NotLoggedIn
      ? 'Not signed in\n\nOpen this app on your phone\nto connect Spotify.'
      : status || 'Can’t reach Spotify'
  }
  await updateNow()
}

async function afterPlay(label: string): Promise<void> {
  showFlash(`Playing ${clip(label, 36)}`)
  await showNow()
  setTimeout(refresh, 600)
}

/** Runs an action with input locked, turning errors into a message on screen. */
async function guarded(action: () => Promise<unknown>): Promise<void> {
  if (busy) return
  busy = true
  try {
    await action()
  } catch (e) {
    showFlash(e instanceof NotLoggedIn ? 'Not signed in' : (e as Error).message)
    if (screen.kind !== 'now') await showNow()
    else await updateNow()
  } finally {
    busy = false
  }
}

function command(run: () => Promise<unknown>, optimistic?: () => void) {
  return guarded(async () => {
    optimistic?.()
    await updateNow()
    await run()
    setTimeout(refresh, 400)
  })
}

// ---------- Input ----------
function onNowInput(sys: number | null, scroll: number | null) {
  if (sys === Ev.CLICK_EVENT && player) {
    const wasPlaying = player.isPlaying
    command(wasPlaying ? spotify.pause : spotify.play, () => {
      player!.progressMs = progressMs()
      syncedAt = Date.now()
      player!.isPlaying = !wasPlaying
    })
  } else if (sys === Ev.CLICK_EVENT) {
    command(spotify.play)
  } else if (scroll === Ev.SCROLL_TOP_EVENT) {
    command(spotify.previous)
  } else if (scroll === Ev.SCROLL_BOTTOM_EVENT) {
    command(spotify.next)
  }
}

function onSelect(index: number) {
  if (screen.kind === 'menu') return guarded(MENU[index].run)
  if (screen.kind !== 'list') return

  const s = screen
  if (index === 0) return guarded(showMenu)
  if (s.hasMore && index === s.entries.length + 1) {
    return guarded(() => openList(s.title, s.load!, s.offset + PAGE_SIZE))
  }
  const entry = s.entries[index - 1]
  if (entry) guarded(async () => { await spotify.playContext(entry.uri); await afterPlay(entry.label) })
}

function onEvent(e: EvenHubEvent) {
  // Protobuf drops zero values, so a plain tap (CLICK_EVENT = 0) arrives with
  // eventType undefined. Default only inside the envelope that's present.
  const sys = e.sysEvent ? (e.sysEvent.eventType ?? Ev.CLICK_EVENT) : null
  const scroll = e.textEvent ? (e.textEvent.eventType ?? null) : null

  if (sys === Ev.FOREGROUND_ENTER_EVENT) return void refresh()
  if (sys === Ev.SYSTEM_EXIT_EVENT || sys === Ev.ABNORMAL_EXIT_EVENT) return stop()

  if (sys === Ev.DOUBLE_CLICK_EVENT) {
    // Double-tap = go up a level: list → menu → now playing → menu.
    if (screen.kind === 'list') return void guarded(showMenu)
    if (screen.kind === 'menu') return void guarded(showNow)
    return void guarded(showMenu)
  }

  if (screen.kind === 'now') return onNowInput(sys, scroll)
  if (e.listEvent) onSelect(e.listEvent.currentSelectItemIndex ?? 0)
}

// ---------- Lifecycle ----------
function stop() {
  timers.forEach(clearInterval)
  timers = []
}

export async function startGlasses(): Promise<void> {
  await showNow()
  await refresh()
  await serial(async b => { b.onEvenHubEvent(onEvent) })
  timers = [
    window.setInterval(refresh, POLL_MS),
    window.setInterval(updateNow, TICK_MS),
  ]
}
