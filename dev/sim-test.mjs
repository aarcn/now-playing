// End-to-end tests: drives the Even simulator (started with --automation-port)
// running dev/mock.html, and checks the app's debug log and API calls.
//
//   npm run dev -- --host 127.0.0.1
//   evenhub-simulator "http://127.0.0.1:5173/dev/mock.html?scenario=default" --automation-port 9898
//   node dev/sim-test.mjs default
//
// Scenarios: default (UI flows), faults (error handling), logged-out,
// settings (every setting switched on), settings-ui (clicks through the phone settings page).

import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = `http://127.0.0.1:${process.env.SIM_PORT ?? 9898}`
const SHOTS = process.env.SHOTS ?? 'dev/shots'
const scenario = process.argv[2] ?? 'default'
mkdirSync(SHOTS, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let lastId = -1
let log = []   // all console entries seen so far

async function poll() {
  const url = lastId >= 0 ? `${BASE}/api/console?since_id=${lastId}` : `${BASE}/api/console`
  const { entries } = await (await fetch(url)).json()
  for (const e of entries) { log.push(e); lastId = Math.max(lastId, e.id) }
}

async function input(action, times = 1) {
  for (let i = 0; i < times; i++) {
    await fetch(`${BASE}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    await sleep(times > 1 ? 120 : 250)
  }
}

async function shot(name) {
  const res = await fetch(`${BASE}/api/screenshot/glasses`)
  writeFileSync(`${SHOTS}/${scenario}-${name}.png`, Buffer.from(await res.arrayBuffer()))
}

const mark = () => log.length
const since = m => log.slice(m)
const api = m => since(m).filter(e => e.message.startsWith('[api] ')).map(e => e.message.slice(6))
const views = m => since(m).filter(e => e.message.startsWith('[np] view ')).map(e => JSON.parse(e.message.slice(10)))
const nows = m => since(m).filter(e => e.message.startsWith('[np] now ')).map(e => JSON.parse(e.message.slice(9)))
const lastView = () => views(0).at(-1)
const lastNow = () => nows(0).at(-1) ?? ''

async function waitFor(pred, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await poll()
    const v = pred()
    if (v) return v
    await sleep(150)
  }
  return null
}

let failed = 0
async function step(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${e.message}`)
    await shot(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {})
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

/** Moves the list cursor to the row whose label matches, then taps it. */
async function select(match) {
  const view = await waitFor(() => lastView())
  const i = view.rows.findIndex(r => (match instanceof RegExp ? match.test(r) : r.startsWith(match)))
  assert(i >= 0, `no row matching ${match} in ${JSON.stringify(view.rows)}`)
  await input('down', i)
  await sleep(150)
  await input('click')
}

async function waitView(title, timeout = 5000) {
  const v = await waitFor(() => { const v = lastView(); return v && (title instanceof RegExp ? title.test(v.title) : v.title.startsWith(title)) ? v : null }, timeout)
  assert(v, `expected view "${title}", last view: ${JSON.stringify(lastView()?.title)}`)
  return v
}

async function backHome() {
  for (let i = 0; i < 6; i++) {
    await poll()
    const lastNav = log.filter(e => /^\[np\] (view|now) /.test(e.message)).at(-1)
    // On the now screen the latest render is a "now" line that came after the last "view".
    const lastViewIdx = log.findLastIndex(e => e.message.startsWith('[np] view '))
    const lastHomeIdx = log.findLastIndex(e => e.message.startsWith('[np] now '))
    if (lastNav && lastHomeIdx > lastViewIdx) return
    await input('double_click')
    await sleep(500)
  }
}

// ---------------------------------------------------------------------------
async function defaultScenario() {
  await step('startup shows song, context, like and device', async () => {
    const t = await waitFor(() => /from Chill Vibes/.test(lastNow()) && lastNow().includes('♥') && lastNow())
    assert(t, `now text was ${JSON.stringify(lastNow())}`)
    assert(t.startsWith('▶  Bohemian Rhapsody'), 'title line')
    assert(t.includes("Aaron's iPhone"), 'curly apostrophe in device name should become ASCII')
    await shot('01-now')
  })

  await step('tap pauses immediately and a poll does not flip it back', async () => {
    const m = mark()
    await input('click')
    assert(await waitFor(() => nows(m).some(t => t.startsWith('II'))), 'no optimistic pause')
    assert(await waitFor(() => api(m).includes('PUT /me/player/pause')), 'pause not sent')
    await sleep(4500)
    await poll()
    assert(!nows(m).slice(1).some(t => t.startsWith('▶')), `flipped back to playing: ${JSON.stringify(nows(m).map(t => t.slice(0, 3)))}`)
    await shot('02-paused')
    await input('click')
    await waitFor(() => api(m).includes('PUT /me/player/play'))
  })

  await step('three fast swipes skip three songs', async () => {
    const m = mark()
    await input('down', 3)
    await waitFor(() => api(m).filter(c => c === 'POST /me/player/next').length === 3, 6000)
    const n = api(m).filter(c => c === 'POST /me/player/next').length
    assert(n === 3, `expected 3 next calls, got ${n}`)
    assert(await waitFor(() => lastNow().includes('道 (Michi)')), `now: ${JSON.stringify(lastNow())}`)
  })

  await step('swipe up near the start goes to the previous song', async () => {
    const m = mark()
    await input('up')
    assert(await waitFor(() => api(m).includes('POST /me/player/previous')), `calls: ${api(m)}`)
    assert(await waitFor(() => lastNow().includes("Don't Stop Me Now")), `curly quote should render as ': ${lastNow()}`)
  })

  await step('swipe up mid-song restarts it instead', async () => {
    await sleep(6000)
    const m = mark()
    await input('up')
    assert(await waitFor(() => api(m).includes('PUT /me/player/seek?position_ms=0')), `calls: ${api(m)}`)
    assert(await waitFor(() => nows(m).some(t => t.includes('Restarted'))), 'no "Restarted" notice')
  })

  await step('double-tap opens the menu with every control', async () => {
    await input('double_click')
    const v = await waitView('Menu')
    const want = ['Library', 'Up next', '♥ Liked', 'Shuffle: Off', 'Repeat: Off', 'Volume: set on', 'Seek', 'Device:', 'Album:', 'Artist:', 'Exit']
    for (const w of want) assert(v.rows.some(r => r.startsWith(w)), `missing "${w}" in ${JSON.stringify(v.rows)}`)
    await shot('03-menu')
  })

  await step('shuffle toggle goes home and shows in the status line', async () => {
    const m = mark()
    await select('Shuffle: Off')
    assert(await waitFor(() => api(m).includes('PUT /me/player/shuffle?state=true')), `calls: ${api(m)}`)
    assert(await waitFor(() => /Shuffle  ·/.test(lastNow())), `now: ${JSON.stringify(lastNow())}`)
  })

  await step('repeat cycles off -> all', async () => {
    await input('double_click'); await waitView('Menu')
    const m = mark()
    await select('Repeat: Off')
    assert(await waitFor(() => api(m).includes('PUT /me/player/repeat?state=context')), `calls: ${api(m)}`)
    assert(await waitFor(() => lastNow().includes('Repeat')), 'status line')
  })

  await step('unlike the current song from the menu', async () => {
    await input('double_click'); await waitView('Menu')
    const m = mark()
    await select('♥ Liked')
    assert(await waitFor(() => api(m).some(c => c.startsWith('DELETE /me/library?uris='))), `calls: ${api(m)}`)
    assert(await waitFor(() => nows(m).some(t => t.includes('Removed from Liked Songs'))), 'notice')
  })

  await step('playlists: emoji names cleaned, all-emoji name gets a fallback, paging works', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    await select('Playlists')
    const v = await waitView('Playlists')
    assert(v.rows.includes('Gym Bangers'), `emoji not stripped: ${JSON.stringify(v.rows)}`)
    assert(v.rows.includes('Untitled playlist'), 'all-emoji playlist fallback')
    assert(v.rows.includes("Road Trip - Summer '24"), 'dash/quote normalization')
    assert(v.rows.at(-1) === 'More...' && v.rows.length === 20, `rows: ${v.rows.length}`)
    await shot('04-playlists')
    await select('More...')
    const p2 = await waitView(/^Playlists  \(20-25\)$/)
    assert(!p2.rows.includes('More...'), 'last page should have no More')
    await input('double_click')
    await waitView(/^Playlists$/)
  })

  await step('a followed playlist shows play rows and explains the missing track list', async () => {
    await select('Discover Weekly')
    const v = await waitView('Discover Weekly')
    assert(v.rows[0] === '▶ Play' && v.rows[1] === '▶ Shuffle play', JSON.stringify(v.rows))
    assert(v.rows.some(r => r.includes('only shares track lists')), 'explanation row')
    await input('double_click'); await waitView(/^Playlists$/)
  })

  await step('a collaborative playlist lists its tracks', async () => {
    await select("Road Trip")
    const v = await waitView("Road Trip")
    assert(v.rows.length > 3 && v.rows.some(r => r.includes('A Song With An')), JSON.stringify(v.rows))
    assert(v.rows.every(r => r.length <= 45), 'long titles clipped')
    await input('double_click'); await waitView(/^Playlists$/)
  })

  await step('track actions: queue a song and come back to the list', async () => {
    await select('Chill Vibes')
    await waitView('Chill Vibes')
    await select('Redbone')
    const sheet = await waitView('Redbone')
    for (const w of ['▶ Play', '+ Add to queue', '♡ Like', 'Album:', 'Artist:']) assert(sheet.rows.some(r => r.startsWith(w)), `missing ${w}: ${JSON.stringify(sheet.rows)}`)
    await shot('05-track')
    const m = mark()
    await select('+ Add to queue')
    assert(await waitFor(() => api(m).some(c => c.startsWith('POST /me/player/queue?uri=spotify%3Atrack%3At2'))), `calls: ${api(m)}`)
    await waitView('Chill Vibes')
    assert(await waitFor(() => since(m).some(e => e.message.startsWith('[np] notice Queued: Redbone'))), 'queued notice')
  })

  await step('local files are shown but not selectable', async () => {
    const v = lastView()
    assert(v.rows.some(r => r.endsWith('(unavailable)')), JSON.stringify(v.rows))
  })

  await step('play a specific song in its playlist', async () => {
    await select('Bohemian')
    await waitView('Bohemian Rhapsody')
    const m = mark()
    await select('▶ Play')
    assert(await waitFor(() => api(m).includes('PUT /me/player/play')), `calls: ${api(m)}`)
    assert(await waitFor(() => nows(m).some(t => t.includes('Playing Bohemian Rhapsody'))), 'playing notice')
  })

  await step('up next lists the queue; tapping skips ahead', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Up next')
    const v = await waitView('Up next')
    assert(v.rows[0].startsWith('Redbone'), `queued song should be first: ${JSON.stringify(v.rows)}`)
    const m = mark()
    await input('down', 2); await sleep(150); await input('click')
    await waitFor(() => api(m).filter(c => c === 'POST /me/player/next').length === 3, 6000)
    assert(api(m).filter(c => c === 'POST /me/player/next').length === 3, `calls: ${api(m)}`)
  })

  await step('devices: move playback to the MacBook, then volume works', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Device:')
    const v = await waitView('Play on')
    assert(v.rows.some(r => r.includes('Kitchen Speaker (no remote)')), 'restricted device marked')
    await shot('06-devices')
    const m = mark()
    await select(/MacBook/)
    assert(await waitFor(() => api(m).includes('PUT /me/player')), `calls: ${api(m)}`)
    assert(await waitFor(() => lastNow().includes('MacBook Pro 50%')), `now: ${lastNow()}`)
    await input('double_click'); await waitView('Menu')
    await select('Volume: 50%')
    await waitView('Volume')
    const m2 = mark()
    await select('Louder')
    assert(await waitFor(() => api(m2).includes('PUT /me/player/volume?volume_percent=60')), `calls: ${api(m2)}`)
    assert(await waitFor(() => lastNow().includes('MacBook Pro 60%')), `now: ${lastNow()}`)
  })

  await step('seek forward 30 s', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Seek'); await waitView('Seek')
    const m = mark()
    await select('Forward 30 s')
    assert(await waitFor(() => api(m).some(c => c.startsWith('PUT /me/player/seek?position_ms='))), `calls: ${api(m)}`)
  })

  await step('recently played names Spotify-made mixes by a song from them', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    await select('Recently played')
    const v = await waitView('Recently played')
    assert(v.rows.includes('Chill Vibes') && v.rows.includes('A Night at the Opera') && v.rows.includes('Childish Gambino'), JSON.stringify(v.rows))
    assert(v.rows.some(r => r.startsWith('Mix with "Redbone"')), JSON.stringify(v.rows))
    assert(!v.rows.some(r => /collection/.test(r)), 'Liked Songs context should be skipped')
    await input('double_click'); await waitView('Library')
  })

  await step('artists page through with cursors and open an artist', async () => {
    await select('Artists')
    const v = await waitView('Artists')
    assert(v.rows.at(-1) === 'More...', JSON.stringify(v.rows))
    await select('Queen')
    const a = await waitView('Queen')
    assert(a.rows[0] === '▶ Play artist' && a.rows.some(r => r.startsWith('A Night at the Opera')), JSON.stringify(a.rows))
    await input('double_click'); await waitView('Artists')
    await select('More...')
    await waitView(/^Artists  \(20-25\)$/)
    await input('double_click'); await waitView(/^Artists$/)
    await input('double_click'); await waitView('Library')
  })

  await step('podcasts resume an episode where you left off', async () => {
    await select('Podcasts'); await waitView('Podcasts')
    await select('The Daily Thing')
    const v = await waitView('The Daily Thing')
    assert(v.rows.some(r => r.endsWith('resume')) && v.rows.some(r => r.endsWith('played')), JSON.stringify(v.rows))
    const m = mark()
    await select(/resume$/)
    assert(await waitFor(() => api(m).includes('PUT /me/player/play')), 'play')
    assert(await waitFor(() => lastNow().startsWith('▶  Episode 4')), `now: ${lastNow()}`)
    await shot('07-episode')
  })

  await step('episode menu offers the show instead of album/artist', async () => {
    await input('double_click')
    const v = await waitView('Menu')
    assert(v.rows.some(r => r.startsWith('Show: The Daily Thing')), JSON.stringify(v.rows))
    assert(!v.rows.some(r => r.startsWith('Album:')), 'no album row for episodes')
    await input('double_click')
  })

  await step('liked songs shuffle plays a random window on shuffle', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    await select('Liked Songs')
    const v = await waitView('Liked Songs')
    assert(v.rows[0] === '▶ Play' && v.rows.length === 20, `rows ${v.rows.length}`)
    const m = mark()
    await select('▶ Shuffle play')
    assert(await waitFor(() => api(m).includes('PUT /me/player/play') && api(m).some(c => c.startsWith('PUT /me/player/shuffle?state=true'))), `calls: ${api(m)}`)
    assert(await waitFor(() => !lastNow().includes('Episode') && /^\u25B6  /.test(lastNow())), `screen never switched to a liked song: ${lastNow()}`)
    await shot('08-after-liked')
  })

  await step('exit asks for confirmation', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Exit')
    await sleep(800)
    await shot('09-exit')
  })
}

async function faultsScenario() {
  await step('nothing active: shows the empty state', async () => {
    assert(await waitFor(() => lastNow().startsWith('Nothing playing')), `now: ${lastNow()}`)
  })

  await step('tap with no active device picks one and plays', async () => {
    const m = mark()
    await input('click')
    assert(await waitFor(() => api(m).includes('GET /me/player/devices') && api(m).some(c => c === 'PUT /me/player/play?device_id=iphone')), `calls: ${api(m)}`)
    assert(await waitFor(() => lastNow().startsWith('▶  Bohemian'), 6000), `now: ${lastNow()}`)
  })

  await step('rate limit: waits out Retry-After and keeps the song on screen', async () => {
    const hit = await waitFor(() => log.find(e => e.message.startsWith('[fault] GET /me/player?')), 15000)
    assert(hit, 'rate limit fault never triggered')
    const at = hit.ts
    await sleep(5000)
    await poll()
    const polls = log.filter(e => e.message.startsWith('[api] GET /me/player?') && e.ts > at)
    assert(polls.length >= 1 && polls[0].ts - at >= 3900, `next poll came after ${polls[0] ? polls[0].ts - at : 'never'} ms`)
    assert(lastNow().includes('Bohemian'), 'song should stay visible')
  })

  await step('connection drops: song stays, notice appears, recovers', async () => {
    assert(await waitFor(() => lastNow().includes('Can\'t reach Spotify'), 40000), `now: ${lastNow()}`)
    assert(lastNow().includes('Bohemian'), 'song should stay visible while offline')
    await shot('offline')
    assert(await waitFor(() => !lastNow().includes('Can\'t reach') && lastNow().includes('Bohemian'), 40000), 'did not recover')
  })

  await step('502 page is retried once transparently', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    const m = mark()
    await select('Playlists')
    await waitView('Playlists', 8000)
    assert(api(m).filter(c => c.startsWith('GET /me/playlists')).length === 2, `calls: ${api(m)}`)
    await backHome()
  })

  await hangScenarioSteps()

  await step('expired access token + rotated refresh token: recovers without logging out', async () => {
    await input('double_click'); await waitView('Menu')
    const m = mark()
    await select('Up next')
    await waitView('Up next', 8000)
    const tokenCalls = api(m).filter(c => c === 'POST /api/token').length
    assert(tokenCalls === 2, `expected a rejected and a successful refresh, got ${tokenCalls}: ${api(m)}`)
    assert(api(m).filter(c => c === 'GET /me/player/queue').length === 2, 'queue retried after refresh')
    await backHome()
    await sleep(3500); await poll()
    assert(!lastNow().startsWith('Not signed in'), 'user was logged out')
  })
}

async function hangScenarioSteps() {
  await step('a request that never answers times out and the app stays usable', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    const m = mark()
    await select('Albums')
    assert(await waitFor(() => since(m).some(e => e.message === '[np] notice Loading...'), 3000), 'no loading hint')
    const notice = await waitFor(() => since(m).find(e => e.message.startsWith('[np] notice Spotify took too long')), 14000)
    assert(notice, 'no timeout notice')
    const polls = await waitFor(() => api(m).filter(c => c.startsWith('GET /me/player?')).length >= 2 && true, 8000)
    assert(polls, 'polling stopped while the request hung')
    // The list wasn't rebuilt, so the cursor is still on Albums: tap again to retry.
    await input('click')
    await waitView('Albums', 6000)
    await backHome()
  })
}

async function settingsScenario() {
  const lines = m => since(m).map(e => e.message)

  await step('cover layout: waits for the cover, then shows it beside the song', async () => {
    assert(await waitFor(() => log.some(e => e.message === '[np] art shown https://i.scdn.co/image/opera-300'), 8000), 'cover never shown')
    const layouts = log.filter(e => e.message.startsWith('[np] layout ')).map(e => e.message.slice(12))
    assert(layouts[0] === 'single' && layouts[1] === 'art', `expected text first, then the cover once downloaded: ${layouts}`)
    if (layouts.at(-1) === 'art') await shot('01-cover')
  })

  await step('next-song preview, time left and clock are on screen', async () => {
    // Read from history: glance mode may already have hidden the screen.
    const t = await waitFor(() => nows(0).find(n => n.includes('Next: Redbone')))
    assert(t, `now: ${JSON.stringify(lastNow())}`)
    assert(/  -\d+:\d\d/.test(t), 'time left (-m:ss) missing')
    assert(/\d{1,2}:\d{2}(\s?[AP]M)?  \u00B7/.test(t), `clock missing: ${JSON.stringify(t)}`)
  })

  await step('glance mode hides the screen after 5 quiet seconds', async () => {
    assert(await waitFor(() => log.some(e => e.message === '[np] hide'), 9000), 'never hid')
    assert(lastNow() === '', `screen should be blank, got ${JSON.stringify(lastNow())}`)
    await shot('02-hidden')
  })

  await step('a tap while hidden only brings the screen back', async () => {
    const m = mark()
    await input('click')
    assert(await waitFor(() => lines(m).includes('[np] wake')), 'no wake')
    await sleep(1500); await poll()
    const commands = api(m).filter(c => !c.startsWith('GET ') && c !== 'POST /api/token')
    assert(!commands.length, `tap while hidden should not control playback: ${commands}`)
    assert(lastNow().includes('Bohemian'), 'song visible again')
  })

  await step('right-arm tap is mapped to "next song"', async () => {
    const m = mark()
    await input('click')
    assert(await waitFor(() => api(m).includes('POST /me/player/next')), `calls: ${api(m)}`)
    assert(lines(m).some(l => /^\[np\] tap .* next$/.test(l)), 'tap action log')
    assert(await waitFor(() => log.some(e => e.message === '[np] art shown https://i.scdn.co/image/awaken-300'), 8000), 'new cover not sent')
  })

  await step('swipe up is "next" when set that way', async () => {
    const m = mark()
    await input('up')
    assert(await waitFor(() => api(m).includes('POST /me/player/next')), `calls: ${api(m)}`)
    assert(await waitFor(() => lastNow().includes("Don't Stop")), `now: ${lastNow()}`)
  })

  await step('"always go back" skips the restart even mid-song', async () => {
    await sleep(6000)
    const m = mark()
    await input('down')
    assert(await waitFor(() => api(m).includes('POST /me/player/previous')), `calls: ${api(m)}`)
    assert(!api(m).some(c => c.startsWith('PUT /me/player/seek')), 'should not restart')
  })

  await step('a song whose cover fails falls back to the text layout', async () => {
    const m = mark()
    await input('up'); await sleep(1800); await input('up')
    assert(await waitFor(() => lastNow().includes('道 (Michi)'), 8000), `now: ${lastNow()}`)
    assert(await waitFor(() => lines(m).some(l => l.startsWith('[np] art load failed')), 6000), 'no failure logged')
    assert(await waitFor(() => log.filter(e => e.message.startsWith('[np] layout ')).at(-1)?.message === '[np] layout single', 6000), 'still in cover layout')
    await shot('03-cover-failed')
  })
}

async function settingsUiScenario() {
  const ui = prefix => waitFor(() => log.find(e => e.message.startsWith(`[ui] ${prefix}`))?.message, 15000)

  await step('settings tab opens', async () => {
    assert((await ui('settings tab visible')) === '[ui] settings tab visible true', 'tab state')
  })

  await step('album cover toggle saves and switches the glasses layout', async () => {
    assert((await ui('albumArt saved')) === '[ui] albumArt saved true', 'not saved')
    assert(await waitFor(() => log.some(e => e.message === '[np] layout art'), 8000), 'glasses did not switch')
    await shot('01-cover-on')
  })

  await step('next-song swipe buttons save and show as selected', async () => {
    assert((await ui('nextSwipe saved')) === '[ui] nextSwipe saved up true', await ui('nextSwipe saved'))
  })

  await step('left-arm tap select saves and updates the gesture guide', async () => {
    assert((await ui('tapLeft saved')) === '[ui] tapLeft saved like', 'not saved')
    const g = await ui('guide')
    assert(g.includes('Tap left armLike / unlike') && g.includes('Tap right armPlay / pause') && g.includes('Swipe upNext song'), g)
  })

  await step('glance mode setting saves', async () => {
    assert((await ui('glance saved')) === '[ui] glance saved 10', 'not saved')
  })

  await step('Teach: the next swipe on the glasses becomes "next song"', async () => {
    assert(await ui('teach waiting'), 'teach never started')
    assert(await waitFor(() => lastNow().includes('Swipe the way you want'), 5000), `glasses prompt missing: ${lastNow()}`)
    const m = mark()
    await input('down')
    assert(await waitFor(() => log.some(e => e.message === '[np] learned down')), 'not learned')
    const result = await ui('teach result')
    assert(result.includes('Got it: swipe down') && result.endsWith('down'), result)
    assert(!api(m).includes('POST /me/player/next'), 'the teaching swipe should not also skip')
  })

  await step('reset restores defaults and the text layout', async () => {
    const r = await ui('reset')
    const saved = JSON.parse(r.slice('[ui] reset '.length))
    assert(saved.albumArt === false && saved.nextSwipe === 'down' && saved.tapLeft === 'playpause' && saved.glanceSeconds === 0, r)
    assert(await waitFor(() => log.filter(e => e.message.startsWith('[np] layout ')).at(-1)?.message === '[np] layout single', 6000), 'layout not reset')
  })

  await step('settings page screenshot', async () => {
    const res = await fetch(`${BASE}/api/screenshot/webview`)
    writeFileSync(`${SHOTS}/${scenario}-phone.png`, Buffer.from(await res.arrayBuffer()))
  })
}

async function loggedOutScenario() {
  await step('a revoked sign-in tells the user to reconnect on the phone', async () => {
    assert(await waitFor(() => lastNow().startsWith('Not signed in')), `now: ${lastNow()}`)
    await shot('logged-out')
  })
  await step('menu still opens; library explains why it cannot load', async () => {
    await input('double_click'); await waitView('Menu')
    await select('Library'); await waitView('Library')
    const m = mark()
    await select('Playlists')
    assert(await waitFor(() => since(m).some(e => e.message.startsWith('[np] notice Not signed in'))), 'notice')
  })
}

// ---------------------------------------------------------------------------
console.log(`scenario: ${scenario}`)
await waitFor(() => log.some(e => e.message.startsWith('[np] now ')), 15000)
await ({ default: defaultScenario, faults: faultsScenario, 'logged-out': loggedOutScenario, settings: settingsScenario, 'settings-ui': settingsUiScenario })[scenario]()
await poll()
const errors = log.filter(e => e.level === 'error' || e.message.startsWith('[uncaught]') || e.message.startsWith('[unhandledrejection]'))
if (errors.length) { failed++; console.log('  FAIL uncaught errors:\n       ' + errors.map(e => e.message).join('\n       ')) }
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
