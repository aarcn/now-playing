# Now Playing

Spotify for the Even Realities G2: what's playing at a glance, gestures for the everyday stuff, and a menu that reaches your whole library and every playback control.

## On the glasses

| Gesture | Does |
|---|---|
| Tap | Play / pause |
| Swipe down | Next song (flip it on the phone screen if you prefer swipe up) |
| Swipe up | Restart the song, or go to the previous one if you're in the first 5 seconds |
| Double-tap | Open the menu; double-tap again to go back a level |

The now-playing screen shows the song, artist and album, the playlist or album it's playing from, a progress bar, and whether it's liked, shuffle/repeat state, and the device and its volume.

**Menu**

- **Library**: Playlists, Albums, Artists, Podcasts, Liked Songs, Recently played
  - Every playlist, album and artist opens with **Play** and **Shuffle play**, then its songs.
  - Tap a song for **Play from here**, **Add to queue**, **Like/Unlike**, **Go to album**, **Go to artist**.
  - Podcasts resume episodes where you left off.
- **Up next**: see the queue, tap a song to skip ahead to it
- **Like / Unlike** the current song or episode
- **Shuffle** on/off, **Repeat** off / all / one song
- **Volume**: louder, quieter, or a preset (when the device allows remote volume)
- **Seek**: restart, back/forward 10 or 30 seconds
- **Device**: move playback to any Spotify Connect device
- **Album / Artist / Show** of what's playing
- **Exit**

## Setup (each user)

Spotify only lets a Development Mode app have 5 users, so each user connects their own free Spotify developer app:

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and tick **Web API**. Spotify Premium is required.
2. Add the Redirect URI shown on the app's phone screen.
3. Paste the Client ID and tap **Connect**.

Sign-in uses PKCE, so no client secret is ever entered or stored.

**Google / Apple / Facebook sign-in** doesn't work inside the Even app's WebView (those providers block embedded sign-in). Either choose Spotify's email-code login, or open the app's URL in your phone's browser, connect there, tap **Copy sign-in key**, and paste it under **Sign-in key** in the Even app.

## Known limits (Spotify's rules, not bugs)

- **Followed playlists** (other people's, Daily Mix, Discover Weekly) can be played and shuffled, but Spotify doesn't share their track lists with Development Mode apps.
- **Liked Songs** can't be played as one big context through the API, so Play starts the newest 50 and Shuffle plays a random 50-song stretch of your library.
- **Search** isn't included: the glasses have no keyboard and voice input would need a paid speech-to-text service.
- **Volume** is unavailable on devices that block remote volume (iPhones, mostly).

## Develop

```bash
npm install
npm run dev                      # Vite on :5173
npm run pack                     # build and pack now-playing.ehpk
npx evenhub qr --url https://<you>.github.io/<repo>/   # sideload the hosted build
```

Spotify sign-in needs HTTPS, or `http://127.0.0.1` locally (Spotify rejects `localhost`). Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`; turn on Pages → "GitHub Actions" once in the repo settings.

### Testing without a Spotify account

`dev/mock-spotify.ts` is a stateful fake of the Spotify API (playlists with emoji names, followed playlists, devices, queue, podcasts), including the delay Spotify has before reporting changes. `dev/mock.html` runs the real app against it.

```bash
npm test                                     # text sanitizer unit tests
npm run mock                                 # serves http://127.0.0.1:5173/dev/mock.html
npx evenhub-simulator "http://127.0.0.1:5173/dev/mock.html?scenario=default" --automation-port 9898
npm run test:e2e -- default                  # drives the simulator and checks every flow
```

Scenarios: `default` (every screen and control), `faults` (no active device, rate limiting, dropped connection, 502s, a request that never answers, an expired token racing a rotated refresh token), `logged-out`. Restart the simulator with the matching `?scenario=` before each run.

## Layout

- `src/glasses.ts`: glasses screens, menus and gestures
- `src/spotify.ts`: Spotify Web API client (player, library, errors, rate limits, timeouts)
- `src/auth.ts`: PKCE sign-in, token refresh, sign-in keys
- `src/settings.ts`: phone screen
- `src/text.ts`: makes text safe for the glasses font
- `src/bridge.ts`: Even bridge connection, call queue, storage
