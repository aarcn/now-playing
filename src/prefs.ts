import { store } from './bridge'

export type SwipeDir = 'up' | 'down'
export type TapAction = 'playpause' | 'next' | 'previous' | 'like' | 'menu'
export type Speed = 'fast' | 'normal' | 'saver'

export interface Prefs {
  nextSwipe: SwipeDir         // the swipe that skips forward; the other goes back
  backRestartsFirst: boolean  // swipe back restarts the song unless you're in its first 5 s
  tapLeft: TapAction          // taps report which arm they came from (swipes don't)
  tapRight: TapAction
  albumArt: boolean
  showClock: boolean
  timeLeft: boolean           // show time remaining instead of the song's length
  lyrics: boolean             // time-synced lyrics from LRCLIB on the now-playing screen
  glanceSeconds: number       // 0 = always on; otherwise hide the screen after this many seconds
  speed: Speed                // how often to ask Spotify for updates
}

export const DEFAULTS: Prefs = {
  nextSwipe: 'down',
  backRestartsFirst: true,
  tapLeft: 'playpause',
  tapRight: 'playpause',
  albumArt: false,
  showClock: false,
  timeLeft: false,
  lyrics: false,
  glanceSeconds: 0,
  speed: 'normal',
}

const ALLOWED: { [K in keyof Prefs]?: readonly Prefs[K][] } = {
  nextSwipe: ['up', 'down'],
  tapLeft: ['playpause', 'next', 'previous', 'like', 'menu'],
  tapRight: ['playpause', 'next', 'previous', 'like', 'menu'],
  glanceSeconds: [0, 5, 10, 30],
  speed: ['fast', 'normal', 'saver'],
}

/** The live settings object both the glasses and the phone screen read. */
export const prefs: Prefs = { ...DEFAULTS }

const KEY = 'prefs_v1'
type Listener = (changed: Partial<Prefs>) => void
const listeners = new Set<Listener>()

/** Keeps only known keys with the right type and an allowed value. */
function sanitize(raw: unknown): Partial<Prefs> {
  const out: Partial<Prefs> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== typeof DEFAULTS[key]) continue
    const allowed = ALLOWED[key] as readonly unknown[] | undefined
    if (allowed && !allowed.includes(value)) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

export async function loadPrefs(): Promise<void> {
  let stored: Partial<Prefs> = {}
  try {
    stored = sanitize(JSON.parse((await store.get(KEY)) ?? '{}'))
  } catch {
    // Corrupt JSON: fall back to defaults rather than failing to start.
  }
  // v0.2 kept only the swipe direction, under its own key.
  if (!stored.nextSwipe && (await store.get('swipe_next')) === 'up') stored.nextSwipe = 'up'
  Object.assign(prefs, DEFAULTS, stored)
}

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const clean = sanitize(patch)
  const changed: Partial<Prefs> = {}
  for (const key of Object.keys(clean) as (keyof Prefs)[]) {
    if (prefs[key] !== clean[key]) (changed as Record<string, unknown>)[key] = clean[key]
  }
  if (!Object.keys(changed).length) return
  Object.assign(prefs, changed)
  listeners.forEach(fn => fn(changed))
  await store.set(KEY, JSON.stringify(prefs))
}

export function onPrefsChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const TAP_ACTION_NAMES: Record<TapAction, string> = {
  playpause: 'Play / pause',
  next: 'Next song',
  previous: 'Previous song',
  like: 'Like / unlike',
  menu: 'Open the menu',
}
