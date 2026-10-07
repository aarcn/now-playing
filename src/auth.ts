import { store } from './bridge'

// Spotify Authorization Code + PKCE. No client secret is stored anywhere,
// so each user only needs their own Client ID.
const ACCOUNTS = 'https://accounts.spotify.com'
export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-read-recently-played',
]

export class NotLoggedIn extends Error {
  constructor() { super('Not signed in') }
}

/** The page URL without query or a trailing index.html, so /app/ and /app/index.html match. */
export function redirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '')
}

/** Spotify only accepts https redirects, or http on the loopback IPs 127.0.0.1 / [::1]. */
export function redirectProblem(): string | null {
  const { protocol, hostname, port } = location
  if (protocol === 'https:') return null
  if (protocol === 'http:' && (hostname === '127.0.0.1' || hostname === '[::1]')) return null
  if (protocol === 'http:' && hostname === 'localhost') {
    return `Spotify doesn't accept "localhost". Open http://127.0.0.1:${port || 80}${location.pathname} instead.`
  }
  return 'Spotify sign-in only works from the hosted https:// version of this app.'
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function startLogin(clientId: string): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  await store.set('client_id', clientId)
  await store.set('pkce_verifier', verifier)

  location.href = `${ACCOUNTS}/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: base64url(new Uint8Array(digest)),
  })
}

let accessToken = ''
let expiresAt = 0

async function requestToken(params: Record<string, string>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description ?? data.error ?? `Spotify sign-in error ${res.status}`)
    ;(err as any).code = data.error
    throw err
  }

  accessToken = data.access_token
  expiresAt = Date.now() + data.expires_in * 1000
  if (data.scope) await store.set('granted_scopes', data.scope)
  // Spotify rotates PKCE refresh tokens, so always keep the newest one.
  if (data.refresh_token) await store.set('refresh_token', data.refresh_token)
}

/** Call on page load. Finishes a login if Spotify just redirected back here. */
export async function finishLogin(): Promise<string | null> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const error = params.get('error')
  if (!code && !error) return null
  history.replaceState(null, '', redirectUri())
  if (error) return error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${error}`

  const clientId = await store.get('client_id')
  const verifier = await store.get('pkce_verifier')
  if (!clientId || !verifier) return 'Sign-in expired. Tap Connect again.'

  try {
    await requestToken({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    })
    await store.remove('pkce_verifier')
    return null
  } catch (e) {
    return `Spotify sign-in failed: ${(e as Error).message}`
  }
}

let refreshing: Promise<void> | null = null

async function refreshAccessToken(): Promise<void> {
  const clientId = await store.get('client_id')
  const used = await store.get('refresh_token')
  if (!clientId || !used) throw new NotLoggedIn()

  try {
    await requestToken({ grant_type: 'refresh_token', refresh_token: used, client_id: clientId })
  } catch (e) {
    if ((e as any).code !== 'invalid_grant') throw e
    // Another copy of the app (the Even app keeps a background WebView alive)
    // may have rotated the token a moment ago. Retry with the stored one first.
    const latest = await store.get('refresh_token')
    if (latest && latest !== used) {
      return requestToken({ grant_type: 'refresh_token', refresh_token: latest, client_id: clientId })
    }
    await store.remove('refresh_token')
    throw new NotLoggedIn()
  }
}

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - 30_000) return accessToken
  // One refresh at a time; parallel refreshes would burn the rotated token.
  refreshing ??= refreshAccessToken().finally(() => { refreshing = null })
  await refreshing
  return accessToken
}

export function invalidateAccessToken() {
  accessToken = ''
}

export async function isLoggedIn(): Promise<boolean> {
  return !!(await store.get('refresh_token'))
}

/** Scopes this version needs that the saved sign-in doesn't have (after an app update). */
export async function missingScopes(): Promise<string[]> {
  const granted = await store.get('granted_scopes')
  if (!granted) return []
  const have = new Set(granted.split(' '))
  return SCOPES.filter(s => !have.has(s))
}

export async function logout(): Promise<void> {
  invalidateAccessToken()
  await store.remove('refresh_token')
  await store.remove('granted_scopes')
}

// ---------- Sign-in key ----------
// Lets someone sign in from a normal browser (where Google/Apple sign-in work)
// and move that sign-in into the Even app by copy and paste.

export async function exportSignInKey(): Promise<string | null> {
  const clientId = await store.get('client_id')
  const refreshToken = await store.get('refresh_token')
  if (!clientId || !refreshToken) return null
  return `np1.${clientId}.${refreshToken}`
}

export async function importSignInKey(key: string): Promise<boolean> {
  const match = key.trim().match(/^np1\.([0-9a-f]{32})\.(\S{20,})$/i)
  if (!match) return false
  await store.set('client_id', match[1])
  await store.set('refresh_token', match[2])
  await store.remove('granted_scopes')
  invalidateAccessToken()
  try {
    await getAccessToken()
    return true
  } catch {
    return false
  }
}
