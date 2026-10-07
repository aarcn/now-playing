import { hasBridge, store } from './bridge'
import {
  exportSignInKey, importSignInKey, isLoggedIn, logout, missingScopes,
  redirectProblem, redirectUri, startLogin,
} from './auth'
import { prefs, refreshNow } from './glasses'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export async function loadPrefs(): Promise<void> {
  prefs.swipeDownIsNext = (await store.get('swipe_next')) !== 'up'
}

function setError(message: string | null) {
  $('error').textContent = message ?? ''
}

export async function renderSettings(error: string | null = null): Promise<void> {
  const loggedIn = await isLoggedIn()
  const inEvenApp = hasBridge()
  const missing = loggedIn ? await missingScopes() : []

  $('status').textContent = loggedIn ? 'Connected to Spotify' : 'Not connected'
  $('status').dataset.ok = String(loggedIn)
  setError(error ?? redirectProblem())

  $('setup').hidden = loggedIn
  $('connected').hidden = !loggedIn
  $('reconnect').hidden = missing.length === 0
  $('key-import').hidden = !inEvenApp || loggedIn // paste a key into the Even app
  $('key-export').hidden = !loggedIn || inEvenApp // copy a key out of a normal browser

  $('redirect').textContent = redirectUri()
  $<HTMLInputElement>('client-id').value = (await store.get('client_id')) ?? ''
  $<HTMLButtonElement>('connect').disabled = !!redirectProblem()
  $<HTMLSelectElement>('swipe').value = prefs.swipeDownIsNext ? 'down' : 'up'
}

async function copy(text: string, button: HTMLElement, fallbackTarget?: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
  } catch {
    // Some WebViews block the clipboard API: select the text so it can be copied by hand.
    if (fallbackTarget) getSelection()?.selectAllChildren(fallbackTarget)
    button.textContent = 'Select and copy'
  }
  setTimeout(() => (button.textContent = 'Copy'), 2000)
}

export function bindSettings(): void {
  // The glasses side noticed the sign-in stopped working (revoked, expired).
  window.addEventListener('np:signed-out', () => { void renderSettings('Your Spotify sign-in expired. Connect again.') })

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
    await renderSettings()
  }

  $('use-key').onclick = async () => {
    const ok = await importSignInKey($<HTMLTextAreaElement>('key-input').value)
    if (!ok) {
      setError('That sign-in key didn\'t work. Copy a fresh one and try again.')
      return
    }
    $<HTMLTextAreaElement>('key-input').value = ''
    refreshNow()
    await renderSettings()
  }

  $('copy-key').onclick = async () => {
    const key = await exportSignInKey()
    if (!key) return
    $('key-text').textContent = key
    $('key-text').hidden = false
    await copy(key, $('copy-key'), $('key-text'))
  }

  $<HTMLSelectElement>('swipe').onchange = async e => {
    const value = (e.target as HTMLSelectElement).value
    prefs.swipeDownIsNext = value !== 'up'
    await store.set('swipe_next', value)
    renderControls()
  }
  renderControls()
}

function renderControls() {
  const next = prefs.swipeDownIsNext ? 'Swipe down' : 'Swipe up'
  const prev = prefs.swipeDownIsNext ? 'Swipe up' : 'Swipe down'
  $('ctl-next').textContent = next
  $('ctl-prev').textContent = prev
}
