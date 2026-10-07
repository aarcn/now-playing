import { store } from './bridge'
import { isLoggedIn, logout, redirectUri, startLogin } from './auth'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export async function renderSettings(error: string | null): Promise<void> {
  const loggedIn = await isLoggedIn()
  $('status').textContent = loggedIn ? 'Connected to Spotify' : 'Not connected'
  $('status').dataset.ok = String(loggedIn)
  $('error').textContent = error ?? ''
  $('connected').hidden = !loggedIn
  $('setup').hidden = loggedIn

  $('redirect').textContent = redirectUri()
  $<HTMLInputElement>('client-id').value = (await store.get('client_id')) ?? ''

  if (!window.isSecureContext) {
    $('error').textContent = 'Spotify login needs HTTPS. Open the hosted (https://) version of this app.'
  }
}

export function bindSettings(): void {
  $('copy').onclick = async () => {
    await navigator.clipboard.writeText(redirectUri()).catch(() => {})
    $('copy').textContent = 'Copied'
    setTimeout(() => ($('copy').textContent = 'Copy'), 1500)
  }

  $('connect').onclick = async () => {
    const clientId = $<HTMLInputElement>('client-id').value.trim()
    if (!/^[0-9a-f]{32}$/i.test(clientId)) {
      $('error').textContent = 'That doesn’t look like a Client ID (32 letters and numbers).'
      return
    }
    await startLogin(clientId)
  }

  $('logout').onclick = async () => {
    await logout()
    await renderSettings(null)
  }
}
