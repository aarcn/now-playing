import { store } from './bridge'

// Spotify Authorization Code + PKCE. No client secret is stored anywhere,
// so each user only needs their own Client ID.
const ACCOUNTS = 'https://accounts.spotify.com'
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-recently-played',
].join(' ')

export const redirectUri = () => location.origin + location.pathname

export class NotLoggedIn extends Error {}

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
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: base64url(new Uint8Array(digest)),
  })
}

async function requestToken(params: Record<string, string>): Promise<void> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const data = await res.json()
  if (!res.ok) {
    // invalid_grant = refresh token revoked or expired; the user has to log in again.
    if (data.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
      await store.remove('refresh_token')
      throw new NotLoggedIn()
    }
    throw new Error(data.error_description ?? data.error ?? `token error ${res.status}`)
  }

  accessToken = data.access_token
  expiresAt = Date.now() + data.expires_in * 1000
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
  if (error) return `Spotify login failed: ${error}`

  const clientId = await store.get('client_id')
  const verifier = await store.get('pkce_verifier')
  if (!clientId || !verifier) return 'Login expired, try again.'

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
    return `Spotify login failed: ${(e as Error).message}`
  }
}

let accessToken = ''
let expiresAt = 0
let refreshing: Promise<void> | null = null

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - 30_000) return accessToken

  // One refresh at a time; parallel refreshes would burn the rotated token.
  refreshing ??= (async () => {
    const clientId = await store.get('client_id')
    const refreshToken = await store.get('refresh_token')
    if (!clientId || !refreshToken) throw new NotLoggedIn()
    await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  })().finally(() => { refreshing = null })

  await refreshing
  return accessToken
}

export function invalidateAccessToken() {
  accessToken = ''
}

export async function isLoggedIn(): Promise<boolean> {
  return !!(await store.get('refresh_token'))
}

export async function logout(): Promise<void> {
  invalidateAccessToken()
  await store.remove('refresh_token')
}
