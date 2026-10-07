import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList as Ev,
  EventSourceType,
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
import { prefs, onPrefsChange, savePrefs, type SwipeDir, type TapAction } from './prefs'
import { ART_SIZE, cachedArt, loadArt } from './art'
import { getLyrics, lineAt, type Lyrics } from './lyrics'

// ---------- Tunables ----------
const W = 576
const H = 288
const BAR_CHAR_PX = 20        // width of one progress-bar character in the glasses font
const MAX_ROWS = 20           // firmware limit for a list
const FLASH_MS = 4000
const POLL_MS = {             // [playing, idle, glasses app in background]
  fast: [2000, 5000, 15000],
  normal: [3000, 8000, 20000],
  saver: [6000, 20000, 60000],
} as const

const debug = import.meta.env.DEV ? (...args: unknown[]) => console.debug('[np]', ...args) : () => {}

// ---------- State ----------
interface Row { label: string; run?: () => Promise<void> }   // no run = an inert note
interface View { title: string; rows: Row[] }
type Layout = 'single' | 'art' | 'hidden'

const stack: View[] = []      // empty = the now-playing screen
let player: PlayerState | null = null
let syncedAt = 0              // when `player` was fetched, for local progress
let saved: boolean | null = null
let contextName = ''
let nextUp = ''
let status = 'Connecting to Spotify...'
let failures = 0
let flash = ''
let flashUntil = 0
let foreground = true
let disconnected = false      // glasses dropped unexpectedly; poll slowly until we hear from them
let navBusy = false
let pageCreated = false

// What's currently on the glasses' now-playing screen, to update only what changed.
let shownLayout: Layout | null = null
let shown: Parts = { now: '' }

// Glance mode: hide the now-playing screen after a few quiet seconds.
let hidden = false
let wakeUntil = 0

// Album covers: what's on screen, what's loading, and covers that won't load.
let artShownUrl = ''
let artLoadingUrl = ''
let artSending = false
let artRetryAt = 0
let artLoadFailures = 0       // in a row; after 3 we stop trying until the setting is toggled
const artFailed = new Set<string>()

// Commands run one after another so rapid swipes all land. A command bumps the
// epoch so a poll that started before it can't overwrite the optimistic state,
// and holds polling briefly because Spotify takes a moment to reflect changes.
let commandChain: Promise<void> = Promise.resolve()
let commandEpoch = 0
let holdUntil = 0

// Lyrics for the current song, and a timer that fires exactly when the next line starts.
let lyrics: Lyrics | 'loading' | 'error' | null = null
let lyricTimer = 0
const LYRIC_LEAD_MS = 400     // show each line slightly early to cover Bluetooth and reading time

// "Teach" mode from the phone: the next swipe on the glasses becomes "next song".
let learnSwipe: ((dir: SwipeDir | null) => void) | null = null

// ---------- Now-playing text ----------
function progressMs(): number {
  if (!player) return 0
  const elapsed = player.isPlaying ? Date.now() - syncedAt : 0
  return Math.min(player.progressMs + elapsed, player.durationMs || Infinity)
}

const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function statusLine(p: PlayerState | null): string {
  const bits: string[] = []
  if (prefs.showClock) bits.push(clock())
  if (p) {
    if (saved) bits.push('♥')
    if (p.shuffle) bits.push('Shuffle')
    if (p.repeat === 'context') bits.push('Repeat')
    if (p.repeat === 'track') bits.push('Repeat one')
  }
  return bits.join(' · ')
}

function notice(): string {
  if (Date.now() < flashUntil) return flash
  if (failures >= 3) return 'Can\'t reach Spotify, retrying...'
  return ''
}

const isMedia = (p: PlayerState | null): p is PlayerState => !!p && (p.kind === 'track' || p.kind === 'episode')

/**
 * The two lyric lines for the screen: the line being sung (allowed to wrap to
 * two lines) and the one after it. Null when lyrics are off or not a song.
 */
function lyricBlock(currentMax: number, nextMax: number): string[] | null {
  if (!prefs.lyrics || player?.kind !== 'track') return null
  // The glasses font has no music-note symbol, so messages are in parentheses.
  if (lyrics === null || lyrics === 'loading') return ['(finding lyrics...)', '']
  if (lyrics === 'error') return ['(couldn\'t load lyrics)', '']
  if (lyrics.kind === 'none') return ['(no lyrics found)', '']
  if (lyrics.kind === 'plain') return ['(lyrics aren\'t timed for this song)', '']
  if (lyrics.kind === 'instrumental') return ['(instrumental)', '']
  const i = lineAt(lyrics.lines, progressMs() + LYRIC_LEAD_MS)
  const current = i >= 0 ? lyrics.lines[i].text : ''
  const next = lyrics.lines[i + 1]?.text ?? ''
  return [`> ${clip(current, currentMax) || '...'}`, next ? `  ${clip(next, nextMax)}` : '']
}

/** Redraws exactly when the next lyric line starts, instead of waiting for the 1 s tick. */
function scheduleLyricTick() {
  clearTimeout(lyricTimer)
  if (!prefs.lyrics || !lyrics || typeof lyrics !== 'object' || lyrics.kind !== 'synced') return
  if (!player?.isPlaying || stack.length || hidden) return
  const pos = progressMs() + LYRIC_LEAD_MS
  const next = lyrics.lines[lineAt(lyrics.lines, pos) + 1]
  if (next) lyricTimer = window.setTimeout(() => void updateNow(), Math.max(30, next.ms - pos + 15))
}

function desiredLayout(): Layout {
  if (hidden) return 'hidden'
  const p = player
  // Switch to the cover layout only once a cover is downloaded (no empty box),
  // but stay in it while the next song's cover loads (no flicker between songs).
  const artUsable = prefs.albumArt && !status && isMedia(p) && !!p.artUrl && artLoadFailures < 3 && !artFailed.has(p.artUrl)
  if (artUsable && (cachedArt(p.artUrl) || shownLayout === 'art')) return 'art'
  return 'single'
}

/** Text for each box on the now-playing screen: `now` always; `info` and `bar` in the cover layout. */
interface Parts { now: string; info?: string; bar?: string }

/** Rough pixel width of a time like "12:34" or "-1:02:05" in the glasses font. */
const timePx = (s: string) => [...s].reduce((w, c) => w + (c === ':' ? 5 : c === '-' ? 8 : 11), 0)

/**
 * "1:41  ━━━━━━━──────  5:54", sized to fit `widthPx`. The length is worked out
 * from the song's duration so the bar doesn't change size partway through.
 */
function progressLine(p: PlayerState, widthPx: number, maxChars: number): string {
  const pos = progressMs()
  const longest = mmss(p.durationMs)
  const room = widthPx - 2 * timePx(longest) - (prefs.timeLeft ? 8 : 0) - 40
  const chars = Math.max(6, Math.min(maxChars, Math.floor(room / BAR_CHAR_PX)))
  const filled = p.durationMs ? Math.round((pos / p.durationMs) * chars) : 0
  const right = prefs.timeLeft ? `-${mmss(Math.max(0, p.durationMs - pos))}` : longest
  return `${mmss(pos)}  ${'\u2501'.repeat(filled)}${'\u2500'.repeat(chars - filled)}  ${right}`
}

/** Lyrics and the "Next:" preview, shown full-width under the progress bar. */
function bottomLines(): string[] {
  const block = lyricBlock(88, 44) ?? []
  const next = prefs.showNext && nextUp ? `Next: ${nextUp}` : ''
  return [...block, next].filter(Boolean)
}

function nowContent(layout: Layout): Parts {
  if (layout === 'hidden') return { now: ' ' }
  const note = notice()
  const p = player

  if (status) return { now: [status, '', statusLine(null), note].join('\n').trimEnd() }
  if (!p) {
    return { now: ['Nothing playing', '', 'Tap to resume on your last device,', 'or double-tap to pick something.', '', note || statusLine(null)].join('\n').trimEnd() }
  }
  if (p.kind === 'ad') return { now: ['Advertisement', 'Your music will resume after this.', '', note || statusLine(p)].join('\n').trimEnd() }
  if (p.kind === 'unknown') {
    return { now: [`Ready on ${clip(p.device?.name ?? 'your device', 30)}`, 'Tap to play, double-tap for the menu.', '', note || statusLine(p)].join('\n').trimEnd() }
  }

  const icon = p.isPlaying ? '\u25B6' : 'II'
  const from = contextName && p.contextUri !== p.album?.uri ? `from ${contextName}` : ''
  // Notices ("Next >>", "Lyrics on", errors) briefly take the status line's place,
  // so they never push the progress bar or lyrics around.
  const statusOrNote = note || statusLine(p)
  const bottom = bottomLines()

  if (layout === 'art') {
    // Beside the 144 px cover: four lines of info, then the progress bar level
    // with the cover's bottom edge. Lyrics run full-width underneath.
    const third = from || (p.kind === 'track' ? p.album?.name ?? '' : '')
    return {
      info: [`${icon}  ${clip(p.title, 26) || 'Untitled'}`, clip(p.artists, 30), clip(third, 30), clip(statusOrNote, 30)].join('\n'),
      bar: progressLine(p, W - ART_TEXT_X - 12, 14),
      now: bottom.join('\n') || ' ',
    }
  }

  const subtitle = p.kind === 'episode' ? p.artists : [p.artists, p.album?.name].filter(Boolean).join(' \u00B7 ')
  return {
    now: [
      `${icon}  ${clip(p.title, 34) || 'Untitled'}`,
      clip(subtitle, 46),
      clip(from, 46),
      clip(statusOrNote, 46),
      progressLine(p, W - 2 * 16, 20),
      ...bottom,
    ].join('\n').trimEnd(),
  }
}

function showFlash(message: string) {
  flash = clip(message, 46)
  flashUntil = Date.now() + FLASH_MS
  wake()
}

function errorText(e: unknown): string {
  if (e instanceof NotLoggedIn) return 'Not signed in. Open the app on your phone'
  return e instanceof Error ? e.message : 'Something went wrong'
}

// ---------- Rendering ----------
interface PageConfig {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  imageObject?: ImageContainerProperty[]
}

function textBox(id: number, name: string, x: number, y: number, w: number, h: number, content: string, capture: boolean, padding = 16) {
  return new TextContainerProperty({
    xPosition: x, yPosition: y, width: w, height: h,
    borderWidth: 0, paddingLength: padding,
    containerID: id, containerName: name,
    content, isEventCapture: capture ? 1 : 0,
  })
}

// Cover layout geometry (measured in the simulator). The cover sits at (12, 12)
// and is 144 px square, so its bottom edge is y = 155. Text glyphs sit about
// 21 px below the top of their line, so a bar box starting at y = 133 puts the
// bar's numbers level with the cover's bottom edge.
const ART_TEXT_X = 164
const BAR_Y = 133
const BOTTOM_Y = 161

function nowPage(layout: Layout, parts: Parts): PageConfig {
  if (layout === 'hidden') {
    // An empty text box that still catches taps and swipes.
    return { containerTotalNum: 1, textObject: [textBox(1, 'now', 0, 0, W, H, ' ', true)] }
  }
  if (layout === 'art') {
    return {
      containerTotalNum: 4,
      imageObject: [new ImageContainerProperty({ xPosition: 12, yPosition: 12, width: ART_SIZE, height: ART_SIZE, containerID: 3, containerName: 'art' })],
      textObject: [
        // Four lines need 108 px plus padding; any less and the firmware adds a scrollbar.
        textBox(2, 'info', ART_TEXT_X, 2, W - ART_TEXT_X, BAR_Y - 2, parts.info ?? ' ', false, 6),
        // No padding here (it would push the bar down), so shift right 6 px to match the info text's padding.
        textBox(4, 'bar', ART_TEXT_X + 6, BAR_Y, W - ART_TEXT_X - 6, BOTTOM_Y - BAR_Y, parts.bar ?? ' ', false, 0),
        // x = 8 plus 4 px padding lines the lyrics up with the cover's left edge.
        textBox(1, 'now', 8, BOTTOM_Y, W - 8, H - BOTTOM_Y, parts.now, true, 4),
      ],
    }
  }
  return { containerTotalNum: 1, textObject: [textBox(1, 'now', 0, 0, W, H, parts.now, true)] }
}

function listPage(view: View): PageConfig {
  const rows = view.rows.slice(0, MAX_ROWS)
  return {
    containerTotalNum: 2,
    textObject: [textBox(1, 'title', 0, 0, W, 40, clip(view.title, 44), false, 8)],
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

async function rebuild(page: PageConfig): Promise<boolean> {
  try {
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
  } catch (e) {
    console.warn('[glasses] render failed:', e)
  }
  return false
}

/** One string for the debug log, top to bottom, as the tests read it. */
const logNow = (layout: Layout, c: Parts) =>
  debug('now', JSON.stringify(layout === 'hidden' ? '' : [c.info, c.bar, c.now].filter(t => t !== undefined).join('\n').trimEnd()))

async function render(): Promise<void> {
  const view = stack[stack.length - 1]
  if (view) {
    shownLayout = null
    debug('view', JSON.stringify({ title: view.title, rows: view.rows.map(r => r.label) }))
    await rebuild(listPage(view))
    return
  }
  const layout = desiredLayout()
  const content = nowContent(layout)
  shownLayout = layout
  shown = content
  artShownUrl = ''   // a rebuild clears the image box
  debug('layout', layout)
  logNow(layout, content)
  if (!(await rebuild(nowPage(layout, content)))) shownLayout = null
  if (layout === 'art') void sendArt()
  scheduleLyricTick()
}

let updating = false
let updateAgain = false

/**
 * Updates the now-playing screen in place, or rebuilds it when the layout must
 * change. One update at a time with at most one queued behind it, so a slow or
 * dropped Bluetooth link can't build a backlog. Each run diffs against what's
 * on screen, so collapsing requests loses nothing.
 */
async function updateNow(): Promise<void> {
  if (stack.length || !pageCreated || !foreground) return
  if (updating) { updateAgain = true; return }
  updating = true
  try {
    do {
      updateAgain = false
      await updateNowOnce()
    } while (updateAgain && !stack.length)
  } finally {
    updating = false
  }
  scheduleLyricTick()
}

async function updateNowOnce(): Promise<void> {
  const layout = desiredLayout()
  if (layout !== shownLayout) return render()
  if (layout === 'hidden') return

  const content = nowContent(layout)
  const boxes: [keyof Parts, number][] = layout === 'art' ? [['info', 2], ['bar', 4], ['now', 1]] : [['now', 1]]
  const changed = boxes.filter(([key]) => content[key] !== shown[key])
  if (changed.length) logNow(layout, content)
  for (const [key, id] of changed) {
    const text = content[key] ?? ' '
    shown = { ...shown, [key]: text }
    const ok = await serial(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: key, content: text }))).catch(() => false)
    if (!ok) shown = { ...shown, [key]: undefined }   // retry on the next tick
  }
  if (layout === 'art' && player?.artUrl !== artShownUrl) void sendArt()
}

/** Downloads the current song's cover in the background, then refreshes the screen. */
function prefetchArt() {
  const p = player
  const url = p?.artUrl
  if (!prefs.albumArt || !isMedia(p) || !url || artLoadFailures >= 3 || artFailed.has(url) || cachedArt(url) || url === artLoadingUrl) return
  artLoadingUrl = url
  loadArt(url)
    .then(() => { artLoadFailures = 0 })
    .catch(e => {
      debug('art load failed', url, e)
      artFailed.add(url)
      artLoadFailures++
      window.dispatchEvent(new Event('np:art-failed'))
    })
    .finally(() => {
      if (artLoadingUrl === url) artLoadingUrl = ''
      void updateNow()
    })
}

async function sendArt(): Promise<void> {
  const url = player?.artUrl
  if (!url || shownLayout !== 'art' || url === artShownUrl || artSending || Date.now() < artRetryAt) return
  const bytes = cachedArt(url)
  if (!bytes) return prefetchArt()   // the old cover stays up until this one arrives
  artSending = true
  try {
    const result = await serial(
      b => b.updateImageRawData(new ImageRawDataUpdate({ containerID: 3, containerName: 'art', imageData: bytes })),
      15_000,   // images take 0.5-2 s over Bluetooth
    )
    if (result === ImageRawDataUpdateResult.success) {
      artShownUrl = url
      debug('art shown', url)
    } else {
      artRetryAt = Date.now() + 5000
      debug('art send result', result)
    }
  } catch (e) {
    artRetryAt = Date.now() + 5000
    debug('art send failed', e)
  } finally {
    artSending = false
  }
  // The song may have changed while the image was in flight.
  if (player?.artUrl && player.artUrl !== artShownUrl && shownLayout === 'art') void sendArt()
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

// ---------- Glance mode ----------
/** Shows the now-playing screen again (if hidden) and restarts the glance timer. */
function wake() {
  wakeUntil = Date.now() + prefs.glanceSeconds * 1000
  if (!hidden) return
  hidden = false
  debug('wake')
  if (!stack.length) void render()
}

function maybeHide() {
  if (!prefs.glanceSeconds || hidden || stack.length || status || navBusy || learnSwipe) return
  if (Date.now() < wakeUntil) return
  hidden = true
  debug('hide')
  void render()
}

// ---------- Navigation ----------
async function push(view: View) {
  stack.push(view)
  await render()
}

async function pop() {
  stack.pop()
  if (!stack.length) wakeQuietly()
  await render()
}

async function home() {
  stack.length = 0
  wakeQuietly()
  await render()
}

/** Leaving the menu always lands on a visible screen. */
function wakeQuietly() {
  hidden = false
  wakeUntil = Date.now() + prefs.glanceSeconds * 1000
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
  // Like most music players: "back" restarts the song unless you're near its start.
  if (prefs.backRestartsFirst && player && progressMs() > 5000) {
    return command(() => spotify.seek(0), {
      done: 'Restarted',
      optimistic: () => { player!.progressMs = 0; syncedAt = Date.now() },
    })
  }
  showFlash('<< Previous')
  return command(spotify.previous)
}

function toggleLike() {
  const p = player
  if (!isMedia(p) || saved === null) {
    showFlash('Nothing to like right now')
    return updateNow()
  }
  return setLiked(p.uri, !saved)
}

function runTapAction(action: TapAction) {
  if (action === 'next') return skip(true)
  if (action === 'previous') return skip(false)
  if (action === 'like') return toggleLike()
  if (action === 'menu') return navigate(() => push(menuView()))
  return togglePlay()
}

// ---------- Views ----------
const more = 'More...'
const arrow = (s: string) => `${s}  >`

function menuView(): View {
  const p = player
  const playing = p && (p.kind === 'track' || p.kind === 'episode')
  const rows: Row[] = [{ label: arrow('Library'), run: () => push(libraryView()) }]

  if (playing) {
    rows.push({ label: p.isPlaying ? 'II Pause' : '\u25B6 Play', run: () => homeThen(togglePlay()) })
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
      }).then(loadNextUp)),
    })

    const nextRepeat: Record<spotify.Repeat, spotify.Repeat> = { off: 'context', context: 'track', track: 'off' }
    const repeatName: Record<spotify.Repeat, string> = { off: 'Off', context: 'All', track: 'One song' }
    rows.push(lyricsRow())
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

  if (!playing) rows.push(lyricsRow())
  rows.push({ label: arrow(p?.device ? `Device: ${clip(p.device.name, 24)}` : 'Devices'), run: async () => push(await devicesView()) })

  if (playing && p.album) rows.push({ label: arrow(`Album: ${clip(p.album.name, 28)}`), run: () => openAlbum(p.album!.uri, p.album!.name) })
  if (playing && p.artist && p.kind === 'track') rows.push({ label: arrow(`Artist: ${clip(p.artist.name, 28)}`), run: () => openArtist(p.artist!.uri, p.artist!.name) })
  if (playing && p.artist && p.kind === 'episode') rows.push({ label: arrow(`Show: ${clip(p.artist.name, 30)}`), run: () => openShow(p.artist!.uri, p.artist!.name) })

  // The system dialog may not answer until the user does, so don't wait on it.
  rows.push({ label: 'Exit', run: async () => { void serial(b => b.shutDownPageContainer(1)).catch(() => {}) } })
  return { title: 'Menu  ·  double-tap = back', rows }
}

function lyricsRow(): Row {
  return {
    label: `Lyrics: ${prefs.lyrics ? 'On' : 'Off'}`,
    run: async () => {
      const on = !prefs.lyrics
      await savePrefs({ lyrics: on })
      showFlash(on ? 'Lyrics on' : 'Lyrics off')
      await home()
    },
  }
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
        loadNextUp()
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
  const [playing, idle, background] = POLL_MS[prefs.speed]
  const limited = spotify.rateLimitedFor()
  if (limited) return limited + 250
  if (failures) return Math.min(15_000, playing * 2 ** (failures - 1))   // e.g. 3s, 6s, 12s, 15s...
  if (!foreground || disconnected) return background
  return player?.isPlaying ? playing : idle
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
    const playStateChanged = next?.isPlaying !== player?.isPlaying
    player = next
    syncedAt = Date.now()
    status = ''
    failures = 0

    if (trackChanged) { loadSaved(); loadNextUp(); prefetchArt(); loadLyrics() }
    if (contextChanged) loadContextName()
    if (trackChanged || playStateChanged) wake()
  } catch (e) {
    if (e instanceof NotLoggedIn) {
      if (!status.startsWith('Not signed in')) {
        window.dispatchEvent(new CustomEvent('np:signed-out', { detail: { reason: e.reason } }))
      }
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
  if (!uri || !isMedia(player)) return
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

/** Fetches the song after this one for the "Next:" line (only when that's switched on). */
function loadNextUp() {
  nextUp = ''
  if (!prefs.showNext || !isMedia(player)) return
  const uri = player.uri
  spotify.getQueue()
    .then(queue => {
      if (player?.uri !== uri) return
      const n = queue[0]
      nextUp = n ? clip(n.subtitle ? `${n.title} · ${n.subtitle}` : n.title, 40) : ''
      void updateNow()
    })
    .catch(() => {})
}

function loadLyrics() {
  clearTimeout(lyricTimer)
  lyrics = null
  const p = player
  if (!prefs.lyrics || p?.kind !== 'track') return
  lyrics = 'loading'
  const uri = p.uri
  getLyrics({ uri, title: p.title, artist: p.artist?.name ?? p.artists, album: p.album?.name ?? '', durationMs: p.durationMs })
    .then(found => { if (player?.uri === uri) { lyrics = found; void updateNow() } })
    .catch(e => {
      debug('lyrics failed', e)
      if (player?.uri === uri) { lyrics = 'error'; void updateNow() }
    })
}

/** Called by the phone screen after signing in or out. */
export function refreshNow() {
  status = ''
  schedulePoll(0)
}

// ---------- Settings changes from the phone ----------
onPrefsChange(changed => {
  if ('showNext' in changed) loadNextUp()
  if ('lyrics' in changed) loadLyrics()
  if ('glanceSeconds' in changed) { hidden = false; wakeUntil = Date.now() + prefs.glanceSeconds * 1000 }
  if ('albumArt' in changed) { artFailed.clear(); artLoadFailures = 0; prefetchArt() }
  if ('speed' in changed) { clearTimeout(pollTimer); pollTimer = 0; schedulePoll(nextPollDelay()) }
  void updateNow()
})

/**
 * "Teach" mode: resolves with the direction of the next swipe on the glasses
 * (and saves it as the next-song swipe), or null after `timeoutMs`.
 */
export function learnNextSwipe(timeoutMs = 20_000): Promise<SwipeDir | null> {
  learnSwipe?.(null)
  return new Promise(resolve => {
    const finish = (dir: SwipeDir | null) => {
      clearTimeout(timer)
      if (learnSwipe === finish) learnSwipe = null
      resolve(dir)
    }
    const timer = setTimeout(() => {
      finish(null)
      showFlash('Swipe setup timed out')
      void updateNow()
    }, timeoutMs)
    learnSwipe = finish
    // Swipes only reach the app on the now-playing screen.
    void (async () => {
      if (stack.length) await home()
      showFlash('Swipe the way you want for "next song"')
      await updateNow()
    })()
  })
}

// ---------- Input ----------
function onEvent(e: EvenHubEvent) {
  // Protobuf drops zero values, so a plain tap (CLICK_EVENT = 0) arrives with
  // eventType undefined. Default only inside the envelope that's present.
  const sys = e.sysEvent ? (e.sysEvent.eventType ?? Ev.CLICK_EVENT) : null
  const scroll = e.textEvent ? (e.textEvent.eventType ?? null) : null

  if (sys === Ev.FOREGROUND_ENTER_EVENT) {
    foreground = true
    if (!tickTimer) startTimers()
    schedulePoll(0)
    void render()   // the glasses may have dropped our page while we were away
    return
  }
  if (sys === Ev.FOREGROUND_EXIT_EVENT) { foreground = false; return }
  if (sys === Ev.ABNORMAL_EXIT_EVENT) {
    // An unexpected disconnect. The glasses may come back, so slow down rather than stop.
    disconnected = true
    return
  }
  disconnected = false   // any other event means they're back
  if (sys === Ev.SYSTEM_EXIT_EVENT) { stop(); return }

  if (sys === Ev.DOUBLE_CLICK_EVENT) {
    if (stack.length) void navigate(pop)
    else void navigate(() => push(menuView()))
    return
  }

  if (stack.length) {
    if (e.listEvent) {
      const row = stack[stack.length - 1].rows[e.listEvent.currentSelectItemIndex ?? 0]
      debug('select', row?.label)
      if (row?.run) void navigate(row.run)
    }
    return
  }

  // Now-playing screen.
  if (scroll === Ev.SCROLL_TOP_EVENT || scroll === Ev.SCROLL_BOTTOM_EVENT) {
    const dir: SwipeDir = scroll === Ev.SCROLL_TOP_EVENT ? 'up' : 'down'
    if (learnSwipe) {
      learnSwipe(dir)
      debug('learned', dir)
      void savePrefs({ nextSwipe: dir })
      showFlash(`Got it: swipe ${dir} = next song`)
      void updateNow()
      return
    }
    wake()
    void skip(dir === prefs.nextSwipe)
    return
  }

  if (sys === Ev.CLICK_EVENT) {
    if (hidden) { wake(); return }   // first tap just brings the screen back
    wake()
    const source = e.sysEvent?.eventSource
    const action = source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L ? prefs.tapLeft
      : source === EventSourceType.TOUCH_EVENT_FROM_RING ? 'playpause'
      : prefs.tapRight   // right arm, or glasses that don't say which arm
    debug('tap', source ?? 'unknown', action)
    void runTapAction(action)
  }
}

// ---------- Lifecycle ----------
let tickTimer = 0

function tick() {
  void updateNow()
  maybeHide()
}

function startTimers() {
  clearInterval(tickTimer)
  tickTimer = window.setInterval(tick, 1000)
}

function stop() {
  clearTimeout(pollTimer)
  clearInterval(tickTimer)
  pollTimer = tickTimer = 0
  learnSwipe?.(null)
}

export async function startGlasses(): Promise<void> {
  wakeUntil = Date.now() + prefs.glanceSeconds * 1000
  await render()
  await serial(async b => { b.onEvenHubEvent(onEvent) })
  await pollLoop()
  startTimers()
}
