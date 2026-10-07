# Now Playing

Spotify on your Even Realities G2 glasses: see what's playing, control playback with the temple touchpad, and start any of your playlists, saved albums, recent listens, or liked songs.

## Controls

| On the glasses | Does |
|---|---|
| Tap | Play / pause |
| Swipe down / up | Next / previous track |
| Double-tap | Open the library, or go back a level |
| Library → Exit | Close the app |

## Setup (each user)

Spotify only lets a Development Mode app have 5 users, so every user connects their own free Spotify developer app:

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and tick **Web API**. Spotify Premium is required.
2. Add the Redirect URI shown in the app's phone screen (it's the URL the app is hosted at).
3. Paste the Client ID into the app and tap **Connect**.

Login uses PKCE, so no client secret is ever entered or stored.

## Develop

```bash
npm install
npm run dev                                   # Vite on :5173
npm run simulate                              # Even Hub simulator
npx evenhub qr --url https://<you>.github.io/<repo>/   # sideload the hosted build
npm run pack                                  # build now-playing.ehpk
```

Spotify login needs HTTPS (the PKCE hash uses `crypto.subtle`), so test the login on the GitHub Pages build. Pushing to `main` deploys it via `.github/workflows/pages.yml`; turn on Pages → "GitHub Actions" in the repo settings once.

## Layout

- `src/auth.ts` – PKCE login and token refresh
- `src/spotify.ts` – Web API calls (player, playlists, albums, recent, liked)
- `src/glasses.ts` – glasses screens and gesture handling
- `src/settings.ts` – phone-side setup screen
- `src/bridge.ts` – Even bridge connection, serialized calls, storage
