import { hasBridge, store } from './bridge'
import {
  exportSignInKey, importSignInKey, isLoggedIn, logout, missingScopes,
  redirectProblem, redirectUri, startLogin,
} from './auth'
import { learnNextSwipe, refreshNow } from './glasses'
import { DEFAULTS, TAP_ACTION_NAMES, onPrefsChange, prefs, savePrefs, type Prefs } from './prefs'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

function setError(message: string | null) {
  $('error').textContent = message ?? ''
}

// ---------- Home tab: connection ----------

export async function renderAccount(error: string | null = null): Promise<void> {
  const loggedIn = await isLoggedIn()
  const inEvenApp = hasBridge()
  const missing = loggedIn ? await missingScopes() : []

  $('status').textContent = loggedIn ? 'Connected to Spotify' : 'Not connected'
  $('status').dataset.ok = String(loggedIn)
  setError(error ?? redirectProblem())

  $('setup').hidden = loggedIn
  $('connected').hidden = !loggedIn
  $('reconnect').hidden = missing.length === 0
  $('key-import').hidden = !inEvenApp || loggedIn   // paste a key into the Even app
  $('key-export').hidden = !loggedIn || inEvenApp   // copy a key out of a normal browser

  // Settings stay readable when signed out, but can't be changed.
  $('settings-locked').hidden = loggedIn
  $<HTMLFieldSetElement>('settings-fields').disabled = !loggedIn

  $('redirect').textContent = redirectUri()
  $<HTMLInputElement>('client-id').value = (await store.get('client_id')) ?? ''
  $<HTMLButtonElement>('connect').disabled = !!redirectProblem()
}

async function copy(text: string, button: HTMLElement, fallbackTarget?: HTMLElement) {
  const original = button.textContent
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
  } catch {
    // Some WebViews block the clipboard API: select the text so it can be copied by hand.
    if (fallbackTarget) getSelection()?.selectAllChildren(fallbackTarget)
    button.textContent = 'Select and copy'
  }
  setTimeout(() => (button.textContent = original), 2000)
}

function bindAccount() {
  // The glasses side noticed the sign-in stopped working.
  window.addEventListener('np:signed-out', e => {
    const revoked = (e as CustomEvent).detail?.reason === 'revoked'
    void renderAccount(revoked ? 'Spotify ended your sign-in. Connect again.' : null)
  })

  $('copy').onclick = () => copy(redirectUri(), $('copy'), $('redirect'))

  $('connect').onclick = async () => {
    const clientId = $<HTMLInputElement>('client-id').value.trim()
    if (!/^[0-9a-f]{32}$/i.test(clientId)) {
      setError('That doesn\'t look like a Client ID (32 letters and numbers).')
      return
    }
    await startLogin(clientId)
  }

  $('reconnect-btn').onclick = async () => {
    const clientId = await store.get('client_id')
    if (clientId) await startLogin(clientId)
  }

  $('logout').onclick = async () => {
    await logout()
    refreshNow()
    await renderAccount()
  }

  $('use-key').onclick = async () => {
    const ok = await importSignInKey($<HTMLTextAreaElement>('key-input').value)
    if (!ok) {
      setError('That sign-in key didn\'t work. Copy a fresh one and try again.')
      return
    }
    $<HTMLTextAreaElement>('key-input').value = ''
    refreshNow()
    await renderAccount()
  }

  $('copy-key').onclick = async () => {
    const key = await exportSignInKey()
    if (!key) return
    $('key-text').textContent = key
    $('key-text').hidden = false
    await copy(key, $('copy-key'), $('key-text'))
  }
}

// ---------- Home tab: gesture guide ----------

function renderGuide() {
  const next = prefs.nextSwipe === 'down' ? 'Swipe down' : 'Swipe up'
  const back = prefs.nextSwipe === 'down' ? 'Swipe up' : 'Swipe down'
  const rows: [string, string][] = []
  if (prefs.tapLeft === prefs.tapRight) {
    rows.push(['Tap', TAP_ACTION_NAMES[prefs.tapLeft]])
  } else {
    rows.push(['Tap left arm', TAP_ACTION_NAMES[prefs.tapLeft]], ['Tap right arm', TAP_ACTION_NAMES[prefs.tapRight]])
  }
  rows.push(
    [next, 'Next song'],
    [back, prefs.backRestartsFirst ? 'Restart, or previous if near the start' : 'Previous song'],
    ['Double-tap', 'Menu: library, queue, like, shuffle, lyrics, repeat, volume, seek, devices. Double-tap again to go back.'],
  )
  if (prefs.glanceSeconds) rows.push(['Screen hidden?', 'Tap to bring it back'])

  $('guide').replaceChildren(...rows.map(([gesture, action]) => {
    const tr = document.createElement('tr')
    for (const text of [gesture, action]) {
      const td = document.createElement('td')
      td.textContent = text
      tr.append(td)
    }
    return tr
  }))
}

// ---------- Settings tab ----------

/** Turns a control's string value back into the pref's type. */
function coerce<K extends keyof Prefs>(key: K, raw: string): Prefs[K] {
  const kind = typeof DEFAULTS[key]
  return (kind === 'boolean' ? raw === 'true' : kind === 'number' ? Number(raw) : raw) as Prefs[K]
}

function renderPrefs() {
  document.querySelectorAll<HTMLElement>('[data-pref]').forEach(el => {
    const key = el.dataset.pref as keyof Prefs
    const value = String(prefs[key])
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = prefs[key] === true
    else if (el instanceof HTMLSelectElement) el.value = value
    else el.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
  })
  renderGuide()
}

function bindPrefs() {
  document.querySelectorAll<HTMLElement>('[data-pref]').forEach(el => {
    const key = el.dataset.pref as keyof Prefs
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      el.onchange = () => void savePrefs({ [key]: el.checked })
    } else if (el instanceof HTMLSelectElement) {
      el.onchange = () => void savePrefs({ [key]: coerce(key, el.value) })
    } else {
      el.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach(b => {
        b.onclick = () => void savePrefs({ [key]: coerce(key, b.dataset.value!) })
      })
    }
  })
  onPrefsChange(renderPrefs)

  $('reset-prefs').onclick = () => void savePrefs({ ...DEFAULTS })

  $('teach').onclick = async () => {
    const button = $<HTMLButtonElement>('teach')
    button.disabled = true
    button.textContent = 'Swipe now...'
    const dir = await learnNextSwipe()
    button.disabled = false
    button.textContent = 'Teach'
    $('teach-hint').textContent = dir
      ? `Got it: swipe ${dir} now skips to the next song.`
      : 'No swipe came through. Make sure the glasses show the now-playing screen and try again.'
  }

  window.addEventListener('np:art-failed', () => { $('art-note').hidden = false })

  const inEvenApp = hasBridge()
  $('settings-browser-note').hidden = inEvenApp
  $<HTMLButtonElement>('teach').disabled = !inEvenApp
}

// ---------- Tabs ----------

function bindTabs() {
  const show = (tab: string) => {
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    $('tab-home').hidden = tab !== 'home'
    $('tab-settings').hidden = tab !== 'settings'
    try { sessionStorage.setItem('np_tab', tab) } catch { /* storage blocked */ }
  }
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => { b.onclick = () => show(b.dataset.tab!) })
  let initial = 'home'
  try { initial = sessionStorage.getItem('np_tab') ?? 'home' } catch { /* storage blocked */ }
  show(initial)
}

export function bindSettings(): void {
  bindTabs()
  bindAccount()
  bindPrefs()
  renderPrefs()
}
